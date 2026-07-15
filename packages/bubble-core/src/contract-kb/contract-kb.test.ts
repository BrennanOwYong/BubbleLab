/**
 * Contract KB acceptance tests (IR-11/12).
 *
 * Acceptance criteria exercised against the REAL engine (no mocking of the
 * unit under test; the store is the engine's own InMemoryContractKbStore):
 *  - a loose contract CONVERGES to ground truth after real observations
 *  - ONE anomaly never mutates a contract (anti-poison, threshold 3)
 *  - a bad version ROLLS BACK, and re-promotion needs fresh evidence
 *  - a MOCKED observation is refused
 *  - versions are immutable and diffable
 *  - the latest grounded sample is served for recorded mocks
 */
import type { ContractObservation } from '@bubblelab/shared-schemas';
import { ContractKb, contractNodeKeyFor } from './contract-kb.js';
import { InMemoryContractKbStore } from './store.js';
import { inferValueSchema, fingerprintValueSchema } from './value-schema.js';

const NODE_KEY = 'DriftProbeFlow.contract-drift-probe#1';

function observation(
  output: unknown,
  overrides: Partial<ContractObservation> = {}
): ContractObservation {
  return {
    bubbleName: 'contract-drift-probe',
    operation: 'probe_read',
    callSiteKey: NODE_KEY,
    grounded: true,
    success: true,
    output,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

const GROUND_TRUTH = {
  operation: 'probe_read',
  record: { id: 'probe-1', status: 'ok' },
  success: true,
  error: '',
};

const ANOMALY_500 = {
  message: 'Internal Server Error',
  code: 500,
};

async function openKb(store = new InMemoryContractKbStore()) {
  const kb = await ContractKb.open({
    integration: 'contract-drift-probe',
    store,
  });
  return { kb, store };
}

describe('ContractKb — convergence to ground truth', () => {
  it('a loose contract converges to the observed shape after 3 consistent observations', async () => {
    const { kb } = await openKb();

    const first = await kb.ingest(observation(GROUND_TRUTH));
    expect(first.accepted).toBe(true);
    const firstOutput = first.channels.find((c) => c.channel === 'output')!;
    // Different shape than the auto-seeded loose contract → pending, not promoted.
    expect(firstOutput.action).toBe('pending');
    expect(firstOutput.pendingCount).toBe(1);
    expect(kb.activeVersion(NODE_KEY, 'output').version).toBe(1);
    expect(kb.activeVersion(NODE_KEY, 'output').schema).toEqual({
      kind: 'unknown',
    });

    await kb.ingest(observation({ ...GROUND_TRUTH, record: { id: 'probe-2', status: 'done' } }));
    const third = await kb.ingest(observation(GROUND_TRUTH));
    const thirdOutput = third.channels.find((c) => c.channel === 'output')!;
    expect(thirdOutput.action).toBe('promoted');
    expect(thirdOutput.promotedVersion).toBe(2);

    // The active contract IS the observed ground truth now.
    const active = kb.activeVersion(NODE_KEY, 'output');
    expect(active.version).toBe(2);
    expect(active.source).toBe('observed');
    expect(fingerprintValueSchema(active.schema)).toBe(
      fingerprintValueSchema(inferValueSchema(GROUND_TRUTH))
    );

    // And the compiled validator accepts reality, rejects the old fiction.
    expect(kb.outputValidator(NODE_KEY).safeParse(GROUND_TRUTH).success).toBe(
      true
    );
    expect(kb.outputValidator(NODE_KEY).safeParse(ANOMALY_500).success).toBe(
      false
    );
  });

  it('shape-level inference: different field values, same structure → consistent', async () => {
    const { kb } = await openKb();
    await kb.ingest(observation(GROUND_TRUTH));
    await kb.ingest(
      observation({
        operation: 'probe_read',
        record: { id: 'zzz', status: 'anything else' },
        success: false,
        error: 'still same shape',
      })
    );
    const result = await kb.ingest(
      observation({ ...GROUND_TRUTH, record: { id: 'x', status: 'y' } })
    );
    expect(result.channels.find((c) => c.channel === 'output')!.action).toBe(
      'promoted'
    );
  });

  it('persists across store round-trips (a new KB instance sees the converged contract)', async () => {
    const store = new InMemoryContractKbStore();
    const { kb } = await openKb(store);
    for (let i = 0; i < 3; i++) {
      await kb.ingest(observation(GROUND_TRUTH));
    }
    const reopened = await ContractKb.open({
      integration: 'contract-drift-probe',
      store,
    });
    expect(reopened.activeVersion(NODE_KEY, 'output').source).toBe('observed');
    expect(
      reopened.outputValidator(NODE_KEY).safeParse(GROUND_TRUTH).success
    ).toBe(true);
  });
});

describe('ContractKb — anti-poison gate', () => {
  it('ONE anomalous response (a 500 shape) never mutates a converged contract', async () => {
    const { kb } = await openKb();
    for (let i = 0; i < 3; i++) {
      await kb.ingest(observation(GROUND_TRUTH));
    }
    const converged = kb.activeVersion(NODE_KEY, 'output');

    const anomaly = await kb.ingest(observation(ANOMALY_500));
    const outcome = anomaly.channels.find((c) => c.channel === 'output')!;
    expect(outcome.action).toBe('pending');
    expect(outcome.pendingCount).toBe(1);
    // The drift vs the active contract is FLAGGED, never silent.
    expect(outcome.deviations.length).toBeGreaterThan(0);

    // Active contract unchanged.
    expect(kb.activeVersion(NODE_KEY, 'output')).toEqual(converged);
  });

  it('two inconsistent anomalies do not promote; three CONSISTENT ones do', async () => {
    const { kb } = await openKb();
    for (let i = 0; i < 3; i++) {
      await kb.ingest(observation(GROUND_TRUTH));
    }

    // Two different anomaly shapes — separate clusters, no promotion.
    await kb.ingest(observation(ANOMALY_500));
    await kb.ingest(observation({ totally: 'different' }));
    expect(kb.activeVersion(NODE_KEY, 'output').source).toBe('observed');
    expect(kb.pendingClusters(NODE_KEY, 'output')).toHaveLength(2);

    // Consistent drift (the API REALLY changed): 3 identical fingerprints heal.
    const drifted = {
      operation: 'probe_read',
      record: { id: 42, shape: 'changed' },
      success: true,
      error: '',
    };
    await kb.ingest(observation(drifted));
    await kb.ingest(observation(drifted));
    const healed = await kb.ingest(observation(drifted));
    expect(
      healed.channels.find((c) => c.channel === 'output')!.action
    ).toBe('promoted');
    expect(kb.outputValidator(NODE_KEY).safeParse(drifted).success).toBe(true);
    expect(kb.outputValidator(NODE_KEY).safeParse(GROUND_TRUTH).success).toBe(
      false
    );
    // Promotion clears all pending clusters (including the stale anomalies).
    expect(kb.pendingClusters(NODE_KEY, 'output')).toHaveLength(0);
  });

  it('REFUSES to learn from a mocked observation', async () => {
    const { kb } = await openKb();
    const refusedByFlag = await kb.ingest(
      observation(GROUND_TRUTH, { grounded: false, mocked: true })
    );
    expect(refusedByFlag.accepted).toBe(false);
    expect(refusedByFlag.reason).toContain('mocked');
    expect(refusedByFlag.channels).toHaveLength(0);
    expect(kb.hasNode(NODE_KEY)).toBe(false);

    // Belt and braces: grounded=true but mocked=true is still refused.
    const refusedByMockFlag = await kb.ingest(
      observation(GROUND_TRUTH, { grounded: true, mocked: true })
    );
    expect(refusedByMockFlag.accepted).toBe(false);
  });
});

describe('ContractKb — immutable versions, diff, rollback', () => {
  async function convergeThenDrift() {
    const { kb, store } = await openKb();
    for (let i = 0; i < 3; i++) {
      await kb.ingest(observation(GROUND_TRUTH));
    }
    const drifted = {
      operation: 'probe_read',
      record: { id: 42, shape: 'changed' },
      success: true,
      error: '',
    };
    for (let i = 0; i < 3; i++) {
      await kb.ingest(observation(drifted));
    }
    return { kb, store, drifted };
  }

  it('diff names what changed between versions', async () => {
    const { kb } = await convergeThenDrift();
    const changes = kb.diff(NODE_KEY, 'output', 2, 3);
    const paths = changes.map((c) => `${c.change}:${c.path}`);
    expect(paths).toContain('changed:record.id'); // string → number
    expect(paths).toContain('removed:record.status');
    expect(paths).toContain('added:record.shape');
  });

  it('a bad version rolls back; history is preserved; re-promotion needs fresh evidence', async () => {
    const { kb, drifted } = await convergeThenDrift();
    expect(kb.activeVersion(NODE_KEY, 'output').version).toBe(3);

    const rollback = await kb.rollback(NODE_KEY, 'output', 2);
    expect(rollback).toEqual({ key: NODE_KEY, fromVersion: 3, toVersion: 2 });
    expect(kb.activeVersion(NODE_KEY, 'output').version).toBe(2);
    // Validator source of truth follows the rollback.
    expect(kb.outputValidator(NODE_KEY).safeParse(GROUND_TRUTH).success).toBe(
      true
    );

    // History immutable: version 3 still exists, marked rolled back.
    const versions = kb.versions(NODE_KEY, 'output');
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions.find((v) => v.version === 3)!.rolledBackAt).not.toBeNull();

    // Pending evidence was purged: the same drift needs a FRESH run of 3.
    await kb.ingest(observation(drifted));
    await kb.ingest(observation(drifted));
    expect(kb.activeVersion(NODE_KEY, 'output').version).toBe(2);
    const repromoted = await kb.ingest(observation(drifted));
    const outcome = repromoted.channels.find((c) => c.channel === 'output')!;
    // Always a NEW version — never re-activated in place.
    expect(outcome.action).toBe('promoted');
    expect(outcome.promotedVersion).toBe(4);
  });

  it('rolling back to the active version is rejected', async () => {
    const { kb } = await convergeThenDrift();
    await expect(kb.rollback(NODE_KEY, 'output', 3)).rejects.toThrow(
      /already active/
    );
  });
});

describe('ContractKb — recorded samples and node keying', () => {
  it('serves the latest grounded sample for recorded mocks', async () => {
    const { kb } = await openKb();
    await kb.ingest(observation(GROUND_TRUTH));
    expect(kb.latestSample(NODE_KEY, 'output')).toEqual(GROUND_TRUTH);

    const newer = { ...GROUND_TRUTH, record: { id: 'probe-9', status: 'new' } };
    await kb.ingest(observation(newer));
    expect(kb.latestSample(NODE_KEY, 'output')).toEqual(newer);
  });

  it('keys by call site first, then operation, then bubble', () => {
    expect(
      contractNodeKeyFor({
        bubbleName: 'x',
        operation: 'op',
        callSiteKey: 'Flow.x#1',
      })
    ).toBe('Flow.x#1');
    expect(contractNodeKeyFor({ bubbleName: 'x', operation: 'op' })).toBe(
      'operation:op'
    );
    expect(contractNodeKeyFor({ bubbleName: 'x' })).toBe('bubble:x');
  });

  it('registerNode seeds a declared contract as version 1', async () => {
    const { kb } = await openKb();
    await kb.registerNode({
      key: NODE_KEY,
      operation: 'probe_read',
      declared: { output: inferValueSchema(GROUND_TRUTH) },
    });
    const v1 = kb.activeVersion(NODE_KEY, 'output');
    expect(v1.version).toBe(1);
    expect(v1.source).toBe('declared');
    // Matching traffic confirms instead of pending.
    const result = await kb.ingest(observation(GROUND_TRUTH));
    expect(result.channels.find((c) => c.channel === 'output')!.action).toBe(
      'confirmed'
    );
  });
});
