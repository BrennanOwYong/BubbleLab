/**
 * Contract KB consumer (IR-11/12) — THE piece the reference build was
 * missing: a consumer for the drift signal.
 *
 * BaseBubble.action() emits ContractObservations through the sink installed
 * on executionMeta (see runBubbleFlowCommon in execution.ts). After EVERY run
 * — production and test — this service ingests the collected observations
 * into the per-integration Contract KB (Drizzle-backed) and appends an
 * audit row per observation. Production traffic feeding the KB is the whole
 * point: contract drift observed in the wild converges the recorded contract
 * toward ground truth, gated by the anti-poison rule (3 consistent
 * observations; mocked observations refused).
 *
 * The recorded-mock provider closes the loop in the other direction: test
 * runs serve RECORDED real responses for mocked write operations instead of
 * schema-derived fiction.
 */
import {
  ContractKb,
  contractNodeKeyFor,
  type ContractKbStore,
  type IntegrationKbDocument,
} from '@bubblelab/bubble-core';
import type {
  ContractObservation,
  ContractObservationSink,
  RecordedMockLookup,
  RecordedMockProvider,
  BubbleOperationResult,
} from '@bubblelab/shared-schemas';
import { cleanUpObjectForDisplayAndStorage } from '@bubblelab/shared-schemas';
import { db } from '../db/index.js';
import { contractKbDocuments, contractObservations } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export type ContractRunSource = 'production' | 'test';

/** Drizzle-backed store for per-integration KB documents. */
export class DrizzleContractKbStore implements ContractKbStore {
  async load(integration: string): Promise<IntegrationKbDocument | undefined> {
    const rows = await db
      .select()
      .from(contractKbDocuments)
      .where(eq(contractKbDocuments.integration, integration))
      .limit(1);
    const first = rows[0];
    if (!first) return undefined;
    return first.document as IntegrationKbDocument;
  }

  async save(document: IntegrationKbDocument): Promise<void> {
    await db
      .insert(contractKbDocuments)
      .values({
        integration: document.integration,
        document,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: contractKbDocuments.integration,
        set: { document, updatedAt: new Date() },
      });
  }
}

export interface ContractObservationCollector {
  /** Install this on executionMeta.contractObservationSink. */
  sink: ContractObservationSink;
  /** Everything the run emitted, in emission order. */
  observations: ContractObservation[];
}

/** Per-run in-memory collector. The sink is cheap and never throws. */
export function createContractObservationCollector(): ContractObservationCollector {
  const observations: ContractObservation[] = [];
  return {
    observations,
    sink: (observation) => {
      observations.push(observation);
    },
  };
}

export interface IngestRunInput {
  observations: ContractObservation[];
  /** Where the run came from — production runs feeding the KB is the moat. */
  source: ContractRunSource;
  bubbleFlowId?: number;
  executionId?: number;
}

/**
 * Feed one run's observations into the KB and the audit log. Never throws:
 * contract learning must not break execution. Grounded observations go
 * through the anti-poison ingest; mocked ones are logged as refused.
 */
export async function ingestContractObservations(
  input: IngestRunInput
): Promise<void> {
  if (input.observations.length === 0) return;
  const store = new DrizzleContractKbStore();
  // One KB instance per integration touched by the run.
  const kbs = new Map<string, ContractKb>();

  for (const observation of input.observations) {
    try {
      let kb = kbs.get(observation.bubbleName);
      if (!kb) {
        kb = await ContractKb.open({
          integration: observation.bubbleName,
          store,
        });
        kbs.set(observation.bubbleName, kb);
      }
      const result = await kb.ingest(observation);
      const outputOutcome = result.channels.find(
        (channel) => channel.channel === 'output'
      );
      await db.insert(contractObservations).values({
        integration: observation.bubbleName,
        nodeKey: result.key,
        operation: observation.operation ?? null,
        source: input.source,
        grounded: observation.grounded,
        accepted: result.accepted,
        action: result.accepted ? (outputOutcome?.action ?? null) : 'refused',
        errorCode: observation.errorCode ?? null,
        driftFindings: observation.driftFindings
          ? cleanUpObjectForDisplayAndStorage(observation.driftFindings)
          : null,
        sample:
          observation.output !== undefined
            ? cleanUpObjectForDisplayAndStorage(
                observation.output as Record<string, unknown>
              )
            : null,
        bubbleFlowId: input.bubbleFlowId ?? null,
        executionId: input.executionId ?? null,
        observedAt: observation.observedAt,
      });
    } catch (error) {
      // Contract learning is best-effort; the run result is never affected.
      console.error(
        `[contract-kb] failed to ingest observation for ${observation.bubbleName}:`,
        error
      );
    }
  }
}

/**
 * Serve RECORDED real responses as test-mode mocks. Looks up the node by the
 * same key precedence the emitter uses (callSiteKey, then operation
 * fallback) and returns the latest grounded output sample, or undefined so
 * the caller falls back to the generated mock.
 */
export function createRecordedMockProvider(): RecordedMockProvider {
  const store = new DrizzleContractKbStore();
  return async (
    lookup: RecordedMockLookup
  ): Promise<BubbleOperationResult | undefined> => {
    const kb = await ContractKb.open({
      integration: lookup.bubbleName,
      store,
    });
    const candidateKeys: string[] = [];
    if (lookup.callSiteKey) candidateKeys.push(lookup.callSiteKey);
    candidateKeys.push(
      contractNodeKeyFor({
        bubbleName: lookup.bubbleName,
        operation: lookup.operation,
      })
    );
    for (const key of candidateKeys) {
      if (!kb.hasNode(key)) continue;
      const sample = kb.latestSample(key, 'output');
      if (sample !== undefined) {
        return sample as BubbleOperationResult;
      }
    }
    // Last resort: any node of this integration recorded for the same
    // operation (cross-call-site reuse of recorded reality).
    if (lookup.operation) {
      for (const key of kb.nodeKeys()) {
        const node = kb.node(key);
        if (node.operation !== lookup.operation) continue;
        const sample = kb.latestSample(key, 'output');
        if (sample !== undefined) {
          return sample as BubbleOperationResult;
        }
      }
    }
    return undefined;
  };
}
