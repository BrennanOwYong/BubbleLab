/**
 * JSON Schema -> Zod SOURCE-CODE projection (ADD-ANY-APP S3).
 *
 * Deterministic: the same schema always emits the same Zod expression string.
 * Every leaf carries `.describe()` from the spec's own prose, because
 * `.describe()` is what the codegen LLM and get-bubble-details-tool read.
 *
 * Coverage is the OpenAPI 3.0 subset the MVP needs; anything unhandled throws
 * rather than guessing (a wrong schema is worse than a loud gap).
 */
import type { JsonSchema } from './types.js';

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Emit an object key, quoting when it is not a valid identifier. */
export function emitKey(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

function describeSuffix(schema: JsonSchema): string {
  const text = schema.description?.trim().replace(/\s+/g, ' ');
  return text ? `.describe(${JSON.stringify(text)})` : '';
}

/** True when the schema is an object with no declared properties (open map). */
function isOpenObject(schema: JsonSchema): boolean {
  return (
    schema.type === 'object' &&
    (schema.properties === undefined ||
      Object.keys(schema.properties).length === 0)
  );
}

/**
 * Emit the Zod expression for one JSON Schema node.
 * `optional` is applied by the CALLER (object emission), not here.
 */
export function zodFor(schema: JsonSchema): string {
  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf ?? schema.anyOf)!;
    if (variants.length === 1) return zodFor(variants[0]);
    const parts = variants.map((v) => zodFor(v));
    return `z.union([${parts.join(', ')}])${describeSuffix(schema)}`;
  }
  if (schema.allOf) {
    // MVP: merge allOf object members into one object schema.
    const merged: JsonSchema = { type: 'object', properties: {}, required: [] };
    for (const member of schema.allOf) {
      Object.assign(merged.properties!, member.properties ?? {});
      merged.required = [...merged.required!, ...(member.required ?? [])];
    }
    if (schema.description) merged.description = schema.description;
    return zodFor(merged);
  }

  let expr: string;
  switch (schema.type) {
    case 'string': {
      if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        const values = schema.enum.map((v) => JSON.stringify(String(v)));
        expr = `z.enum([${values.join(', ')}])`;
        break;
      }
      expr = 'z.string()';
      if (schema.format === 'uuid') expr += '.uuid()';
      // NOTE: format 'uri' is NOT mapped to .url() — vendors return relative
      // URIs (e.g. Snowflake statementStatusUrl) that z.string().url() rejects.
      if (typeof schema.minLength === 'number' && schema.minLength > 0) {
        expr += `.min(${schema.minLength})`;
      }
      if (typeof schema.maxLength === 'number') {
        expr += `.max(${schema.maxLength})`;
      }
      break;
    }
    case 'integer':
    case 'number': {
      expr = 'z.number()';
      if (schema.type === 'integer') expr += '.int()';
      if (typeof schema.minimum === 'number') expr += `.min(${schema.minimum})`;
      if (typeof schema.maximum === 'number') expr += `.max(${schema.maximum})`;
      break;
    }
    case 'boolean': {
      expr = 'z.boolean()';
      break;
    }
    case 'array': {
      const items = schema.items ? zodFor(schema.items) : 'z.unknown()';
      expr = `z.array(${items})`;
      break;
    }
    case 'object': {
      if (isOpenObject(schema)) {
        // JSON Schema semantics: an object with no declared properties is an
        // open map, not an empty object.
        expr =
          typeof schema.additionalProperties === 'object'
            ? `z.record(z.string(), ${zodFor(schema.additionalProperties)})`
            : 'z.record(z.string(), z.unknown())';
        break;
      }
      expr = emitObject(schema);
      break;
    }
    case undefined: {
      // No type: treat declared properties as an object, otherwise unknown.
      if (schema.properties) {
        expr = emitObject(schema);
      } else {
        expr = 'z.unknown()';
      }
      break;
    }
    default:
      throw new Error(
        `Unhandled JSON Schema type: ${JSON.stringify(schema.type)}`
      );
  }

  if (schema.nullable === true) expr += '.nullable()';
  return expr + describeSuffix(schema);
}

/** Emit `z.object({...})` with per-property required/optional handling. */
function emitObject(schema: JsonSchema): string {
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(schema.properties ?? {}).map(
    ([name, propSchema]) => {
      let expr = zodFor(propSchema);
      if (!required.has(name)) expr += '.optional()';
      return `${emitKey(name)}: ${expr}`;
    }
  );
  return `z.object({ ${entries.join(', ')} })`;
}

/**
 * Emit an all-optional payload object (result-schema branches: presence
 * varies by status code, so every field is optional).
 */
export function zodForOptionalObject(
  properties: Record<string, JsonSchema>
): string {
  const entries = Object.entries(properties).map(([name, propSchema]) => {
    return `${emitKey(name)}: ${zodFor(propSchema)}.optional()`;
  });
  return `z.object({ ${entries.join(', ')} })`;
}

/** Synthesize a valid value for a schema (constructor defaults, probes). */
export function exampleFor(schema: JsonSchema): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case 'string':
      if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum[0];
      }
      if (schema.format === 'uuid') {
        return '00000000-0000-0000-0000-000000000000';
      }
      return 'example';
    case 'integer':
    case 'number':
      return schema.minimum ?? 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
    default:
      return {};
  }
}
