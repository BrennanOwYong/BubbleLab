/**
 * Tool source-of-truth registry (spec-drift watchdog, layer 1 of 2).
 *
 * Every generated tool (bubble-appgen output) records WHERE its machine
 * source of truth lives (the vendor's OpenAPI/Discovery/Smithy document),
 * what the watchdog last saw there (etag / content hash / spec version),
 * and the fingerprints of the files generated from it. The watchdog
 * (packages/bubble-appgen/src/watchdog + apps/bubblelab-api scheduler)
 * polls each source, detects drift, and re-runs the deterministic
 * generation pipeline recorded here.
 *
 * Complements the Contract KB (contract-observation.ts): the KB observes
 * drift in RUNTIME RESPONSES (what the API actually returned), this
 * registry observes drift in the DECLARED CONTRACT (what the vendor says
 * the API is). Both signals identify the same failure class — a generated
 * tool silently diverging from vendor reality.
 *
 * ## References (change-detection mechanisms, verified 2026-07-17)
 * - HTTP conditional requests, If-None-Match / ETag:
 *   https://www.rfc-editor.org/rfc/rfc9110#name-if-none-match
 *   https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag
 * - If-Modified-Since / Last-Modified:
 *   https://www.rfc-editor.org/rfc/rfc9110#name-if-modified-since
 * - OpenAPI info.version (spec-embedded version field):
 *   https://spec.openapis.org/oas/v3.0.3#info-object
 * - Google Discovery `revision` field (BigQuery has NO response ETag and
 *   rejects HEAD with 404 — poll with GET and hash the body):
 *   https://developers.google.com/discovery/v1/reference/apis
 */
import { z } from 'zod';

/** Machine format of the upstream source document. */
export const SpecSourceTypeSchema = z.enum([
  /** OpenAPI 3.x document consumed directly (or via the subset trimmer). */
  'openapi',
  /** Google API Discovery document -> discovery-to-openapi converter. */
  'google-discovery',
  /** AWS Smithy JSON model -> smithy-to-openapi converter. */
  'aws-smithy',
  /**
   * No machine spec exists; the vendored fixture is hand-transcribed from
   * the listed reference sources. The watchdog can only detect that the
   * references changed and flag for human review — never auto-regenerate.
   */
  'hand-transcribed',
]);
export type SpecSourceType = z.infer<typeof SpecSourceTypeSchema>;

/**
 * What the watchdog last observed at one source URL. Every field is a
 * change-detection mechanism, cheapest first: `etag`/`lastModified` enable
 * HTTP 304 short-circuits (no body transfer), `sha256` catches servers with
 * unstable or missing validators, `specVersion` is the vendor's own
 * declared version (OpenAPI info.version / Discovery revision).
 */
export const SourceSnapshotSchema = z.object({
  /** Entity tag exactly as the server sent it (may be weak: W/"..."). */
  etag: z.string().nullable(),
  /** Last-Modified header exactly as the server sent it. */
  lastModified: z.string().nullable(),
  /** Hex sha256 of the response body. */
  sha256: z.string(),
  /** Body size in bytes when fetched. */
  bytes: z.number().int().nonnegative(),
  /** Vendor-declared version inside the document, when one exists. */
  specVersion: z.string().nullable(),
  /** ISO timestamp of the fetch that produced this snapshot. */
  fetchedAt: z.string(),
});
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;

/** One upstream URL the tool's contract is derived from. */
export const ToolSourceSchema = z.object({
  /** Stable key for this source within the tool (e.g. 'spec', 'models'). */
  key: z.string().min(1),
  /** The authoritative URL (https:// for real sources; file:// in tests). */
  url: z.string().min(1),
  /**
   * Conditional-request mechanisms this server honors, from live probes.
   * Drives which If-* headers the watchdog sends. An empty array means
   * "always GET the body and hash it" (e.g. Google Discovery).
   */
  conditional: z.array(z.enum(['etag', 'last-modified'])),
  /** Last observed state; null until the source is first fetched. */
  snapshot: SourceSnapshotSchema.nullable(),
});
export type ToolSource = z.infer<typeof ToolSourceSchema>;

/**
 * The deterministic regeneration pipeline, expressed as the package.json
 * script names of @bubblelab/bubble-appgen. The watchdog re-runs these
 * exact scripts — the same ones a human runs — so watchdog output can
 * never diverge from a manual regeneration.
 */
export const ToolPipelineSchema = z.object({
  /**
   * Vendored raw fixture the converter reads (relative to the bubble-appgen
   * package root); the watchdog overwrites it with the fetched body before
   * converting. Null when the source is consumed from a temp download
   * (trimmed large specs) or when there is nothing to fetch (manual tools).
   */
  rawTarget: z.string().nullable(),
  /**
   * Run the repo prettier over rawTarget after writing it, so a re-fetch of
   * an unchanged upstream is a byte-identical file (the converters and the
   * pre-commit hook both format their outputs).
   */
  prettierRawTarget: z.boolean(),
  /**
   * `bun <argv>` that converts/trims the raw source into the OpenAPI
   * fixture, relative to the bubble-appgen package root; null when the
   * source IS the fixture (e.g. Snowflake). The placeholder
   * `{download:<sourceKey>}` is replaced with the temp path of that
   * source's fetched body (the trimmer's --source input).
   */
  convert: z.array(z.string()).nullable(),
  /** The OpenAPI fixture the generator consumes, relative to package root. */
  fixture: z.string(),
  /** `bun <argv>` that runs the generator over the fixture. */
  generate: z.array(z.string()),
  /** Generator config, relative to package root (for changelog context). */
  config: z.string(),
});
export type ToolPipeline = z.infer<typeof ToolPipelineSchema>;

/** Breaking-change review state, set instead of auto-applying. */
export const PendingReviewSchema = z.object({
  detectedAt: z.string(),
  /** sha256 of the new upstream body that triggered the flag. */
  sourceSha256: z.string(),
  /** Human-readable one-line summary of the breaking findings. */
  summary: z.string(),
  /** Changelog file (relative to bubble-appgen root) with the full diff. */
  changelog: z.string(),
});
export type PendingReview = z.infer<typeof PendingReviewSchema>;

export const RegisteredToolSourceSchema = z.object({
  /** appgen appName == generated folder name in bubble-core service-bubble. */
  name: z.string().min(1),
  specType: SpecSourceTypeSchema,
  /**
   * 'auto': drift regenerates the tool (breaking changes still held).
   * 'manual': drift only flags for review (hand-transcribed sources).
   */
  monitoring: z.enum(['auto', 'manual']),
  sources: z.array(ToolSourceSchema).min(1),
  pipeline: ToolPipelineSchema,
  /**
   * sha256 per generated file (relative to the tool's outDir). Lets the
   * watchdog prove which files a regeneration changed, and detect manual
   * edits to generated files before overwriting them.
   */
  generatedFiles: z.record(z.string(), z.string()),
  /** Generated output folder, relative to the monorepo root. */
  outDir: z.string(),
  /** Human docs for the changelog header. */
  docsUrl: z.string(),
  /** Deep links this registration was validated against. */
  references: z.array(z.string()),
  /** Set when a breaking change is awaiting human review. */
  pendingReview: PendingReviewSchema.nullable(),
});
export type RegisteredToolSource = z.infer<typeof RegisteredToolSourceSchema>;

export const ToolSourceRegistrySchema = z.object({
  registryVersion: z.literal(1),
  tools: z.array(RegisteredToolSourceSchema),
});
export type ToolSourceRegistry = z.infer<typeof ToolSourceRegistrySchema>;
