/**
 * AWS Smithy JSON model -> OpenAPI 3 subset converter (deterministic).
 *
 * The Redshift Data API ships as a Smithy 2.0 model with the awsJson1_1
 * protocol: every operation is `POST /` with the operation selected by the
 * `X-Amz-Target: RedshiftData.<Operation>` header and
 * `Content-Type: application/x-amz-json-1.1`. That shape does not fit an
 * OpenAPI paths map directly, so this converter uses the same convention as
 * AWS's own smithy-to-openapi tooling: each operation gets the synthetic path
 * `/#X-Amz-Target=<Service>.<Operation>`. URL fragments are never sent on the
 * wire (the runtime request still hits `/`), while the paths stay distinct
 * for extraction. The actual X-Amz-Target header is stamped per operation via
 * the appgen config's `operationHeaders`, and the fixed Content-Type via
 * `authHeaders`.
 *
 * KNOWN RUNTIME GAP (documented, not hidden): the Redshift Data API
 * authenticates with AWS Signature Version 4 request signing, not bearer
 * tokens. The generated raw-fetch bubble stamps `Authorization: Bearer`, so
 * its schemas/types/classification are fully usable but live calls will be
 * rejected by AWS until the pipeline grows a SigV4 signing strategy.
 *
 * Conversion rules:
 * - structure -> object (member `smithy.api#required` trait -> required[])
 * - list -> array, map -> object+additionalProperties
 * - union -> object with every member optional (awsJson1_1 serializes a union
 *   as an object with exactly one member set; noted in the description)
 * - string enum trait / enum shape -> enum values
 * - timestamp -> number (awsJson1_1 encodes timestamps as epoch seconds)
 * - blob -> base64 string; length/range traits -> min/max bounds
 * - documentation traits are HTML; tags are stripped for `.describe()` prose
 * - shape re-entry (cycles) cut into open objects (none in the selected ops)
 *
 * Determinism: same model input -> byte-identical output (operation order is
 * the OPERATIONS list, members keep model order).
 *
 * Usage: bun scripts/smithy-to-openapi.ts
 * Reads  fixtures/redshift-data.smithy.json (vendored from the URL below)
 * Writes fixtures/redshift-data.openapi.json
 *
 * References (verified 2026-07-17):
 * - Smithy model (authoritative machine source, AWS SDK codegen input):
 *   https://raw.githubusercontent.com/aws/aws-sdk-js-v3/main/codegen/sdk-codegen/aws-models/redshift-data.json
 * - Redshift Data API reference:
 *   https://docs.aws.amazon.com/redshift-data/latest/APIReference/Welcome.html
 * - awsJson1_1 protocol (X-Amz-Target + content type):
 *   https://smithy.io/2.0/aws/protocols/aws-json-1_1-protocol.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_PATH = resolve(packageRoot, 'fixtures/redshift-data.smithy.json');
const OUT_PATH = resolve(packageRoot, 'fixtures/redshift-data.openapi.json');

const OPERATIONS = [
  'ExecuteStatement',
  'DescribeStatement',
  'GetStatementResult',
] as const;

interface SmithyMember {
  target: string;
  traits?: Record<string, unknown>;
}

interface SmithyShape {
  type: string;
  members?: Record<string, SmithyMember>;
  member?: SmithyMember;
  key?: SmithyMember;
  value?: SmithyMember;
  input?: { target: string };
  output?: { target: string };
  traits?: Record<string, unknown>;
}

const model = JSON.parse(readFileSync(MODEL_PATH, 'utf8')) as {
  shapes: Record<string, SmithyShape>;
};

const serviceEntry = Object.entries(model.shapes).find(
  ([, shape]) => shape.type === 'service'
);
if (!serviceEntry) throw new Error('no service shape in model');
const [serviceId, serviceShape] = serviceEntry;
const namespace = serviceId.split('#')[0];
const serviceName = serviceId.split('#')[1];
if (!serviceShape.traits?.['aws.protocols#awsJson1_1']) {
  throw new Error(
    'model is not awsJson1_1; the X-Amz-Target path convention does not apply'
  );
}

/** Strip the HTML markup Smithy documentation traits carry. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function docOf(
  traits: Record<string, unknown> | undefined
): string | undefined {
  const doc = traits?.['smithy.api#documentation'];
  return typeof doc === 'string' ? stripHtml(doc) : undefined;
}

type JsonRecord = Record<string, unknown>;

/** Convert a shape reference to inlined OpenAPI 3.0, cutting re-entry. */
function convertTarget(
  target: string,
  stack: string[],
  memberTraits?: Record<string, unknown>
): JsonRecord {
  const memberDoc = docOf(memberTraits);
  const withDoc = (schema: JsonRecord): JsonRecord => {
    if (memberDoc && schema.description === undefined) {
      return { ...schema, description: memberDoc };
    }
    return schema;
  };

  // Prelude (smithy.api) targets.
  if (target.startsWith('smithy.api#')) {
    const prelude = target.slice('smithy.api#'.length);
    switch (prelude) {
      case 'String':
        return withDoc({ type: 'string' });
      case 'Boolean':
      case 'PrimitiveBoolean':
        return withDoc({ type: 'boolean' });
      case 'Integer':
      case 'Long':
      case 'Short':
      case 'Byte':
      case 'PrimitiveInteger':
      case 'PrimitiveLong':
        return withDoc({ type: 'integer' });
      case 'Float':
      case 'Double':
        return withDoc({ type: 'number' });
      case 'Timestamp':
        return withDoc({
          type: 'number',
          description:
            memberDoc !== undefined
              ? `${memberDoc} (awsJson1_1 timestamp: epoch seconds)`
              : 'awsJson1_1 timestamp: epoch seconds',
        });
      case 'Blob':
        return withDoc({
          type: 'string',
          description:
            memberDoc !== undefined
              ? `${memberDoc} (base64-encoded binary)`
              : 'base64-encoded binary',
        });
      case 'Document':
        return withDoc({});
      default:
        throw new Error(`Unhandled prelude target: ${target}`);
    }
  }

  if (stack.includes(target)) {
    return {
      type: 'object',
      description: `Recursive ${target.split('#')[1]} value (recursion cut for the generated contract; validated as an open object).`,
    };
  }
  const shape = model.shapes[target];
  if (!shape) throw new Error(`Unresolvable target: ${target}`);
  const nextStack = [...stack, target];
  const traits = shape.traits ?? {};
  const shapeDoc = memberDoc ?? docOf(traits);
  const out: JsonRecord = {};

  switch (shape.type) {
    case 'string': {
      out.type = 'string';
      const enumTrait = traits['smithy.api#enum'] as
        | Array<{ value: string }>
        | undefined;
      if (enumTrait) out.enum = enumTrait.map((entry) => entry.value);
      const length = traits['smithy.api#length'] as
        | { min?: number; max?: number }
        | undefined;
      if (length?.min !== undefined) out.minLength = length.min;
      if (length?.max !== undefined) out.maxLength = length.max;
      break;
    }
    case 'enum': {
      out.type = 'string';
      out.enum = Object.entries(shape.members ?? {}).map(
        ([name, member]) =>
          (member.traits?.['smithy.api#enumValue'] as string | undefined) ??
          name
      );
      break;
    }
    case 'boolean':
      out.type = 'boolean';
      break;
    case 'integer':
    case 'long':
    case 'short':
    case 'byte': {
      out.type = 'integer';
      const range = traits['smithy.api#range'] as
        | { min?: number; max?: number }
        | undefined;
      if (range?.min !== undefined) out.minimum = range.min;
      if (range?.max !== undefined) out.maximum = range.max;
      break;
    }
    case 'float':
    case 'double':
      out.type = 'number';
      break;
    case 'timestamp':
      out.type = 'number';
      out.description = 'awsJson1_1 timestamp: epoch seconds';
      break;
    case 'blob':
      out.type = 'string';
      out.description = 'base64-encoded binary';
      break;
    case 'list': {
      out.type = 'array';
      if (!shape.member) throw new Error(`list without member: ${target}`);
      out.items = convertTarget(
        shape.member.target,
        nextStack,
        shape.member.traits
      );
      break;
    }
    case 'map': {
      out.type = 'object';
      if (!shape.value) throw new Error(`map without value: ${target}`);
      out.additionalProperties = convertTarget(
        shape.value.target,
        nextStack,
        shape.value.traits
      );
      break;
    }
    case 'structure': {
      out.type = 'object';
      const properties: JsonRecord = {};
      const required: string[] = [];
      for (const [name, member] of Object.entries(shape.members ?? {})) {
        properties[name] = convertTarget(
          member.target,
          nextStack,
          member.traits
        );
        if (member.traits?.['smithy.api#required'] !== undefined) {
          required.push(name);
        }
      }
      out.properties = properties;
      if (required.length > 0) out.required = required;
      break;
    }
    case 'union': {
      // awsJson1_1 serializes a union as an object with exactly one member
      // set; every member is optional in the converted contract.
      out.type = 'object';
      const properties: JsonRecord = {};
      for (const [name, member] of Object.entries(shape.members ?? {})) {
        properties[name] = convertTarget(
          member.target,
          nextStack,
          member.traits
        );
      }
      out.properties = properties;
      out.description = `Tagged union: exactly one member is set.${shapeDoc ? ` ${shapeDoc}` : ''}`;
      return out;
    }
    default:
      throw new Error(`Unhandled shape type ${shape.type} for ${target}`);
  }

  if (shapeDoc && out.description === undefined) out.description = shapeDoc;
  return out;
}

const paths: JsonRecord = {};
for (const opName of OPERATIONS) {
  const opShape = model.shapes[`${namespace}#${opName}`];
  if (!opShape || opShape.type !== 'operation') {
    throw new Error(`operation not found in model: ${opName}`);
  }
  if (!opShape.input || !opShape.output) {
    throw new Error(`${opName}: operation without input/output`);
  }
  const description = docOf(opShape.traits) ?? '';
  const summary = description.split(/(?<=\.)\s/)[0];
  paths[`/#X-Amz-Target=${serviceName}.${opName}`] = {
    post: {
      operationId: opName,
      ...(summary ? { summary } : {}),
      ...(description ? { description } : {}),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: convertTarget(opShape.input.target, []),
          },
        },
      },
      responses: {
        '200': {
          description: 'Successful response.',
          content: {
            'application/json': {
              schema: convertTarget(opShape.output.target, []),
            },
          },
        },
      },
    },
  };
}

const title =
  (serviceShape.traits?.['smithy.api#title'] as string | undefined) ??
  serviceName;
const openapi = {
  openapi: '3.0.3',
  info: {
    title,
    version: '2019-12-20',
    description:
      `OpenAPI 3 subset converted deterministically from the AWS Smithy ` +
      `model by scripts/smithy-to-openapi.ts. Covers only the operations ` +
      `selected for generation. Protocol awsJson1_1: every request is ` +
      `POST / with X-Amz-Target and Content-Type application/x-amz-json-1.1 ` +
      `(the /#X-Amz-Target=... paths are never sent on the wire). ` +
      `Authentication is AWS SigV4 request signing. Source: ` +
      `https://raw.githubusercontent.com/aws/aws-sdk-js-v3/main/codegen/sdk-codegen/aws-models/redshift-data.json`,
  },
  externalDocs: {
    url: 'https://docs.aws.amazon.com/redshift-data/latest/APIReference/Welcome.html',
  },
  servers: [{ url: 'https://redshift-data.us-east-1.amazonaws.com' }],
  paths,
};

writeFileSync(OUT_PATH, JSON.stringify(openapi, null, 2) + '\n');
console.log(`wrote ${OUT_PATH} (${OPERATIONS.length} operations)`);
