/**
 * Operation extraction: OpenAPI paths -> OperationDraft[] (ADD-ANY-APP S2).
 *
 * composeInput flattening: path + query params + JSON body properties become
 * ONE params object per operation, each field keeping its wire binding.
 * Collisions between locations are a hard error, never silently renamed.
 *
 * Header parameters never become operation params: standard negotiation
 * headers (Accept, User-Agent, Content-Type, Accept-Encoding) and any header
 * whose name contains "authorization" are request-builder concerns, stamped
 * from the per-app config (S5), not caller inputs.
 */
import type {
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
} from './openapi.js';
import type { JsonSchema, OperationDraft, WireField } from './types.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const MANAGED_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'content-type',
  'user-agent',
]);

function isManagedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return MANAGED_HEADERS.has(lower) || lower.includes('authorization');
}

/** PascalCase or camelCase operationId -> snake_case discriminator literal. */
export function toSnakeCase(operationId: string): string {
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

/** JSON-pointer-escape a path template for citations. */
function pointerEscape(path: string): string {
  return path.replace(/~/g, '~0').replace(/\//g, '~1');
}

function mergeParameters(
  pathLevel: OpenApiParameter[] | undefined,
  opLevel: OpenApiParameter[] | undefined
): OpenApiParameter[] {
  const merged = new Map<string, OpenApiParameter>();
  for (const param of pathLevel ?? []) {
    merged.set(`${param.in}:${param.name}`, param);
  }
  for (const param of opLevel ?? []) {
    merged.set(`${param.in}:${param.name}`, param); // op-level wins
  }
  return [...merged.values()];
}

function extractFields(
  operationId: string,
  parameters: OpenApiParameter[],
  operation: OpenApiOperation
): { fields: WireField[]; requestExample?: Record<string, unknown> } {
  const fields: WireField[] = [];
  const seen = new Set<string>();
  const add = (field: WireField): void => {
    if (seen.has(field.name)) {
      throw new Error(
        `${operationId}: input field collision on "${field.name}" — composeInput requires distinct names across path/query/body`
      );
    }
    seen.add(field.name);
    fields.push(field);
  };

  for (const param of parameters) {
    if (param.in === 'header') {
      if (!isManagedHeader(param.name)) {
        throw new Error(
          `${operationId}: header parameter "${param.name}" is not in the managed-header set; extend the request-builder policy before generating`
        );
      }
      continue;
    }
    if (param.in === 'cookie') {
      throw new Error(`${operationId}: cookie parameters are unsupported`);
    }
    const schema: JsonSchema = { ...(param.schema ?? {}) };
    if (param.description && !schema.description) {
      schema.description = param.description;
    }
    add({
      name: param.name,
      location: param.in,
      required: param.required === true,
      schema,
    });
  }

  let requestExample: Record<string, unknown> | undefined;
  const body = operation.requestBody;
  if (body) {
    const json = body.content?.['application/json'];
    if (!json?.schema) {
      throw new Error(
        `${operationId}: requestBody without application/json schema is unsupported`
      );
    }
    if (json.schema.type !== 'object' || !json.schema.properties) {
      throw new Error(
        `${operationId}: only object request bodies are flattened by the MVP generator`
      );
    }
    const bodyRequired = new Set(json.schema.required ?? []);
    for (const [name, propSchema] of Object.entries(json.schema.properties)) {
      add({
        name,
        location: 'body',
        required: body.required === true && bodyRequired.has(name),
        schema: propSchema,
      });
    }
    const example = json.example ?? json.schema.example;
    if (example && typeof example === 'object' && !Array.isArray(example)) {
      requestExample = example as Record<string, unknown>;
    }
  }

  return { fields, requestExample };
}

/** Structural fingerprint of a schema, ignoring prose (example/description). */
function shapeKey(schema: JsonSchema): string {
  return JSON.stringify(schema, (key, value: unknown) =>
    key === 'example' || key === 'description' ? undefined : value
  );
}

function extractResponses(
  operationId: string,
  operation: OpenApiOperation
): {
  responseProperties: Record<string, JsonSchema>;
  responseSources: string[];
  responseExamples: Record<string, unknown>;
} {
  const responseProperties: Record<string, JsonSchema> = {};
  const responseSources: string[] = [];
  const responseExamples: Record<string, unknown> = {};

  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    const code = Number(status);
    if (!(code >= 200 && code <= 299)) continue;
    const json = response.content?.['application/json'];
    if (!json?.schema) continue;
    responseSources.push(status);
    const example = json.example ?? json.schema.example;
    if (example !== undefined) responseExamples[status] = example;
    if (json.schema.type !== 'object' || !json.schema.properties) {
      throw new Error(
        `${operationId}: non-object 2xx response schema is unsupported by the MVP generator`
      );
    }
    for (const [name, propSchema] of Object.entries(json.schema.properties)) {
      const existing = responseProperties[name];
      if (existing === undefined) {
        responseProperties[name] = propSchema;
      } else if (shapeKey(existing) !== shapeKey(propSchema)) {
        // First occurrence wins; identical shapes are the common case
        // (shared envelope fields across 200/202). Divergence is loud.
        console.warn(
          `  [warn] ${operationId}: response field "${name}" differs between 2xx statuses; keeping the first shape`
        );
      }
    }
  }

  if (responseSources.length === 0) {
    throw new Error(`${operationId}: no documented 2xx JSON response`);
  }
  return { responseProperties, responseSources, responseExamples };
}

/** Extract the selected operationIds from the spec into OperationDrafts. */
export function extractOperations(
  doc: OpenApiDocument,
  operationIds: string[],
  specName: string
): OperationDraft[] {
  const wanted = new Set(operationIds);
  const drafts: OperationDraft[] = [];

  for (const [pathTemplate, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation: OpenApiOperation | undefined = (
        pathItem as OpenApiPathItem
      )[method];
      if (!operation?.operationId || !wanted.has(operation.operationId)) {
        continue;
      }
      wanted.delete(operation.operationId);
      const parameters = mergeParameters(
        (pathItem as OpenApiPathItem).parameters,
        operation.parameters
      );
      const { fields, requestExample } = extractFields(
        operation.operationId,
        parameters,
        operation
      );
      const { responseProperties, responseSources, responseExamples } =
        extractResponses(operation.operationId, operation);
      const security = operation.security ?? doc.security ?? [];
      drafts.push({
        name: toSnakeCase(operation.operationId),
        operationId: operation.operationId,
        method: method.toUpperCase(),
        pathTemplate,
        summary: operation.summary,
        description: operation.description,
        citation: `${specName}#/paths/${pointerEscape(pathTemplate)}/${method}`,
        fields,
        responseProperties,
        responseSources,
        requestExample,
        responseExamples,
        securitySchemes: security.flatMap((entry) => Object.keys(entry)),
      });
    }
  }

  if (wanted.size > 0) {
    throw new Error(
      `operationIds not found in spec: ${[...wanted].join(', ')}`
    );
  }
  // Deterministic output order: the order requested in the config.
  drafts.sort(
    (a, b) =>
      operationIds.indexOf(a.operationId) - operationIds.indexOf(b.operationId)
  );
  return drafts;
}
