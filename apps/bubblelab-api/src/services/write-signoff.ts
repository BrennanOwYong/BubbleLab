/**
 * The write sign-off gate (REPO-MAP §4b) — server-side, authoritative.
 *
 * Before a REAL run dispatches, the flow's write set is computed from its
 * stored parsed bubbles (call-site identity + IR-8 operation metadata, with
 * runtime-verified overrides applied). A run whose write set is not fully
 * covered by a persisted sign-off is BLOCKED — nothing executes. Sign-off is
 * explicit: the creator must name every write call site; the record (who,
 * when, which call sites, for which code) persists on the flow row and a code
 * change invalidates it. TEST runs are never blocked here: test mode mocks
 * writes in BaseBubble.action(), and per-op real-write grants in the test body
 * ARE the explicit sign-off for those operations.
 *
 * Fail-safe properties inherited from computeWriteSet: unclassified bubbles,
 * unknown operations, and non-literal operation params all count as writes.
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { computeWriteSet } from '@bubblelab/bubble-core';
import {
  WriteSignOffRecordSchema,
  type BubbleName,
  type ParsedBubbleWithInfo,
  type WriteSetEntry,
  type WriteSignOffRecord,
} from '@bubblelab/shared-schemas';
import { db } from '../db/index.js';
import { bubbleFlows } from '../db/schema.js';
import { getBubbleFactory } from './bubble-factory-instance.js';

export const WRITE_SIGNOFF_METADATA_KEY = 'writeSignOff';

export interface WriteSignOffDecision {
  /** True when no un-signed-off write-hinted call site remains. */
  allowed: boolean;
  /** The full write set of the flow (empty when the flow only reads). */
  writeSet: WriteSetEntry[];
  /** Write-set entries not covered by the sign-off (empty when allowed). */
  pending: WriteSetEntry[];
  /**
   * Every approved identity (primary + alias keys of signed-off entries) —
   * stamped into the run as approvedWriteCallSites for base-class enforcement.
   */
  approvedKeys: string[];
}

export function hashFlowCode(code: string | null | undefined): string {
  return createHash('sha256')
    .update(code ?? '')
    .digest('hex');
}

/** Compute the write set of a stored flow from its parsed bubble parameters. */
export async function computeFlowWriteSet(
  bubbleParameters: Record<string, ParsedBubbleWithInfo> | null | undefined
): Promise<WriteSetEntry[]> {
  if (!bubbleParameters || Object.keys(bubbleParameters).length === 0) {
    return [];
  }
  const factory = await getBubbleFactory();
  return computeWriteSet(
    bubbleParameters,
    (bubbleName) =>
      factory.getMetadata(bubbleName as BubbleName)?.operationMetadata
  );
}

/** The persisted sign-off for a flow, when one exists and parses. */
export function readPersistedSignOff(
  metadata: unknown
): WriteSignOffRecord | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const candidate = (metadata as Record<string, unknown>)[
    WRITE_SIGNOFF_METADATA_KEY
  ];
  const parsed = WriteSignOffRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Evaluate the gate for a flow. A sign-off covers a write-set entry when any
 * of the entry's identity keys was approved AND the sign-off was granted for
 * the flow's CURRENT code (hash match) — editing the flow re-opens the gate.
 */
export async function evaluateWriteSignOff(flow: {
  bubbleParameters: unknown;
  metadata: unknown;
  originalCode: string | null;
}): Promise<WriteSignOffDecision> {
  const writeSet = await computeFlowWriteSet(
    flow.bubbleParameters as Record<string, ParsedBubbleWithInfo> | null
  );
  if (writeSet.length === 0) {
    // Pure-read flow: reads are safe, no sign-off needed.
    return { allowed: true, writeSet, pending: [], approvedKeys: [] };
  }

  const signOff = readPersistedSignOff(flow.metadata);
  const codeHash = hashFlowCode(flow.originalCode);
  const approvedSet =
    signOff && signOff.codeHash === codeHash
      ? new Set(signOff.approvedCallSiteKeys)
      : new Set<string>();

  const pending = writeSet.filter(
    (entry) => !entry.aliasKeys.some((key) => approvedSet.has(key))
  );
  const covered = writeSet.filter((entry) =>
    entry.aliasKeys.some((key) => approvedSet.has(key))
  );

  return {
    allowed: pending.length === 0,
    writeSet,
    pending,
    approvedKeys: [...new Set(covered.flatMap((entry) => entry.aliasKeys))],
  };
}

export interface ApproveWritesResult {
  success: boolean;
  error?: string;
  writeSet: WriteSetEntry[];
  signOff?: WriteSignOffRecord;
}

/**
 * Record an explicit sign-off. The requester must name EVERY write-hinted
 * call site (by its primary callSiteKey or any alias) — partial approval is
 * rejected so a write can never slip through half-signed. The record persists
 * on the flow row with who/when/code-hash for audit.
 */
export async function approveFlowWrites(
  flow: {
    id: number;
    bubbleParameters: unknown;
    metadata: unknown;
    originalCode: string | null;
  },
  approvedCallSiteKeys: string[],
  signedOffBy: string
): Promise<ApproveWritesResult> {
  const writeSet = await computeFlowWriteSet(
    flow.bubbleParameters as Record<string, ParsedBubbleWithInfo> | null
  );
  if (writeSet.length === 0) {
    return {
      success: false,
      error: 'Flow has no write-hinted operations; nothing to sign off.',
      writeSet,
    };
  }

  const requested = new Set(approvedCallSiteKeys);
  const uncovered = writeSet.filter(
    (entry) => !entry.aliasKeys.some((key) => requested.has(key))
  );
  if (uncovered.length > 0) {
    return {
      success: false,
      error:
        `Sign-off must name every write-hinted call site. Missing: ` +
        uncovered
          .map(
            (entry) =>
              `${entry.bubbleName}.${entry.operation ?? '(no operation)'} [${entry.callSiteKey}]`
          )
          .join(', '),
      writeSet,
    };
  }

  // Store the entries' full alias sets so runtime matching never depends on
  // which identity the context exposes.
  const signOff: WriteSignOffRecord = {
    approvedCallSiteKeys: [
      ...new Set(writeSet.flatMap((entry) => entry.aliasKeys)),
    ],
    signedOffBy,
    signedOffAt: new Date().toISOString(),
    codeHash: hashFlowCode(flow.originalCode),
  };

  const existingMetadata =
    typeof flow.metadata === 'object' && flow.metadata !== null
      ? (flow.metadata as Record<string, unknown>)
      : {};
  await db
    .update(bubbleFlows)
    .set({
      metadata: { ...existingMetadata, [WRITE_SIGNOFF_METADATA_KEY]: signOff },
    })
    .where(eq(bubbleFlows.id, flow.id));

  return { success: true, writeSet, signOff };
}
