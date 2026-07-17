/**
 * Durable shape of one per-integration Contract KB document (IR-11/12).
 *
 * Everything survives a JSON round-trip by construction (null-style fields,
 * no `undefined`), and every load is re-validated with Zod so a corrupt or
 * hand-edited store fails loudly instead of poisoning the KB.
 *
 * Design adapted from the clean-room reference implementation
 * (integration_stitcher, packages/kb/src/document.ts). The browser/DOM
 * contract channel of the reference is intentionally NOT ported — browser
 * integrations are KIV (HANDOFF §7) and unproven work is not grafted.
 */
import { z } from 'zod';
import type { ValueSchema } from './value-schema.js';

/** JSON-safe value — the only thing the KB persists as an observation sample. */
export type KbJsonValue =
  | string
  | number
  | boolean
  | null
  | KbJsonValue[]
  | { [key: string]: KbJsonValue };

export type ContractChannelName = 'input' | 'output';

/**
 * Where a contract version came from. `declared` includes the auto-seeded
 * loose contract; `observed` versions are promoted by consistent real
 * traffic; `manual` is a human assertion.
 */
export type ContractVersionSource = 'declared' | 'observed' | 'manual';

/**
 * One IMMUTABLE contract version. Version numbers only grow; rollback
 * re-points the active version, never rewrites history.
 */
export interface ContractVersion {
  version: number;
  schema: ValueSchema;
  source: ContractVersionSource;
  /** Observations that promoted it, plus confirmations since. 0 for declared/manual. */
  evidence: number;
  createdAt: string;
  /** Set when the version was rolled away from; a rolled-back version is never re-promoted in place. */
  rolledBackAt: string | null;
}

/** Candidate contract accumulating consistent observations toward the promotion gate. */
export interface PendingContractCluster {
  fingerprint: string;
  schema: ValueSchema;
  count: number;
  /** Last observed raw value with this shape, for diagnosis. */
  sample: KbJsonValue;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ContractChannel {
  activeVersion: number;
  versions: ContractVersion[];
  pending: PendingContractCluster[];
  /**
   * The most recent GROUNDED sample seen on this channel (confirmed or
   * pending). This is what `getRecordedMock()` serves in test mode: recorded
   * reality instead of schema-derived fiction.
   */
  latestSample: KbJsonValue | null;
  latestSampleAt: string | null;
}

/** Everything the KB knows about one call site (node) of the integration. */
export interface NodeContractRecord {
  /** BubbleLab's per-call-site identity, or the `operation:<op>` fallback. */
  key: string;
  operation: string;
  channels: {
    input: ContractChannel | null;
    output: ContractChannel | null;
  };
  observationCount: number;
  lastObservedAt: string | null;
}

export interface IntegrationKbDocument {
  /** The integration (bubbleName) this document belongs to. */
  integration: string;
  nodes: Record<string, NodeContractRecord>;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Zod validation of loaded documents (typed against the interfaces above).
// ---------------------------------------------------------------------------

const valueSchemaZ: z.ZodType<ValueSchema> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('unknown') }),
    z.object({ kind: z.literal('null') }),
    z.object({ kind: z.literal('boolean') }),
    z.object({ kind: z.literal('number') }),
    z.object({ kind: z.literal('string') }),
    z.object({ kind: z.literal('array'), items: valueSchemaZ }),
    z.object({
      kind: z.literal('object'),
      fields: z.record(
        z.object({ schema: valueSchemaZ, optional: z.boolean() })
      ),
    }),
    z.object({ kind: z.literal('union'), variants: z.array(valueSchemaZ) }),
  ])
);

const kbJsonValueZ: z.ZodType<KbJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(kbJsonValueZ),
    z.record(kbJsonValueZ),
  ])
);

const contractVersionSourceZ = z.enum(['declared', 'observed', 'manual']);

const contractVersionZ: z.ZodType<ContractVersion> = z.object({
  version: z.number().int().positive(),
  schema: valueSchemaZ,
  source: contractVersionSourceZ,
  evidence: z.number().int().nonnegative(),
  createdAt: z.string(),
  rolledBackAt: z.string().nullable(),
});

const pendingClusterZ: z.ZodType<PendingContractCluster> = z.object({
  fingerprint: z.string(),
  schema: valueSchemaZ,
  count: z.number().int().positive(),
  sample: kbJsonValueZ,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

const contractChannelZ: z.ZodType<ContractChannel> = z.object({
  activeVersion: z.number().int().positive(),
  versions: z.array(contractVersionZ),
  pending: z.array(pendingClusterZ),
  latestSample: kbJsonValueZ.nullable(),
  latestSampleAt: z.string().nullable(),
});

const nodeRecordZ: z.ZodType<NodeContractRecord> = z.object({
  key: z.string(),
  operation: z.string(),
  channels: z.object({
    input: contractChannelZ.nullable(),
    output: contractChannelZ.nullable(),
  }),
  observationCount: z.number().int().nonnegative(),
  lastObservedAt: z.string().nullable(),
});

export const integrationKbDocumentSchema: z.ZodType<IntegrationKbDocument> =
  z.object({
    integration: z.string().min(1),
    nodes: z.record(nodeRecordZ),
    updatedAt: z.string(),
  });

/** Coerce an observed value into its JSON-safe persisted form (non-serializable parts → null). */
export function toKbJsonValue(value: unknown): KbJsonValue {
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  return JSON.parse(text) as KbJsonValue;
}
