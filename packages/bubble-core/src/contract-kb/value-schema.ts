/**
 * Serializable structural schema model for the Contract KB (IR-11/12).
 *
 * A contract version must survive a JSON round-trip (the KB is stored in the
 * database as a document), so contracts are stored as `ValueSchema` — a
 * structural shape inferred from real observed values — and compiled to a
 * Zod validator on demand. Zod itself is not serializable; this model is the
 * durable form, `valueSchemaToZod` the executable form.
 *
 * Inference is shape-level on purpose: two responses with different field
 * VALUES but the same field structure infer the same schema, so consistency
 * across observations (the anti-poison gate) is a fingerprint equality
 * check, never a heuristic. Fully programmatic — no LLM anywhere.
 *
 * Design adapted from the clean-room reference implementation
 * (integration_stitcher, packages/kb/src/schema.ts) per
 * docs/plan/REPO-MAP.md §3 "Contract KB (IR-11/12)".
 */
import { z, type ZodTypeAny } from 'zod';

export interface ValueObjectField {
  schema: ValueSchema;
  optional: boolean;
}

export type ValueSchema =
  | { kind: 'unknown' }
  | { kind: 'null' }
  | { kind: 'boolean' }
  | { kind: 'number' }
  | { kind: 'string' }
  | { kind: 'array'; items: ValueSchema }
  | { kind: 'object'; fields: Record<string, ValueObjectField> }
  | { kind: 'union'; variants: ValueSchema[] };

/** The loose starting point: accepts anything; the first thing real traffic converges away from. */
export const LOOSE_VALUE_SCHEMA: ValueSchema = { kind: 'unknown' };

/** Infer the structural schema of one observed value. */
export function inferValueSchema(value: unknown): ValueSchema {
  if (value === null) return { kind: 'null' };
  switch (typeof value) {
    case 'boolean':
      return { kind: 'boolean' };
    case 'number':
      return { kind: 'number' };
    case 'string':
      return { kind: 'string' };
    case 'object':
      break;
    default:
      // undefined / function / symbol / bigint — nothing structural to claim.
      return { kind: 'unknown' };
  }
  if (Array.isArray(value)) {
    let items: ValueSchema = { kind: 'unknown' };
    for (const element of value) {
      items = mergeValueSchemas(items, inferValueSchema(element));
    }
    return { kind: 'array', items };
  }
  const fields: Record<string, ValueObjectField> = {};
  for (const [key, fieldValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (fieldValue === undefined) continue;
    fields[key] = { schema: inferValueSchema(fieldValue), optional: false };
  }
  return { kind: 'object', fields };
}

/**
 * Merge two schemas inferred WITHIN one observation (e.g. elements of one
 * array): shared object fields merge recursively, one-sided fields become
 * optional, kind conflicts become a union. Cross-observation clustering does
 * NOT use this — there, consistency is exact fingerprint equality, so an
 * anomaly can never blur into the majority shape.
 */
export function mergeValueSchemas(a: ValueSchema, b: ValueSchema): ValueSchema {
  if (a.kind === 'unknown') return b;
  if (b.kind === 'unknown') return a;
  if (fingerprintValueSchema(a) === fingerprintValueSchema(b)) return a;
  if (a.kind === 'object' && b.kind === 'object') {
    const fields: Record<string, ValueObjectField> = {};
    const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
    for (const key of keys) {
      const left = a.fields[key];
      const right = b.fields[key];
      if (left !== undefined && right !== undefined) {
        fields[key] = {
          schema: mergeValueSchemas(left.schema, right.schema),
          optional: left.optional || right.optional,
        };
      } else {
        const present = left ?? right;
        if (present === undefined) continue;
        fields[key] = { schema: present.schema, optional: true };
      }
    }
    return { kind: 'object', fields };
  }
  if (a.kind === 'array' && b.kind === 'array') {
    return { kind: 'array', items: mergeValueSchemas(a.items, b.items) };
  }
  const variants: ValueSchema[] = [];
  for (const candidate of [...flattenUnion(a), ...flattenUnion(b)]) {
    if (
      !variants.some(
        (existing) =>
          fingerprintValueSchema(existing) === fingerprintValueSchema(candidate)
      )
    ) {
      variants.push(candidate);
    }
  }
  const sole = variants[0];
  if (variants.length === 1 && sole !== undefined) return sole;
  return { kind: 'union', variants };
}

function flattenUnion(schema: ValueSchema): ValueSchema[] {
  return schema.kind === 'union' ? schema.variants : [schema];
}

/**
 * Canonical fingerprint: JSON with recursively sorted object keys. Two
 * observations are "consistent" (anti-poison) iff their inferred schemas
 * fingerprint identically.
 */
export function fingerprintValueSchema(schema: ValueSchema): string {
  return canonicalJson(schema);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Compile a stored schema to its executable Zod validator — how the KB
 * becomes a validation source of truth. Objects are strict: a field
 * upstream ADDED is a deviation finding, exactly like a field removed.
 */
export function valueSchemaToZod(schema: ValueSchema): ZodTypeAny {
  switch (schema.kind) {
    case 'unknown':
      return z.unknown();
    case 'null':
      return z.null();
    case 'boolean':
      return z.boolean();
    case 'number':
      return z.number();
    case 'string':
      return z.string();
    case 'array':
      return z.array(valueSchemaToZod(schema.items));
    case 'object': {
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, field] of Object.entries(schema.fields)) {
        const compiled = valueSchemaToZod(field.schema);
        shape[key] = field.optional ? compiled.optional() : compiled;
      }
      return z.object(shape).strict();
    }
    case 'union': {
      const [first, second, ...rest] = schema.variants.map((variant) =>
        valueSchemaToZod(variant)
      );
      if (first === undefined) return z.unknown();
      if (second === undefined) return first;
      return z.union([first, second, ...rest]);
    }
  }
}

export type ValueSchemaChangeKind =
  | 'added'
  | 'removed'
  | 'changed'
  | 'optionality';

/** One structural difference between two contract versions. */
export interface ValueSchemaChange {
  /** Dotted path; `[]` descends into array items; empty string is the root. */
  path: string;
  change: ValueSchemaChangeKind;
  before: string | null;
  after: string | null;
}

/** Structural diff between two contract versions — what changed, where, from what to what. */
export function diffValueSchemas(
  before: ValueSchema,
  after: ValueSchema
): ValueSchemaChange[] {
  const changes: ValueSchemaChange[] = [];
  walkDiff(before, after, '', changes);
  return changes;
}

function walkDiff(
  before: ValueSchema,
  after: ValueSchema,
  path: string,
  out: ValueSchemaChange[]
): void {
  if (before.kind !== after.kind) {
    out.push({ path, change: 'changed', before: before.kind, after: after.kind });
    return;
  }
  if (before.kind === 'object' && after.kind === 'object') {
    const keys = new Set([
      ...Object.keys(before.fields),
      ...Object.keys(after.fields),
    ]);
    for (const key of keys) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const left = before.fields[key];
      const right = after.fields[key];
      if (left === undefined && right !== undefined) {
        out.push({
          path: childPath,
          change: 'added',
          before: null,
          after: right.schema.kind,
        });
      } else if (left !== undefined && right === undefined) {
        out.push({
          path: childPath,
          change: 'removed',
          before: left.schema.kind,
          after: null,
        });
      } else if (left !== undefined && right !== undefined) {
        if (left.optional !== right.optional) {
          out.push({
            path: childPath,
            change: 'optionality',
            before: left.optional ? 'optional' : 'required',
            after: right.optional ? 'optional' : 'required',
          });
        }
        walkDiff(left.schema, right.schema, childPath, out);
      }
    }
    return;
  }
  if (before.kind === 'array' && after.kind === 'array') {
    walkDiff(before.items, after.items, path === '' ? '[]' : `${path}[]`, out);
    return;
  }
  if (fingerprintValueSchema(before) !== fingerprintValueSchema(after)) {
    out.push({ path, change: 'changed', before: before.kind, after: after.kind });
  }
}
