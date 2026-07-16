/**
 * Google API Discovery document -> OpenAPI 3 subset converter (deterministic).
 *
 * The Discovery format is NOT OpenAPI, so the appgen pipeline cannot ingest it
 * directly. This script converts ONLY the selected methods into the OpenAPI
 * 3.0 subset the generator handles, fully inlined (no $refs) so the pipeline's
 * local-$ref/no-cycle constraints never trip:
 *
 * - `$ref: "Name"` is inlined from the Discovery `schemas` map; when a schema
 *   re-enters itself (QueryParameterType, QueryParameterValue, RangeValue,
 *   TableFieldSchema are self-recursive) the recursion point is cut into an
 *   open object (`type: object`, no properties -> z.record in zod-emit).
 * - Discovery `type: "any"` becomes an untyped schema (z.unknown()).
 * - Discovery marks required body fields in prose only ("Required." prefix on
 *   the property description — Google's documented convention); the converter
 *   derives the OpenAPI `required` array from that prefix.
 * - Discovery `default` values are strings even for booleans/integers, so
 *   defaults are dropped rather than emitted with the wrong type.
 * - `{+param}` reserved-expansion path templates normalize to `{param}`.
 *
 * Determinism: same Discovery input -> byte-identical OpenAPI output (method
 * order is the METHODS table, path params follow the doc's `parameterOrder`,
 * query params sort alphabetically, schema properties keep doc order).
 *
 * Usage: bun scripts/discovery-to-openapi.ts
 * Reads  fixtures/bigquery-v2.discovery.json (vendored from the URL below)
 * Writes fixtures/bigquery-v2.openapi.json
 *
 * References (verified 2026-07-17):
 * - Discovery doc (authoritative machine source, revision recorded in output):
 *   https://bigquery.googleapis.com/discovery/v1/apis/bigquery/v2/rest
 * - Discovery format: https://developers.google.com/discovery/v1/reference/apis
 * - BigQuery REST reference: https://cloud.google.com/bigquery/docs/reference/rest
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISCOVERY_PATH = resolve(
  packageRoot,
  'fixtures/bigquery-v2.discovery.json'
);
const OUT_PATH = resolve(packageRoot, 'fixtures/bigquery-v2.openapi.json');

/** Discovery method id -> OpenAPI operationId (generation selection order). */
const METHODS: Array<[string, string]> = [
  ['bigquery.jobs.query', 'JobsQuery'],
  ['bigquery.jobs.getQueryResults', 'JobsGetQueryResults'],
  ['bigquery.tabledata.insertAll', 'TabledataInsertAll'],
  ['bigquery.datasets.list', 'DatasetsList'],
  ['bigquery.tables.list', 'TablesList'],
];

interface DiscoverySchema {
  id?: string;
  type?: string;
  format?: string;
  description?: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, DiscoverySchema>;
  items?: DiscoverySchema;
  additionalProperties?: DiscoverySchema;
  $ref?: string;
  [key: string]: unknown;
}

interface DiscoveryMethod {
  id: string;
  path: string;
  httpMethod: string;
  description?: string;
  parameters?: Record<string, DiscoverySchema & { location?: string }>;
  parameterOrder?: string[];
  request?: { $ref: string };
  response?: { $ref: string };
}

interface DiscoveryDoc {
  title?: string;
  version?: string;
  revision?: string;
  baseUrl?: string;
  documentationLink?: string;
  schemas: Record<string, DiscoverySchema>;
  resources: Record<
    string,
    { methods?: Record<string, DiscoveryMethod> } & Record<string, unknown>
  >;
}

const doc = JSON.parse(readFileSync(DISCOVERY_PATH, 'utf8')) as DiscoveryDoc;

function findMethod(methodId: string): DiscoveryMethod {
  // methodId shape: <api>.<resource>[.<subresource>...].<method>
  const segments = methodId.split('.').slice(1);
  const methodName = segments.pop();
  let node: DiscoveryDoc['resources'][string] | undefined;
  let resources = doc.resources;
  for (const segment of segments) {
    node = resources[segment];
    if (!node) throw new Error(`resource not found for ${methodId}`);
    resources = (node['resources'] ?? {}) as DiscoveryDoc['resources'];
  }
  const method = node?.methods?.[methodName ?? ''];
  if (!method) throw new Error(`method not found: ${methodId}`);
  return method;
}

/** Google's documented convention: required fields start with "Required.". */
function isRequiredByProse(schema: DiscoverySchema): boolean {
  return (schema.description ?? '').trimStart().startsWith('Required.');
}

type JsonRecord = Record<string, unknown>;

/**
 * Convert one Discovery schema node to inlined OpenAPI 3.0, cutting $ref
 * cycles into open objects.
 */
function convertSchema(
  node: DiscoverySchema,
  stack: string[],
  extraDescription?: string
): JsonRecord {
  const ref = node.$ref;
  if (typeof ref === 'string') {
    if (stack.includes(ref)) {
      return {
        type: 'object',
        description: `Recursive ${ref} value (recursion cut for the generated contract; validated as an open object).`,
      };
    }
    const target = doc.schemas[ref];
    if (!target) throw new Error(`Unresolvable Discovery $ref: ${ref}`);
    return convertSchema(
      target,
      [...stack, ref],
      node.description ?? extraDescription
    );
  }

  const out: JsonRecord = {};
  const description = extraDescription ?? node.description;

  switch (node.type) {
    case 'any':
      // No type constraint: zod-emit projects this to z.unknown().
      break;
    case 'object': {
      out.type = 'object';
      if (node.properties) {
        const properties: JsonRecord = {};
        const required: string[] = [];
        for (const [name, prop] of Object.entries(node.properties)) {
          properties[name] = convertSchema(prop, stack);
          if (isRequiredByProse(prop)) required.push(name);
        }
        out.properties = properties;
        if (required.length > 0) out.required = required;
      }
      if (node.additionalProperties) {
        out.additionalProperties = convertSchema(
          node.additionalProperties,
          stack
        );
      }
      break;
    }
    case 'array': {
      out.type = 'array';
      out.items = node.items ? convertSchema(node.items, stack) : {};
      break;
    }
    case 'string': {
      out.type = 'string';
      // int64/uint64/byte/date-time ride as JSON strings; keep the format as
      // documentation (zod-emit only special-cases 'uuid', which Discovery
      // never emits).
      if (node.format) out.format = node.format;
      if (Array.isArray(node.enum) && node.enum.length > 0)
        out.enum = node.enum;
      break;
    }
    case 'integer':
      out.type = 'integer';
      break;
    case 'number':
      out.type = 'number';
      break;
    case 'boolean':
      out.type = 'boolean';
      break;
    case undefined:
      break;
    default:
      throw new Error(`Unhandled Discovery type: ${String(node.type)}`);
  }

  if (description) out.description = description;
  return out;
}

function convertParameter(
  name: string,
  param: DiscoverySchema & { location?: string }
): JsonRecord {
  if (param.location !== 'path' && param.location !== 'query') {
    throw new Error(
      `parameter ${name}: unsupported location ${param.location}`
    );
  }
  return {
    name,
    in: param.location,
    required: param.required === true || param.location === 'path',
    ...(param.description ? { description: param.description } : {}),
    schema: convertSchema({ ...param, description: undefined }, []),
  };
}

/**
 * Method descriptions append an "# IAM Permissions" boilerplate whose
 * permission NAMES (`bigquery.jobs.create`, `bigquery.tables.get`) are verb
 * soup that misleads the downstream side-effect classifier (create/get are
 * permission identifiers, not behavior claims). Strip the section; behavior
 * prose is everything before it.
 */
function behaviorProse(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const prose = description.split(/\s*#\s*IAM Permissions/)[0].trim();
  return prose.length > 0 ? prose : undefined;
}

const paths: JsonRecord = {};
for (const [methodId, operationId] of METHODS) {
  const method = findMethod(methodId);
  // `{+param}` (RFC 6570 reserved expansion) -> plain `{param}`.
  const path = '/' + method.path.replace(/\{\+/g, '{');

  const params = method.parameters ?? {};
  const pathOrder = (method.parameterOrder ?? []).filter(
    (name) => params[name]?.location === 'path'
  );
  const queryNames = Object.keys(params)
    .filter((name) => params[name].location === 'query')
    .sort();
  const parameters = [...pathOrder, ...queryNames].map((name) =>
    convertParameter(name, params[name])
  );

  const description = behaviorProse(method.description);
  const operation: JsonRecord = {
    operationId,
    ...(description ? { description } : {}),
    ...(description ? { summary: description.split(/(?<=\.)\s/)[0] } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
  };
  if (method.request) {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': { schema: convertSchema(method.request, []) },
      },
    };
  }
  if (!method.response) throw new Error(`${methodId}: no response schema`);
  operation.responses = {
    '200': {
      description: 'Successful response.',
      content: {
        'application/json': { schema: convertSchema(method.response, []) },
      },
    },
  };

  const pathItem = (paths[path] ?? {}) as JsonRecord;
  pathItem[method.httpMethod.toLowerCase()] = operation;
  paths[path] = pathItem;
}

const openapi = {
  openapi: '3.0.3',
  info: {
    title: doc.title ?? 'BigQuery API',
    version: doc.version ?? 'v2',
    description:
      `OpenAPI 3 subset converted deterministically from the Google API ` +
      `Discovery document (revision ${doc.revision ?? 'unknown'}) by ` +
      `scripts/discovery-to-openapi.ts. Covers only the operations selected ` +
      `for generation. Source: https://bigquery.googleapis.com/discovery/v1/apis/bigquery/v2/rest`,
  },
  externalDocs: {
    url: doc.documentationLink ?? 'https://cloud.google.com/bigquery/docs',
  },
  servers: [{ url: (doc.baseUrl ?? '').replace(/\/$/, '') }],
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'OAuth 2.0 access token with a BigQuery scope (https://www.googleapis.com/auth/bigquery).',
      },
    },
  },
};

writeFileSync(OUT_PATH, JSON.stringify(openapi, null, 2) + '\n');
console.log(
  `wrote ${OUT_PATH} (${METHODS.length} operations, discovery revision ${doc.revision})`
);
