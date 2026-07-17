/**
 * OpenAPI 3.0 loading + local $ref resolution (ADD-ANY-APP S1/S2 front half).
 * Deterministic: YAML in, fully-dereferenced document out. No network.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { JsonSchema } from './types.js';

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, { schema?: JsonSchema; example?: unknown }>;
  };
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: JsonSchema; example?: unknown }>;
    }
  >;
  security?: Array<Record<string, unknown[]>>;
}

export interface OpenApiPathItem {
  parameters?: OpenApiParameter[];
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
}

export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; description?: string; version?: string };
  servers?: Array<{ url?: string; description?: string }>;
  paths?: Record<string, OpenApiPathItem>;
  components?: Record<string, Record<string, unknown>>;
  security?: Array<Record<string, unknown[]>>;
  externalDocs?: { url?: string };
}

/** Resolve a local JSON pointer (`#/components/...`) against the document root. */
function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(
      `Only local $refs are supported by the MVP generator, got: ${ref}`
    );
  }
  const segments = ref
    .slice(2)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node: unknown = root;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') {
      throw new Error(`Unresolvable $ref: ${ref} (at segment "${segment}")`);
    }
    node = (node as Record<string, unknown>)[segment];
    if (node === undefined) {
      throw new Error(`Unresolvable $ref: ${ref} (missing "${segment}")`);
    }
  }
  return node;
}

/**
 * Recursively inline every local $ref. Cycles are a hard error (honest MVP
 * limitation; recursive vendor schemas need named-schema emission).
 */
function deref(root: unknown, node: unknown, stack: string[]): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => deref(root, item, stack));
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const record = node as Record<string, unknown>;
  const ref = record['$ref'];
  if (typeof ref === 'string') {
    if (stack.includes(ref)) {
      throw new Error(
        `Cyclic $ref not supported: ${[...stack, ref].join(' -> ')}`
      );
    }
    const target = resolvePointer(root, ref);
    return deref(root, target, [...stack, ref]);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = deref(root, value, stack);
  }
  return out;
}

/** Load an OpenAPI YAML file and inline all local $refs. */
export function loadOpenApi(specPath: string): OpenApiDocument {
  return parseOpenApiText(readFileSync(specPath, 'utf8'), specPath);
}

/**
 * Parse OpenAPI YAML/JSON text and inline all local $refs. Same pipeline as
 * loadOpenApi with an in-memory source (uploaded spec, fetched URL body);
 * `label` names the source in parse errors.
 */
export function parseOpenApiText(raw: string, label: string): OpenApiDocument {
  const doc = parseYaml(raw) as unknown;
  if (doc === null || typeof doc !== 'object') {
    throw new Error(`Spec did not parse to an object: ${label}`);
  }
  return deref(doc, doc, []) as OpenApiDocument;
}
