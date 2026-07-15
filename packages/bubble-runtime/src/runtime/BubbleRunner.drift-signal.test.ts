/**
 * Drift signal across the WRAPPER BOUNDARY (IR-11/12 — the drift bug fix).
 *
 * The reference build lost the output-contract-violation code exactly here:
 * the runner collapsed it into a generic failure string. These tests run the
 * REAL generated-code path (temp-file import, injected logging, executionMeta
 * threading) and prove:
 *  1. ExecutionResult carries the stable errorCode OUTPUT_CONTRACT_VIOLATION
 *     plus structured drift findings — never just prose.
 *  2. The observation sink threaded via executionMeta receives the grounded
 *     drift observation through the generated-code path.
 */
import { BubbleRunner } from './BubbleRunner';
import { getFixture } from '../../tests/fixtures/index.js';
import { BubbleFactory } from '@bubblelab/bubble-core';
import {
  OUTPUT_CONTRACT_VIOLATION,
  type ContractObservation,
} from '@bubblelab/shared-schemas';

describe('BubbleRunner drift-signal boundary preservation', () => {
  const bubbleFactory = new BubbleFactory();
  const driftFlowScript = getFixture('contract-drift-probe-flow');

  beforeEach(async () => {
    await bubbleFactory.registerDefaults();
  });

  it('★ a violating response surfaces as errorCode + structured drift, not a prose-only failure', async () => {
    const observations: ContractObservation[] = [];
    const runner = new BubbleRunner(driftFlowScript, bubbleFactory, {
      pricingTable: {},
      executionMeta: {
        contractObservationSink: (observation) => {
          observations.push(observation);
        },
      },
    });
    const result = await runner.runAll({ body: { shape: 'drift' } });

    // The run fails — but identifiably, with the drift code preserved.
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(OUTPUT_CONTRACT_VIOLATION);
    expect(result.drift).toBeDefined();
    expect(result.drift!.length).toBe(1);
    const drift = result.drift![0];
    expect(drift.bubbleName).toBe('contract-drift-probe');
    expect(drift.operation).toBe('probe_read');
    expect(drift.findings.length).toBeGreaterThan(0);
    expect(drift.findings.map((f) => f.path).join(',')).toContain('record');

    // The sink consumed the drift observation through the generated-code path.
    const driftObservations = observations.filter(
      (o) => o.errorCode === OUTPUT_CONTRACT_VIOLATION
    );
    expect(driftObservations).toHaveLength(1);
    expect(driftObservations[0].grounded).toBe(true);
    expect(driftObservations[0].bubbleName).toBe('contract-drift-probe');
  });

  it('a conforming run reports success with no drift and a grounded observation', async () => {
    const observations: ContractObservation[] = [];
    const runner = new BubbleRunner(driftFlowScript, bubbleFactory, {
      pricingTable: {},
      executionMeta: {
        contractObservationSink: (observation) => {
          observations.push(observation);
        },
      },
    });
    const result = await runner.runAll({ body: { shape: 'conform' } });

    expect(result.success).toBe(true);
    expect(result.errorCode).toBeUndefined();
    expect(result.drift).toBeUndefined();
    const grounded = observations.filter((o) => o.grounded);
    expect(grounded.length).toBeGreaterThanOrEqual(1);
    expect(grounded[0].output).toMatchObject({
      record: { id: 'probe-1', status: 'ok' },
    });
    expect(grounded[0].errorCode).toBeUndefined();
  });
});
