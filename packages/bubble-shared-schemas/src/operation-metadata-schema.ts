import { z } from 'zod';

/**
 * Doc-grounded side-effect metadata for bubble operations (IR-8).
 *
 * Bubbles are multi-operation (discriminated union on `operation`), so this metadata is declared
 * PER OPERATION, never per bubble. Each classification is a claim that must carry its source.
 *
 * Binding rule: an operation is `write` iff its documentation says it CREATES A NEW RECORD —
 * even as a side effect. `read_with_side_effects` covers operations whose docs indicate mutation
 * without record creation (mark-as-read, update, delete — the separate `destructive` flag carries
 * the delete/irreversible signal). `read` means the docs indicate no mutation at all.
 * The HTTP method is NEVER the classification signal: a POST that only searches is `read`,
 * a GET that creates an export job is `write`.
 *
 * References:
 * - MCP ToolAnnotations (readOnlyHint default false, destructiveHint default true,
 *   idempotentHint default false):
 *   https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations
 */

export const SIDE_EFFECT_VALUES = [
  'read',
  'write',
  'read_with_side_effects',
] as const;

export const SideEffectSchema = z
  .enum(SIDE_EFFECT_VALUES)
  .describe(
    "Whether the operation mutates external state: 'read' (no mutation), 'write' (creates a new record, even as a side effect), 'read_with_side_effects' (mutates without creating a record, e.g. mark-as-read, update, delete)"
  );

export type SideEffect = z.infer<typeof SideEffectSchema>;

/** Provenance of a classification, most → least authoritative. `observed` (runtime-verified) outranks all doc-derived sources. */
export const SIDE_EFFECT_SOURCES = [
  'observed',
  'mcp',
  'openapi',
  'prose',
  'manual',
] as const;

export const SideEffectSourceSchema = z
  .enum(SIDE_EFFECT_SOURCES)
  .describe(
    "Where the classification came from: 'observed' (runtime-verified behavior), 'mcp' (MCP tool annotations), 'openapi' (vendor OpenAPI spec prose), 'prose' (vendor doc prose / operation documentation), 'manual' (human assertion)"
  );

export type SideEffectSource = z.infer<typeof SideEffectSourceSchema>;

export const OperationSideEffectMetadataSchema = z.object({
  sideEffect: SideEffectSchema,
  destructive: z
    .boolean()
    .describe(
      'Whether the operation deletes or irreversibly alters existing data'
    ),
  idempotent: z
    .boolean()
    .describe('Whether repeating the operation converges to the same state'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Classifier confidence in this classification, 0..1'),
  source: SideEffectSourceSchema,
  citation: z
    .string()
    .min(
      1,
      'Citation is mandatory — every classification must carry its source'
    )
    .describe(
      'Doc URL, spec path, or quoted doc snippet grounding the classification'
    ),
  requiredScopes: z
    .array(z.string())
    .optional()
    .describe(
      "OAuth/API scopes the operation requires, when the vendor documents them (consumed by the scope audit, IR-6/7). Each entry is one requirement; ALL entries must be satisfied. Within an entry, '|' separates ALTERNATIVES — the requirement is satisfied by any one of them (vendors like Google document per-method accepted-scope sets: e.g. 'scopeA|scopeB' means scopeA or scopeB suffices). Entries mirror the vendor's method reference exactly; the citation carries the source page."
    ),
  unverified: z
    .boolean()
    .optional()
    .describe(
      'True when no doc signal was found and the fail-safe write default was emitted; a human or runtime observation must verify it'
    ),
});

export type OperationSideEffectMetadata = z.infer<
  typeof OperationSideEffectMetadataSchema
>;

/** Per-operation map a bubble class declares as its static `operationMetadata`. Keys are the `operation` discriminator literals. */
export const BubbleOperationMetadataSchema = z.record(
  z.string(),
  OperationSideEffectMetadataSchema
);

export type BubbleOperationMetadata = z.infer<
  typeof BubbleOperationMetadataSchema
>;
