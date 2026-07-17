/**
 * ★ THE ACCEPTANCE TEST OF IR-11/12: a contract violation observed during a
 * PRODUCTION run (not a test run) reaches the Contract KB.
 *
 * This is the exact failure mode of the reference build — its KB passed
 * every lab test but never learned from production traffic, because the
 * drift signal collapsed at a wrapper boundary and nothing consumed it.
 * These tests drive the REAL production execution path
 * (executeBubbleFlowWithTracking → runBubbleFlowWithStreaming →
 * BubbleRunner temp-file import → BaseBubble.action()) against the real
 * sqlite test database, with NO testMode flag, and assert the drift landed
 * in the KB tables.
 */
// @ts-expect-error - Bun test types
import { describe, it, expect } from 'bun:test';
import '../config/env.js';
import { db } from '../db/index.js';
import {
  bubbleFlows,
  contractKbDocuments,
  contractObservations,
} from '../db/schema.js';
import { executeBubbleFlowWithTracking } from './bubble-flow-execution.js';
import { TEST_USER_ID } from '../test/setup.js';
import { eq } from 'drizzle-orm';
import type { IntegrationKbDocument } from '@bubblelab/bubble-core';
import { ContractKb } from '@bubblelab/bubble-core';
import { DrizzleContractKbStore } from './contract-kb-service.js';

const DRIFT_READ_FLOW = `
import { BubbleFlow, ContractDriftProbeBubble } from '@bubblelab/bubble-core';
import type { WebhookEvent } from '@bubblelab/bubble-core';

export class DriftProbeFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent) {
    const shape = (payload.body as { shape?: 'conform' | 'drift' })?.shape ?? 'conform';
    const probe = new ContractDriftProbeBubble({
      operation: 'probe_read',
      shape,
    });
    const result = await probe.action();
    return { status: result.success ? 'ok' : 'failed' };
  }
}
`;

const WRITE_FLOW = `
import { BubbleFlow, ContractDriftProbeBubble } from '@bubblelab/bubble-core';
import type { WebhookEvent } from '@bubblelab/bubble-core';

export class WriteProbeFlow extends BubbleFlow<'webhook/http'> {
  async handle(_payload: WebhookEvent) {
    const probe = new ContractDriftProbeBubble({
      operation: 'record_write',
      note: 'production-note',
    });
    return await probe.action();
  }
}
`;

async function insertFlow(name: string, code: string): Promise<number> {
  const rows = await db
    .insert(bubbleFlows)
    .values({
      userId: TEST_USER_ID,
      name,
      description: 'contract KB acceptance flow',
      code,
      originalCode: code,
      bubbleParameters: {},
      eventType: 'webhook/http',
    })
    .returning();
  return rows[0].id;
}

function payload(body: Record<string, unknown>) {
  return {
    type: 'webhook/http' as const,
    timestamp: new Date().toISOString(),
    path: '/contract-kb-test',
    executionId: `contract-kb-${Math.random().toString(36).slice(2)}`,
    body,
  };
}

const runOptions = {
  userId: TEST_USER_ID,
  pricingTable: {},
};

async function loadKbDocument(): Promise<IntegrationKbDocument> {
  const rows = await db
    .select()
    .from(contractKbDocuments)
    .where(eq(contractKbDocuments.integration, 'contract-drift-probe'));
  expect(rows.length).toBe(1);
  return rows[0].document as IntegrationKbDocument;
}

describe('Contract KB — production traffic (IR-11/12 acceptance)', () => {
  it(
    '★ a contract violation during a PRODUCTION run reaches the KB',
    async () => {
      const flowId = await insertFlow('drift-read-flow', DRIFT_READ_FLOW);

      // PRODUCTION run: no testMode anywhere.
      const result = await executeBubbleFlowWithTracking(
        flowId,
        payload({ shape: 'drift' }),
        runOptions
      );

      // 1. The drift signal survived every wrapper boundary, identifiably.
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('OUTPUT_CONTRACT_VIOLATION');
      expect(result.drift).toBeDefined();
      expect(result.drift![0].bubbleName).toBe('contract-drift-probe');
      expect(result.drift![0].findings.length).toBeGreaterThan(0);

      // 2. The observation reached the KB audit log, marked as PRODUCTION.
      const rows = await db
        .select()
        .from(contractObservations)
        .where(eq(contractObservations.integration, 'contract-drift-probe'));
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row.source).toBe('production');
      expect(row.grounded).toBe(true);
      expect(row.accepted).toBe(true);
      expect(row.errorCode).toBe('OUTPUT_CONTRACT_VIOLATION');
      expect(row.action).toBe('pending'); // one anomaly: pending, never promoted
      expect(row.bubbleFlowId).toBe(flowId);
      expect(row.executionId).toBe(result.executionId);
      expect(row.operation).toBe('probe_read');

      // 3. The KB document recorded the drifted shape as PENDING evidence —
      //    and the active contract did NOT mutate from one anomaly.
      const document = await loadKbDocument();
      const nodeKeys = Object.keys(document.nodes);
      expect(nodeKeys.length).toBe(1);
      const node = document.nodes[nodeKeys[0]];
      expect(node.operation).toBe('probe_read');
      const output = node.channels.output!;
      expect(output.activeVersion).toBe(1); // still the seeded loose v1
      expect(output.versions[0].source).toBe('declared');
      expect(output.pending.length).toBe(1);
      expect(output.pending[0].count).toBe(1);
    },
    600000
  );

  it(
    'production drift converges after 3 consistent observations; ONE conforming anomaly never mutates the healed contract',
    async () => {
      const flowId = await insertFlow('drift-read-flow', DRIFT_READ_FLOW);

      for (let i = 0; i < 3; i++) {
        await executeBubbleFlowWithTracking(
          flowId,
          payload({ shape: 'drift' }),
          runOptions
        );
      }

      // Healed: the consistently observed (drifted) shape is now the ACTIVE
      // contract, promoted as an immutable 'observed' version.
      let document = await loadKbDocument();
      const nodeKey = Object.keys(document.nodes)[0];
      let output = document.nodes[nodeKey].channels.output!;
      expect(output.activeVersion).toBe(2);
      const promoted = output.versions.find((v) => v.version === 2)!;
      expect(promoted.source).toBe('observed');
      expect(promoted.evidence).toBe(3);
      expect(output.pending.length).toBe(0);

      // The KB validator source of truth now ACCEPTS observed reality.
      const kb = await ContractKb.open({
        integration: 'contract-drift-probe',
        store: new DrizzleContractKbStore(),
      });
      expect(
        kb.outputValidator(nodeKey).safeParse({
          operation: 'probe_read',
          record: { id: 42, shape: 'changed' },
          success: true,
          error: '',
        }).success
      ).toBe(true);

      // One run with the OLD (now anomalous) shape: pending only, no mutation.
      await executeBubbleFlowWithTracking(
        flowId,
        payload({ shape: 'conform' }),
        runOptions
      );
      document = await loadKbDocument();
      output = document.nodes[nodeKey].channels.output!;
      expect(output.activeVersion).toBe(2); // unchanged
      expect(output.pending.length).toBe(1);
      expect(output.pending[0].count).toBe(1);

      // Rollback: a bad version rolls back to v1 and purges pending evidence.
      // Open a FRESH instance so the rollback operates on the latest stored
      // document (the document store is last-write-wins).
      const kbForRollback = await ContractKb.open({
        integration: 'contract-drift-probe',
        store: new DrizzleContractKbStore(),
      });
      const rollback = await kbForRollback.rollback(nodeKey, 'output', 1);
      expect(rollback.toVersion).toBe(1);
      const reopened = await ContractKb.open({
        integration: 'contract-drift-probe',
        store: new DrizzleContractKbStore(),
      });
      expect(reopened.activeVersion(nodeKey, 'output').version).toBe(1);
      expect(
        reopened
          .versions(nodeKey, 'output')
          .find((v) => v.version === 2)!.rolledBackAt
      ).not.toBeNull();
    },
    600000
  );

  it(
    'test-mode mocked writes are REFUSED by the KB; a recorded production write is served back as the test-mode mock',
    async () => {
      const flowId = await insertFlow('write-probe-flow', WRITE_FLOW);

      // TEST run first: the write is mocked, the KB must refuse to learn.
      const testRun = await executeBubbleFlowWithTracking(
        flowId,
        payload({}),
        { ...runOptions, testMode: true }
      );
      expect(testRun.success).toBe(true);
      const refusedRows = await db
        .select()
        .from(contractObservations)
        .where(eq(contractObservations.source, 'test'));
      expect(refusedRows.length).toBe(1);
      expect(refusedRows[0].grounded).toBe(false);
      expect(refusedRows[0].accepted).toBe(false);
      expect(refusedRows[0].action).toBe('refused');
      // No KB document was created from mocked traffic.
      const docsAfterMock = await db.select().from(contractKbDocuments);
      expect(docsAfterMock.length).toBe(0);
      // The mock served was generated fiction (no recording exists yet).
      const mockedData = testRun.data as {
        mocked?: boolean;
        data?: { receipt?: { note?: string } };
      };
      expect(mockedData.mocked).toBe(true);
      expect(mockedData.data?.receipt?.note).not.toBe('production-note');

      // PRODUCTION run: the real write response gets recorded.
      const prodRun = await executeBubbleFlowWithTracking(
        flowId,
        payload({}),
        runOptions
      );
      expect(prodRun.success).toBe(true);
      const document = await loadKbDocument();
      const nodeKey = Object.keys(document.nodes)[0];
      expect(
        document.nodes[nodeKey].channels.output!.latestSample
      ).toMatchObject({
        operation: 'record_write',
        receipt: { id: 'receipt-1', note: 'production-note' },
      });

      // TEST run again: the mocked write now serves RECORDED reality.
      const groundedTestRun = await executeBubbleFlowWithTracking(
        flowId,
        payload({}),
        { ...runOptions, testMode: true }
      );
      expect(groundedTestRun.success).toBe(true);
      const grounded = groundedTestRun.data as {
        mocked?: boolean;
        data?: { receipt?: { id?: string; note?: string } };
      };
      expect(grounded.mocked).toBe(true);
      expect(grounded.data?.receipt?.id).toBe('receipt-1');
      expect(grounded.data?.receipt?.note).toBe('production-note');
    },
    600000
  );
});
