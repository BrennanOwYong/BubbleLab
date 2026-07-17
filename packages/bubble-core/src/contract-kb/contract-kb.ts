/**
 * The self-healing per-integration Contract Knowledge Base (IR-11/12).
 *
 * The loop:
 *   1. A run (production or test) produces `ContractObservation`s, emitted
 *      from BaseBubble.action() and keyed by BubbleLab's EXISTING
 *      per-call-site identity (invocationCallSiteKey / currentUniqueId — the
 *      identity the credential and logging systems already use).
 *   2. `ingest` infers the structural schema of the GROUNDED observation.
 *      Mocked observations are REFUSED: a mock is derived from the declared
 *      contract and would only teach the KB its own assumptions.
 *   3. Shape identical to the active contract → confirmation (evidence
 *      grows). Shape different → it joins a pending cluster; only N
 *      CONSISTENT observations with an IDENTICAL structural fingerprint
 *      (anti-poison gate, default 3) promote a new immutable contract
 *      version. A single anomalous response can never mutate the KB.
 *   4. Versions are immutable and diffable; rollback re-points the active
 *      version without rewriting history, and re-promotion after a rollback
 *      needs fresh evidence.
 *
 * Fully programmatic: structural schema inference only, no LLM anywhere in
 * the heal path.
 *
 * Design adapted from the clean-room reference implementation
 * (integration_stitcher, packages/kb/src/kb.ts) with the drift-bug fix
 * applied at the emission/consumption layers (see contract-observation.ts in
 * @bubblelab/shared-schemas).
 */
import type { ZodTypeAny } from 'zod';
import type { ContractObservation } from '@bubblelab/shared-schemas';
import {
  diffValueSchemas,
  fingerprintValueSchema,
  inferValueSchema,
  valueSchemaToZod,
  LOOSE_VALUE_SCHEMA,
  type ValueSchema,
  type ValueSchemaChange,
} from './value-schema.js';
import {
  integrationKbDocumentSchema,
  toKbJsonValue,
  type ContractChannel,
  type ContractChannelName,
  type ContractVersion,
  type IntegrationKbDocument,
  type NodeContractRecord,
} from './document.js';
import type { ContractKbStore } from './store.js';

export const DEFAULT_CONSISTENCY_THRESHOLD = 3;

export class ContractKbError extends Error {
  constructor(
    public readonly code:
      | 'NODE_UNKNOWN'
      | 'CHANNEL_UNKNOWN'
      | 'VERSION_UNKNOWN'
      | 'ROLLBACK_INVALID'
      | 'DOCUMENT_INVALID',
    message: string
  ) {
    super(message);
    this.name = 'ContractKbError';
  }
}

/**
 * Key an observation the way the KB stores it: the per-call-site identity
 * BubbleLab already assigns, falling back to the operation, then the bubble.
 */
export function contractNodeKeyFor(observation: {
  callSiteKey?: string;
  operation?: string;
  bubbleName: string;
}): string {
  if (observation.callSiteKey) return observation.callSiteKey;
  if (observation.operation) return `operation:${observation.operation}`;
  return `bubble:${observation.bubbleName}`;
}

export type ContractIngestAction = 'confirmed' | 'pending' | 'promoted';

/** One structural mismatch between an observed value and the ACTIVE contract version. */
export interface ContractDeviation {
  path: string;
  message: string;
}

export interface ContractChannelIngestOutcome {
  channel: ContractChannelName;
  action: ContractIngestAction;
  /** Deviations of this observation vs the active version at ingest time (the drift signal). */
  deviations: ContractDeviation[];
  /** Present when `action === 'pending'`: consistent observations so far vs the threshold. */
  pendingCount?: number;
  /** Present when `action === 'promoted'`. */
  promotedVersion?: number;
}

export interface ContractIngestResult {
  key: string;
  /** False when the observation was refused (ungrounded/mocked traffic). */
  accepted: boolean;
  reason?: string;
  channels: ContractChannelIngestOutcome[];
}

export interface ContractRollbackResult {
  key: string;
  fromVersion: number;
  toVersion: number;
}

export interface ContractKbOptions {
  /** The KB is per-integration (bubbleName). */
  integration: string;
  store: ContractKbStore;
  /** Anti-poison gate: consistent observations required before a contract mutates. */
  consistencyThreshold?: number;
}

export class ContractKb {
  readonly integration: string;
  readonly consistencyThreshold: number;
  readonly #store: ContractKbStore;
  #document: IntegrationKbDocument;

  private constructor(
    document: IntegrationKbDocument,
    store: ContractKbStore,
    threshold: number
  ) {
    this.integration = document.integration;
    this.consistencyThreshold = threshold;
    this.#store = store;
    this.#document = document;
  }

  /** Open (or create) the per-integration KB from its store. Loads are Zod-validated. */
  static async open(options: ContractKbOptions): Promise<ContractKb> {
    const threshold =
      options.consistencyThreshold ?? DEFAULT_CONSISTENCY_THRESHOLD;
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new ContractKbError(
        'ROLLBACK_INVALID',
        `consistencyThreshold must be a positive integer, got ${threshold}`
      );
    }
    const existing = await options.store.load(options.integration);
    let document: IntegrationKbDocument;
    if (existing === undefined) {
      document = {
        integration: options.integration,
        nodes: {},
        updatedAt: new Date().toISOString(),
      };
    } else {
      const parsed = integrationKbDocumentSchema.safeParse(existing);
      if (!parsed.success) {
        throw new ContractKbError(
          'DOCUMENT_INVALID',
          `stored KB document for '${options.integration}' failed validation: ${parsed.error.message}`
        );
      }
      document = parsed.data;
    }
    return new ContractKb(document, options.store, threshold);
  }

  // -------------------------------------------------------------------------
  // Node lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register a node with optional declared (loose) contracts. Unregistered
   * nodes are seeded on first ingest with the loosest contract, so
   * convergence always starts from an explicit v1.
   */
  async registerNode(input: {
    key: string;
    operation: string;
    declared?: { input?: ValueSchema; output?: ValueSchema };
  }): Promise<void> {
    const record = this.#ensureRecord(input.key, input.operation);
    if (input.declared?.input !== undefined && record.channels.input === null) {
      record.channels.input = newChannel(input.declared.input, 'declared');
    }
    if (
      input.declared?.output !== undefined &&
      record.channels.output === null
    ) {
      record.channels.output = newChannel(input.declared.output, 'declared');
    }
    await this.#persist();
  }

  hasNode(key: string): boolean {
    return this.#document.nodes[key] !== undefined;
  }

  nodeKeys(): string[] {
    return Object.keys(this.#document.nodes);
  }

  node(key: string): NodeContractRecord {
    return cloneJson(this.#record(key));
  }

  // -------------------------------------------------------------------------
  // Ingest + validator source of truth
  // -------------------------------------------------------------------------

  /**
   * Feed one observation into the KB. Grounded observations only: a mocked
   * observation is derived from the declared contract and can never teach
   * the KB anything about reality — accepting it would let the KB heal
   * toward its own assumptions.
   */
  async ingest(observation: ContractObservation): Promise<ContractIngestResult> {
    const key = contractNodeKeyFor(observation);
    if (!observation.grounded || observation.mocked === true) {
      return {
        key,
        accepted: false,
        reason:
          'observation is not grounded (mocked path); the KB heals only from real traffic',
        channels: [],
      };
    }
    const record = this.#ensureRecord(key, observation.operation ?? '');
    const channels: ContractChannelIngestOutcome[] = [];

    if (observation.input !== undefined) {
      channels.push(
        this.#ingestChannel(
          record,
          'input',
          observation.input,
          observation.observedAt
        )
      );
    }
    if (observation.output !== undefined) {
      channels.push(
        this.#ingestChannel(
          record,
          'output',
          observation.output,
          observation.observedAt
        )
      );
    }

    record.observationCount += 1;
    record.lastObservedAt = observation.observedAt;
    await this.#persist();
    return { key, accepted: true, channels };
  }

  /** The KB's executable source of truth for a node's input contract. */
  inputValidator(key: string): ZodTypeAny {
    return valueSchemaToZod(this.activeVersion(key, 'input').schema);
  }

  /** The KB's executable source of truth for a node's output contract. */
  outputValidator(key: string): ZodTypeAny {
    return valueSchemaToZod(this.activeVersion(key, 'output').schema);
  }

  /**
   * The most recent GROUNDED sample for a channel — recorded reality, served
   * to `getRecordedMock()` in test mode instead of schema-derived fiction.
   */
  latestSample(key: string, channel: ContractChannelName): unknown {
    const chan = this.#record(key).channels[channel];
    if (chan === null || chan.latestSample === null) return undefined;
    return cloneJson(chan.latestSample);
  }

  // -------------------------------------------------------------------------
  // Versions, diff, rollback, pending inspection
  // -------------------------------------------------------------------------

  versions(key: string, channel: ContractChannelName): ContractVersion[] {
    return this.#channel(key, channel).versions.map(cloneJson);
  }

  activeVersion(key: string, channel: ContractChannelName): ContractVersion {
    const chan = this.#channel(key, channel);
    return cloneJson(
      mustFindVersion(chan.versions, chan.activeVersion, key, channel)
    );
  }

  pendingClusters(
    key: string,
    channel: ContractChannelName
  ): { fingerprint: string; count: number }[] {
    return this.#channel(key, channel).pending.map((cluster) => ({
      fingerprint: cluster.fingerprint,
      count: cluster.count,
    }));
  }

  diff(
    key: string,
    channel: ContractChannelName,
    fromVersion: number,
    toVersion: number
  ): ValueSchemaChange[] {
    const chan = this.#channel(key, channel);
    const from = mustFindVersion(chan.versions, fromVersion, key, channel);
    const to = mustFindVersion(chan.versions, toVersion, key, channel);
    return diffValueSchemas(from.schema, to.schema);
  }

  /**
   * Re-point the active version to a prior one (a bad version rolls back).
   * The bad version stays in history marked `rolledBackAt`; pending evidence
   * is purged, so re-promotion of the same shape needs a fresh run of N
   * consistent observations and always mints a NEW version.
   */
  async rollback(
    key: string,
    channel: ContractChannelName,
    toVersion: number
  ): Promise<ContractRollbackResult> {
    const chan = this.#channel(key, channel);
    if (toVersion === chan.activeVersion) {
      throw new ContractKbError(
        'ROLLBACK_INVALID',
        `version ${toVersion} is already active for '${key}' ${channel}`
      );
    }
    const target = mustFindVersion(chan.versions, toVersion, key, channel);
    const current = mustFindVersion(
      chan.versions,
      chan.activeVersion,
      key,
      channel
    );
    current.rolledBackAt = new Date().toISOString();
    target.rolledBackAt = null;
    chan.activeVersion = target.version;
    chan.pending = [];
    await this.#persist();
    return { key, fromVersion: current.version, toVersion: target.version };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  #ingestChannel(
    record: NodeContractRecord,
    channel: ContractChannelName,
    value: unknown,
    observedAt: string
  ): ContractChannelIngestOutcome {
    let chan = record.channels[channel];
    if (chan === null) {
      chan = newChannel(LOOSE_VALUE_SCHEMA, 'declared');
      record.channels[channel] = chan;
    }
    const active = mustFindVersion(
      chan.versions,
      chan.activeVersion,
      record.key,
      channel
    );
    const inferred = inferValueSchema(value);
    const fingerprint = fingerprintValueSchema(inferred);

    // Every accepted grounded value refreshes the recorded sample the
    // test-mode mock provider serves.
    chan.latestSample = toKbJsonValue(value);
    chan.latestSampleAt = observedAt;

    if (fingerprint === fingerprintValueSchema(active.schema)) {
      active.evidence += 1;
      return { channel, action: 'confirmed', deviations: [] };
    }

    const deviations = deviationsAgainst(active.schema, value);
    let cluster = chan.pending.find(
      (candidate) => candidate.fingerprint === fingerprint
    );
    if (cluster === undefined) {
      cluster = {
        fingerprint,
        schema: inferred,
        count: 1,
        sample: toKbJsonValue(value),
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      };
      chan.pending.push(cluster);
    } else {
      cluster.count += 1;
      cluster.sample = toKbJsonValue(value);
      cluster.lastSeenAt = observedAt;
    }

    if (cluster.count < this.consistencyThreshold) {
      return {
        channel,
        action: 'pending',
        deviations,
        pendingCount: cluster.count,
      };
    }

    const version = nextVersionNumber(chan.versions);
    chan.versions.push({
      version,
      schema: cluster.schema,
      source: 'observed',
      evidence: cluster.count,
      createdAt: observedAt,
      rolledBackAt: null,
    });
    chan.activeVersion = version;
    chan.pending = [];
    return { channel, action: 'promoted', deviations, promotedVersion: version };
  }

  #ensureRecord(key: string, operation: string): NodeContractRecord {
    const existing = this.#document.nodes[key];
    if (existing !== undefined) return existing;
    const record: NodeContractRecord = {
      key,
      operation,
      channels: { input: null, output: null },
      observationCount: 0,
      lastObservedAt: null,
    };
    this.#document.nodes[key] = record;
    return record;
  }

  #record(key: string): NodeContractRecord {
    const record = this.#document.nodes[key];
    if (record === undefined) {
      throw new ContractKbError(
        'NODE_UNKNOWN',
        `no KB record for node '${key}' in integration '${this.integration}'`
      );
    }
    return record;
  }

  #channel(key: string, channel: ContractChannelName): ContractChannel {
    const chan = this.#record(key).channels[channel];
    if (chan === null) {
      throw new ContractKbError(
        'CHANNEL_UNKNOWN',
        `node '${key}' has no ${channel} contract yet (no declared seed and no observation)`
      );
    }
    return chan;
  }

  async #persist(): Promise<void> {
    this.#document.updatedAt = new Date().toISOString();
    await this.#store.save(this.#document);
  }
}

function newChannel(
  schema: ValueSchema,
  source: 'declared' | 'manual'
): ContractChannel {
  return {
    activeVersion: 1,
    versions: [
      {
        version: 1,
        schema,
        source,
        evidence: 0,
        createdAt: new Date().toISOString(),
        rolledBackAt: null,
      },
    ],
    pending: [],
    latestSample: null,
    latestSampleAt: null,
  };
}

function nextVersionNumber(versions: { version: number }[]): number {
  return versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
}

function mustFindVersion(
  versions: ContractVersion[],
  version: number,
  key: string,
  channel: ContractChannelName
): ContractVersion {
  const found = versions.find((candidate) => candidate.version === version);
  if (found === undefined) {
    throw new ContractKbError(
      'VERSION_UNKNOWN',
      `node '${key}' ${channel} has no version ${version}`
    );
  }
  return found;
}

function deviationsAgainst(
  schema: ValueSchema,
  value: unknown
): ContractDeviation[] {
  const result = valueSchemaToZod(schema).safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
