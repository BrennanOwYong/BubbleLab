import { z } from 'zod';
import { OperationSideEffectMetadataSchema } from './operation-metadata-schema.js';

/**
 * Run-time grounding types: the drift signal, the docs-lie correction channel,
 * and the write sign-off gate (Phase-2 of the two-phase execution model).
 *
 * Phase 1 (authoring/stitching) runs on declared contracts and mocks only —
 * zero real API calls, zero credentials. Phase 2 (the first real run or an
 * explicit TEST run) is where reality is observed: contract violations become
 * DRIFT signals, and documentation lies (a doc-said-read operation observed
 * mutating state) become persisted side-effect corrections.
 *
 * References:
 * - docs/plan/HANDOFF.md §9 (drift code must survive the wrapper boundary and
 *   have a consumer — the reference build lost it to a generic failure).
 * - docs/plan/REPO-MAP.md §4b (sign-off gate: server-side, authoritative).
 */

// ── Drift (contract violation on a REAL run) ────────────────────────────────

/**
 * The drift error code. Carried on `BubbleDriftError.code` and on
 * `ExecutionResult.errorCode`; every boundary that handles errors checks this
 * CODE (never class identity alone), so the signal survives wrapper
 * boundaries, temp-file module boundaries, and serialization.
 */
export const DRIFT_ERROR_CODE = 'OUTPUT_MISMATCH' as const;

export const ContractDeviationSchema = z.object({
  path: z
    .string()
    .describe('Dotted path into the value; empty string for the root'),
  message: z.string().describe('The schema violation at this path'),
});

export type ContractDeviation = z.infer<typeof ContractDeviationSchema>;

export const ContractDriftEventSchema = z.object({
  code: z.literal(DRIFT_ERROR_CODE),
  bubbleName: z.string(),
  operation: z.string().optional(),
  callSiteKey: z
    .string()
    .optional()
    .describe(
      'Call-site identity (invocationCallSiteKey or dependency-graph unique id)'
    ),
  variableId: z.number().optional(),
  deviations: z
    .array(ContractDeviationSchema)
    .describe('Every detected mismatch between declared contract and reality'),
  observedAt: z.string().describe('ISO timestamp'),
});

export type ContractDriftEvent = z.infer<typeof ContractDriftEventSchema>;

/**
 * Consumer seam for drift. Wired through executionMeta so the signal reaches
 * its consumer even when flow code catches the thrown error.
 */
export type ContractDriftObserver = (event: ContractDriftEvent) => void;

// ── Docs-lie correction (runtime-verified side-effect reclassification) ─────

/**
 * A persisted side-effect override: runtime observation outranking the
 * documentation-derived classification. `metadata.source` is 'observed'
 * (BubbleLab's name for runtime-verified provenance — see
 * operation-metadata-schema.ts source enum).
 */
export const SideEffectOverrideSchema = z.object({
  bubbleName: z.string(),
  operation: z.string(),
  metadata: OperationSideEffectMetadataSchema,
  evidence: z
    .string()
    .describe('The observed evidence that triggered the correction'),
  observedAt: z.string().describe('ISO timestamp of the observation'),
});

export type SideEffectOverride = z.infer<typeof SideEffectOverrideSchema>;

export const SideEffectCorrectionEventSchema = z.object({
  override: SideEffectOverrideSchema,
  previous: OperationSideEffectMetadataSchema.optional().describe(
    'The doc-derived classification the observation contradicted'
  ),
});

export type SideEffectCorrectionEvent = z.infer<
  typeof SideEffectCorrectionEventSchema
>;

export type SideEffectCorrectionObserver = (
  event: SideEffectCorrectionEvent
) => void;

/**
 * Optional caller-supplied state probe for docs-lie detection: a side-effect
 * free snapshot of the state a read-hinted operation could touch. Captured
 * before and after the real execution; a difference is mutation evidence.
 * This is the only detection path for operations whose responses carry no
 * creation marker (no 201/Location/created id) — response-marker detection
 * covers the rest.
 */
export type MutationStateProbe = () => Promise<unknown> | unknown;

// ── Write sign-off gate ──────────────────────────────────────────────────────

/** ExecutionResult.errorCode when a run is blocked awaiting write sign-off. */
export const WRITE_SIGNOFF_REQUIRED_ERROR_CODE =
  'WRITE_SIGNOFF_REQUIRED' as const;

/**
 * One write-hinted call site awaiting (or covered by) sign-off. `callSiteKey`
 * is the primary identity; `aliasKeys` carries every identity the call site is
 * known by at runtime (invocationCallSiteKey, dependency-graph unique id,
 * String(variableId)) so approval matching never depends on which one the
 * runtime context happens to expose.
 */
export const WriteSetEntrySchema = z.object({
  callSiteKey: z.string(),
  aliasKeys: z.array(z.string()),
  variableId: z.number(),
  bubbleName: z.string(),
  operation: z
    .string()
    .optional()
    .describe('Absent when the bubble has no operation discriminator'),
  sideEffect: z.enum(['write', 'read_with_side_effects']),
  classification: OperationSideEffectMetadataSchema.optional().describe(
    'The doc-grounded (or runtime-corrected) classification, when one exists'
  ),
  reason: z
    .string()
    .describe(
      'Why this call site is in the write set (classified write, fail-safe default, unresolvable operation, ...)'
    ),
});

export type WriteSetEntry = z.infer<typeof WriteSetEntrySchema>;

/** The persisted sign-off: who approved which write call sites, for which code. */
export const WriteSignOffRecordSchema = z.object({
  approvedCallSiteKeys: z.array(z.string()),
  signedOffBy: z.string(),
  signedOffAt: z.string().describe('ISO timestamp'),
  codeHash: z
    .string()
    .describe(
      'Hash of the flow code the sign-off was granted for; a code change invalidates the sign-off'
    ),
});

export type WriteSignOffRecord = z.infer<typeof WriteSignOffRecordSchema>;
