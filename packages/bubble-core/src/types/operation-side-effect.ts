/**
 * Minimal side-effect metadata interface consumed by the test-mode switch in
 * BaseBubble.action().
 *
 * INTEGRATION POINT (IR-8): the full doc-grounded metadata lands as
 * `OperationSideEffectMetadata` / `BubbleOperationMetadata` in
 * `@bubblelab/shared-schemas` (operation-metadata-schema.ts) with provenance
 * fields (confidence, source, citation, requiredScopes, destructive, idempotent).
 * That richer record is structurally assignable to `OperationSideEffectHint`,
 * so a bubble's static `operationMetadata` declared with IR-8 types satisfies
 * this interface without changes here. The test-mode gate only reads
 * `sideEffect`.
 */

export const OPERATION_SIDE_EFFECTS = [
  'read',
  'write',
  'read_with_side_effects',
] as const;

export type OperationSideEffect = (typeof OPERATION_SIDE_EFFECTS)[number];

/** The single field the test-mode gate needs per operation. */
export interface OperationSideEffectHint {
  sideEffect: OperationSideEffect;
}

/**
 * Per-operation map a bubble class declares as its static `operationMetadata`.
 * Keys are the `operation` discriminator literals of the params schema.
 * Bubbles without an `operation` param may declare the single key `'*'`.
 * Operations absent from the map resolve to `'write'` (fail-safe default).
 */
export type OperationSideEffectMap = Record<string, OperationSideEffectHint>;
