/**
 * Tool source-of-truth watchdog: spec-diff model + telemetry event contract.
 *
 * Every watchdog decision emits exactly one structured event (programmatic-
 * telemetry principle): the CLI prints them as JSONL on stdout, the API
 * scheduler mirrors them to the console log and an append-only events file,
 * and automated tests assert on them deterministically. Event `type` values
 * are the vocabulary of the drift pipeline:
 *
 *   run_started -> source_checked -> source_unchanged            (steady state)
 *                                 -> drift_detected -> subset_unchanged
 *                                                   -> regeneration_started
 *                                                      -> regenerated
 *                                                      -> changelog_written
 *                                                   -> breaking_change_flagged
 *                                                      -> changelog_written
 *                                                   -> manual_review_required
 *   check_failed / regeneration_failed                           (errors)
 *   registry_updated, run_complete                               (bookkeeping)
 */
import { z } from 'zod';
import { SpecSourceTypeSchema } from './tool-source-registry.js';

// ── Spec diff model ──────────────────────────────────────────────────────────

/** One field-level change inside an operation. */
export const SpecFieldChangeSchema = z.object({
  kind: z.enum([
    'param-added',
    'param-removed',
    'param-required-added',
    'param-required-removed',
    'param-type-changed',
    'body-property-added',
    'body-property-removed',
    'body-required-added',
    'body-required-removed',
    'body-type-changed',
    'response-property-added',
    'response-property-removed',
    'response-type-changed',
    'enum-value-added',
    'enum-value-removed',
    'description-changed',
  ]),
  /** Dotted location, e.g. `query.pair`, `body.statement`, `response.data.url`. */
  path: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  breaking: z.boolean(),
});
export type SpecFieldChange = z.infer<typeof SpecFieldChangeSchema>;

export const SpecOperationDiffSchema = z.object({
  operationId: z.string(),
  method: z.string(),
  path: z.string(),
  changes: z.array(SpecFieldChangeSchema),
});
export type SpecOperationDiff = z.infer<typeof SpecOperationDiffSchema>;

export const SpecDiffSchema = z.object({
  /** OpenAPI info.version movement (null side = field absent). */
  infoVersion: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  addedOperations: z.array(
    z.object({ operationId: z.string(), method: z.string(), path: z.string() })
  ),
  removedOperations: z.array(
    z.object({ operationId: z.string(), method: z.string(), path: z.string() })
  ),
  changedOperations: z.array(SpecOperationDiffSchema),
  /** True when any removal/type-change/required-addition is present. */
  breaking: z.boolean(),
  /** Flat list of the breaking findings, for logs and changelog headers. */
  breakingFindings: z.array(z.string()),
});
export type SpecDiff = z.infer<typeof SpecDiffSchema>;

// ── Event contract ───────────────────────────────────────────────────────────

const base = { tool: z.string(), at: z.string() };

export const ToolWatchdogEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_started'),
    at: z.string(),
    data: z.object({
      toolCount: z.number().int(),
      trigger: z.enum(['schedule', 'manual', 'cli']),
    }),
  }),
  z.object({
    type: z.literal('source_checked'),
    ...base,
    data: z.object({
      sourceKey: z.string(),
      url: z.string(),
      specType: SpecSourceTypeSchema,
      /** How the check was answered. */
      mechanism: z.enum(['etag-304', 'last-modified-304', 'body-hash']),
      httpStatus: z.number().int(),
    }),
  }),
  z.object({
    type: z.literal('source_unchanged'),
    ...base,
    data: z.object({ sourceKey: z.string(), sha256: z.string() }),
  }),
  z.object({
    type: z.literal('drift_detected'),
    ...base,
    data: z.object({
      sourceKey: z.string(),
      url: z.string(),
      previousSha256: z.string().nullable(),
      newSha256: z.string(),
      previousSpecVersion: z.string().nullable(),
      newSpecVersion: z.string().nullable(),
    }),
  }),
  z.object({
    type: z.literal('subset_unchanged'),
    ...base,
    data: z.object({
      /** The upstream changed but the tool's trimmed/converted fixture did not. */
      fixture: z.string(),
      newSourceSha256: z.string(),
    }),
  }),
  z.object({
    type: z.literal('regeneration_started'),
    ...base,
    data: z.object({ diff: SpecDiffSchema }),
  }),
  z.object({
    type: z.literal('regenerated'),
    ...base,
    data: z.object({
      changedFiles: z.array(z.string()),
      unchangedFiles: z.array(z.string()),
      elapsedMs: z.number(),
    }),
  }),
  z.object({
    type: z.literal('breaking_change_flagged'),
    ...base,
    data: z.object({
      findings: z.array(z.string()),
      changelog: z.string(),
      /** Generated files were NOT touched; review + watchdog:apply required. */
      held: z.literal(true),
    }),
  }),
  z.object({
    type: z.literal('manual_review_required'),
    ...base,
    data: z.object({
      sourceKey: z.string(),
      url: z.string(),
      reason: z.string(),
    }),
  }),
  z.object({
    type: z.literal('changelog_written'),
    ...base,
    data: z.object({ file: z.string(), breaking: z.boolean() }),
  }),
  z.object({
    type: z.literal('check_failed'),
    ...base,
    data: z.object({
      sourceKey: z.string().nullable(),
      message: z.string(),
    }),
  }),
  z.object({
    type: z.literal('regeneration_failed'),
    ...base,
    data: z.object({ step: z.string(), message: z.string() }),
  }),
  z.object({
    type: z.literal('registry_updated'),
    ...base,
    data: z.object({ fields: z.array(z.string()) }),
  }),
  z.object({
    type: z.literal('run_complete'),
    at: z.string(),
    data: z.object({
      checked: z.number().int(),
      unchanged: z.number().int(),
      drifted: z.number().int(),
      regenerated: z.number().int(),
      flagged: z.number().int(),
      failed: z.number().int(),
      elapsedMs: z.number(),
    }),
  }),
]);
export type ToolWatchdogEvent = z.infer<typeof ToolWatchdogEventSchema>;
