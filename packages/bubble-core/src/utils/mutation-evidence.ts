/**
 * Docs-lie detection evidence — did a doc-said-read operation mutate state?
 *
 * Detection uses only the evidence a real run affords, and is deliberately
 * conservative (a false "mutation" would poison the catalogue):
 *
 * 1. Response markers: an HTTP 201 Created status surfaced in the result, a
 *    Location header paired with a creation status, or an explicit creation
 *    flag (`created: true` / a `createdId` field). Detectable ONLY for
 *    bubbles that surface these fields in their result — many SDK bubbles
 *    strip them, and this detector stays silent for those.
 * 2. A caller-supplied before/after state snapshot (`mutationProbe` on
 *    executionMeta): any difference between the two captures is mutation
 *    evidence. This is the only path for operations whose responses carry no
 *    marker.
 *
 * A bare `id` field is NEVER evidence — read operations return ids
 * constantly. Operations with neither markers nor a probe are honestly
 * undetectable here; their correction channel is the Contract KB's
 * cross-run observation comparison (IR-11/12).
 *
 * Reference design: integration_stitcher `packages/tester/src/gate.ts`
 * (`downgradeLyingRead`, RUNTIME_VERIFIED_CONFIDENCE) — adapted to
 * BubbleLab's `source: 'observed'` provenance name.
 */

import type { OperationSideEffectMetadata } from '@bubblelab/shared-schemas';

/** Confidence assigned to a classification observed directly at runtime. */
export const RUNTIME_VERIFIED_CONFIDENCE = 0.95;

export interface MutationEvidence {
  detected: boolean;
  /** Human-readable description of the observed evidence. */
  evidence?: string;
}

const CREATION_STATUS = 201;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function inspectLevel(record: Record<string, unknown>): string | undefined {
  const status =
    typeof record.statusCode === 'number'
      ? record.statusCode
      : typeof record.status === 'number'
        ? record.status
        : undefined;
  if (status === CREATION_STATUS) {
    const headers = asRecord(record.headers);
    const location = headers?.location ?? headers?.Location;
    return typeof location === 'string'
      ? `HTTP 201 Created with Location header '${location}'`
      : 'HTTP 201 Created status in response';
  }
  if (record.created === true) {
    return "explicit 'created: true' flag in response";
  }
  if (
    typeof record.createdId === 'string' ||
    typeof record.createdId === 'number'
  ) {
    return `newly-created record id '${String(record.createdId)}' in response`;
  }
  return undefined;
}

/**
 * Scan an operation result for creation markers. Checks the top level and the
 * conventional nesting points (`data`, `response`) one level deep.
 */
export function detectMutationEvidence(result: unknown): MutationEvidence {
  const root = asRecord(result);
  if (!root) return { detected: false };

  const levels = [root, asRecord(root.data), asRecord(root.response)].filter(
    (level): level is Record<string, unknown> => level !== undefined
  );
  for (const level of levels) {
    const evidence = inspectLevel(level);
    if (evidence) return { detected: true, evidence };
  }
  return { detected: false };
}

/** Stable structural comparison for before/after state probe captures. */
export function probeCapturesDiffer(before: unknown, after: unknown): boolean {
  return stableStringify(before) !== stableStringify(after);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    const record = asRecord(val);
    if (!record) return val;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = record[key];
        return acc;
      }, {});
  });
}

/**
 * The correction for a lying read: docs said `read`, runtime observed a
 * mutation. `source: 'observed'` is BubbleLab's runtime-verified provenance
 * (operation-metadata-schema.ts) and outranks every doc-derived source;
 * idempotency is reset to false (a mutation was observed — nothing more is
 * known about repeating it).
 */
export function downgradeLyingRead(
  declared: OperationSideEffectMetadata | undefined,
  evidence: string
): OperationSideEffectMetadata {
  return {
    sideEffect: 'read_with_side_effects',
    destructive: declared?.destructive ?? false,
    idempotent: false,
    confidence: RUNTIME_VERIFIED_CONFIDENCE,
    source: 'observed',
    citation: evidence,
  };
}
