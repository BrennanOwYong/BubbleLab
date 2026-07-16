/**
 * OpenAPI subset trimmer (ADD-ANY-APP S1 acquire, large-spec path).
 *
 * Vendors like Stripe ship multi-megabyte specs full of recursive $refs
 * (charge -> refund -> charge). Vendoring 8 MB per app is not sane and the
 * MVP dereferencer treats cycles as a hard error, so this script extracts a
 * committed sub-spec: only the selected operations, bodies whitelisted to
 * the fields we expose, every $ref inlined, recursion and deep nesting
 * collapsed to open maps (-> z.record in the emitted Zod).
 *
 * Deterministic: same source spec + same trim config -> byte-identical
 * fixture. The full source spec is downloaded on demand, never committed.
 *
 * Usage:
 *   bun scripts/trim-openapi.ts --source <full-spec.json|yaml> --trim examples/<app>.trim.json
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

interface TrimOperation {
  /** Path template in the source spec, e.g. `/v1/payment_intents`. */
  path: string;
  method: string;
  /** operationId to WRITE into the trimmed spec (intent-revealing rename). */
  operationId: string;
  /** operationId in the SOURCE spec (defaults to operationId). */
  sourceOperationId?: string;
  /** Request-body property whitelist; omitted -> request body dropped. */
  bodyProps?: string[];
  /** Query-parameter whitelist; omitted -> all query params dropped. */
  queryProps?: string[];
  /**
   * Top-level response property whitelist; omitted -> all properties kept.
   * Used to drop vendor envelope fields that collide with generator-owned
   * result fields (e.g. Kraken's `error: string[]` vs the generated
   * `error: string`).
   */
  responseProps?: string[];
}

interface TrimConfig {
  /** Fixture file to write, relative to the package fixtures/ dir. */
  output: string;
  /** Where the source spec comes from (documentation, not fetched here). */
  sourceUrl: string;
  /** Doc links this trim was validated against (auditability). */
  references?: string[];
  title: string;
  description?: string;
  /**
   * Object-nesting depth kept in response schemas. Objects nested deeper
   * (and object members of unions, which count one level deeper) collapse
   * to open maps. Scalars are never collapsed.
   */
  maxDepth: number;
  /** Truncate every description to this many characters. */
  maxDescriptionLength: number;
  operations: TrimOperation[];
}

type Json = Record<string, unknown>;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceArg = argValue('--source');
const trimArg = argValue('--trim');
if (!sourceArg || !trimArg) {
  console.error(
    'usage: bun scripts/trim-openapi.ts --source <full-spec> --trim <app.trim.json>'
  );
  process.exit(1);
}

const config = JSON.parse(
  readFileSync(resolve(packageRoot, trimArg), 'utf8')
) as TrimConfig;
const source = parseYaml(readFileSync(resolve(sourceArg), 'utf8')) as Json;

/** Resolve a local JSON pointer against the source document. */
function resolvePointer(ref: string): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(`Only local $refs are supported, got: ${ref}`);
  }
  let node: unknown = source;
  for (const segment of ref
    .slice(2)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    node = (node as Json)[segment];
    if (node === undefined) throw new Error(`Unresolvable $ref: ${ref}`);
  }
  return node;
}

function truncate(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return undefined;
  return clean.length > config.maxDescriptionLength
    ? `${clean.slice(0, config.maxDescriptionLength - 1)}…`
    : clean;
}

/** Open-map replacement for a schema collapsed by depth/recursion. */
function collapsed(schema: Json, reason: string): Json {
  const description = truncate(schema.description);
  return {
    type: 'object',
    description: description
      ? `${description} (${reason})`
      : `Vendor object (${reason}); see the vendor API reference for its fields.`,
  };
}

const KEPT_SCALAR_KEYS = [
  'type',
  'format',
  'enum',
  'nullable',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'default',
] as const;

/**
 * Inline + trim one schema node.
 * `depth` counts object nesting from the response root; union object members
 * count one level deeper (Stripe "expandable" fields collapse to id-or-map).
 */
function trimSchema(node: unknown, depth: number, stack: string[]): Json {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`Schema node is not an object: ${JSON.stringify(node)}`);
  }
  const record = node as Json;

  const ref = record.$ref;
  if (typeof ref === 'string') {
    if (stack.includes(ref)) {
      const name = ref.split('/').pop() ?? ref;
      return {
        type: 'object',
        description: `Recursive vendor schema "${name}" truncated; see the vendor API reference.`,
      };
    }
    return trimSchema(resolvePointer(ref), depth, [...stack, ref]);
  }

  const union = record.anyOf ?? record.oneOf;
  if (Array.isArray(union)) {
    const key = record.anyOf ? 'anyOf' : 'oneOf';
    const out: Json = {
      [key]: union.map((member) => trimSchema(member, depth + 1, stack)),
    };
    const description = truncate(record.description);
    if (description) out.description = description;
    return out;
  }
  if (Array.isArray(record.allOf)) {
    const out: Json = {
      allOf: record.allOf.map((member) => trimSchema(member, depth, stack)),
    };
    const description = truncate(record.description);
    if (description) out.description = description;
    return out;
  }

  const out: Json = {};
  for (const key of KEPT_SCALAR_KEYS) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  const description = truncate(record.description);
  if (description) out.description = description;

  if (record.type === 'array' && record.items !== undefined) {
    out.items = trimSchema(record.items, depth, stack);
    return out;
  }

  const properties = record.properties as Record<string, unknown> | undefined;
  if (record.type === 'object' || properties !== undefined) {
    if (properties === undefined || Object.keys(properties).length === 0) {
      // Open map: keep typed additionalProperties when they are scalar.
      const ap = record.additionalProperties;
      if (ap !== null && typeof ap === 'object') {
        out.additionalProperties = trimSchema(ap, depth + 1, stack);
      }
      out.type = 'object';
      return out;
    }
    if (depth >= config.maxDepth) {
      return collapsed(record, 'nested object collapsed at trim depth limit');
    }
    const trimmedProps: Json = {};
    for (const [name, propSchema] of Object.entries(properties)) {
      trimmedProps[name] = trimSchema(propSchema, depth + 1, stack);
    }
    out.type = 'object';
    out.properties = trimmedProps;
    if (Array.isArray(record.required) && record.required.length > 0) {
      out.required = record.required;
    }
    return out;
  }

  return out;
}

interface SourceOperation extends Json {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Json[];
  requestBody?: Json;
  responses?: Record<string, Json>;
}

function trimOperation(selection: TrimOperation): Json {
  const pathItem = (source.paths as Json | undefined)?.[selection.path] as
    | Json
    | undefined;
  const operation = pathItem?.[selection.method] as SourceOperation | undefined;
  if (!operation) {
    throw new Error(`${selection.method} ${selection.path} not in source spec`);
  }
  const wantedId = selection.sourceOperationId ?? selection.operationId;
  if (
    selection.sourceOperationId !== undefined &&
    operation.operationId !== selection.sourceOperationId
  ) {
    throw new Error(
      `${selection.method} ${selection.path}: source operationId is ${operation.operationId}, expected ${wantedId}`
    );
  }

  const out: Json = { operationId: selection.operationId };
  if (operation.summary) out.summary = truncate(operation.summary);
  const description = truncate(operation.description);
  if (description && description !== out.summary) out.description = description;

  // Parameters: path params always survive; query params only when whitelisted.
  const keptParams: Json[] = [];
  const queryWanted = new Set(selection.queryProps ?? []);
  for (const rawParam of operation.parameters ?? []) {
    const param = (
      typeof rawParam.$ref === 'string'
        ? resolvePointer(rawParam.$ref)
        : rawParam
    ) as Json;
    if (param.in === 'path') {
      keptParams.push({
        name: param.name,
        in: 'path',
        required: true,
        ...(truncate(param.description)
          ? { description: truncate(param.description) }
          : {}),
        schema: trimSchema(param.schema ?? { type: 'string' }, 0, []),
      });
    } else if (param.in === 'query' && queryWanted.has(String(param.name))) {
      queryWanted.delete(String(param.name));
      keptParams.push({
        name: param.name,
        in: 'query',
        required: param.required === true,
        ...(truncate(param.description)
          ? { description: truncate(param.description) }
          : {}),
        schema: trimSchema(param.schema ?? { type: 'string' }, 0, []),
      });
    }
  }
  if (queryWanted.size > 0) {
    throw new Error(
      `${wantedId}: query props not found: ${[...queryWanted].join(', ')}`
    );
  }
  if (keptParams.length > 0) out.parameters = keptParams;

  // Request body: whitelist top-level properties, keep the source media type.
  if (selection.bodyProps && selection.bodyProps.length > 0) {
    const content = (operation.requestBody?.content ?? {}) as Record<
      string,
      { schema?: Json }
    >;
    const mediaType = Object.keys(content).find((key) =>
      ['application/json', 'application/x-www-form-urlencoded'].includes(key)
    );
    const schema = mediaType ? content[mediaType].schema : undefined;
    const properties = schema?.properties as Json | undefined;
    if (!mediaType || !schema || !properties) {
      throw new Error(`${wantedId}: no object request body in source spec`);
    }
    const wanted = new Set(selection.bodyProps);
    const trimmedProps: Json = {};
    for (const name of selection.bodyProps) {
      const propSchema = properties[name];
      if (propSchema === undefined) {
        throw new Error(`${wantedId}: body prop not found: ${name}`);
      }
      trimmedProps[name] = trimSchema(propSchema, 1, []);
    }
    const required = (
      Array.isArray(schema.required) ? schema.required : []
    ).filter((name) => wanted.has(String(name)));
    out.requestBody = {
      required: required.length > 0,
      content: {
        [mediaType]: {
          schema: {
            type: 'object',
            properties: trimmedProps,
            ...(required.length > 0 ? { required } : {}),
          },
        },
      },
    };
  }

  // Responses: 2xx application/json only, schemas fully inlined + trimmed.
  const responses: Json = {};
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    const code = Number(status);
    if (!(code >= 200 && code <= 299)) continue;
    const media = (response.content as Json | undefined)?.[
      'application/json'
    ] as { schema?: Json } | undefined;
    if (!media?.schema) continue;
    const schema = trimSchema(media.schema, 0, []);
    if (selection.responseProps) {
      const properties = (schema.properties ?? {}) as Json;
      const kept: Json = {};
      for (const name of selection.responseProps) {
        if (properties[name] === undefined) {
          throw new Error(`${wantedId}: response prop not found: ${name}`);
        }
        kept[name] = properties[name];
      }
      schema.properties = kept;
      if (Array.isArray(schema.required)) {
        const wanted = new Set(selection.responseProps);
        const required = schema.required.filter((name) =>
          wanted.has(String(name))
        );
        if (required.length > 0) schema.required = required;
        else delete schema.required;
      }
    }
    responses[status] = {
      description: truncate(response.description) ?? 'Successful response.',
      content: {
        'application/json': { schema },
      },
    };
  }
  if (Object.keys(responses).length === 0) {
    throw new Error(`${wantedId}: no 2xx application/json response`);
  }
  out.responses = responses;
  return out;
}

const paths: Json = {};
for (const selection of config.operations) {
  const pathEntry = (paths[selection.path] ?? {}) as Json;
  pathEntry[selection.method] = trimOperation(selection);
  paths[selection.path] = pathEntry;
  console.log(
    `trimmed ${selection.method.toUpperCase()} ${selection.path} -> ${selection.operationId}`
  );
}

const info = (source.info ?? {}) as Json;
const trimmed: Json = {
  openapi: '3.0.0',
  info: {
    title: config.title,
    version: String(info.version ?? '0.0.0'),
    description:
      (config.description ? `${config.description} ` : '') +
      `Trimmed subset of ${config.sourceUrl} (source version ${String(info.version ?? 'unknown')}); regenerate with scripts/trim-openapi.ts.`,
  },
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  },
  paths,
};

const outPath = resolve(packageRoot, 'fixtures', config.output);
writeFileSync(outPath, stringifyYaml(trimmed, { lineWidth: 0 }));

// Format with the repo prettier so re-trimming is a no-op diff against
// committed (pre-commit-hook-formatted) fixtures — idempotent regeneration.
const prettierBin = resolve(packageRoot, '../../node_modules/.bin/prettier');
if (existsSync(prettierBin)) {
  execFileSync(prettierBin, ['--write', outPath], { stdio: 'ignore' });
  console.log('formatted fixture with repo prettier');
} else {
  console.warn('repo prettier not found; fixture left unformatted');
}
console.log(`wrote ${outPath}`);
