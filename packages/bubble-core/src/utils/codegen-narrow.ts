/**
 * Cast-free narrowing helpers for generated BubbleFlows.
 *
 * Generated flows import these from '@bubblelab/bubble-core' instead of
 * redefining them inline (codegen rules 12 and 13 in
 * apps/bubblelab-api/src/config/bubbleflow-generation-prompts.ts teach the
 * import). The semantics mirror the previously-inlined private helper methods
 * exactly: take `unknown`, return a typed value, never cast. Keep signatures
 * stable - every generated flow in the wild links against them.
 */

import type { ZodType } from 'zod';

/**
 * Reads one named field from an untyped value, or undefined when absent.
 * Object.getOwnPropertyDescriptor behind a typeof-object guard handles
 * variable keys where `key in v` narrowing cannot; the descriptor's `any`
 * value is swallowed by the `unknown` return type without a cast keyword.
 */
export function getField(v: unknown, key: string): unknown {
  return typeof v === 'object' && v !== null
    ? Object.getOwnPropertyDescriptor(v, key)?.value
    : undefined;
}

/** Returns v when it is an array, otherwise an empty array. */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Returns v when it is a string, otherwise the fallback (default ''). */
export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Returns v when it is a number, otherwise undefined. */
export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Returns v when it is a boolean, otherwise undefined. */
export function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * JSON-parses a raw string (e.g. an ai-agent bubble's result.data.response)
 * and validates it with the given Zod schema. Returns the fully typed,
 * runtime-validated object, or undefined when raw is not a string, not valid
 * JSON, or does not match the schema. The one sanctioned path from AI text to
 * typed data - zero casts.
 */
export function safeParseJson<T>(
  raw: unknown,
  schema: ZodType<T>
): T | undefined {
  if (typeof raw !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}
