/**
 * Drift-signal acceptance tests (IR-11/12 — the drift bug fix).
 *
 * The unit under test is the REAL BaseBubble.action() lifecycle using the
 * REAL ContractDriftProbeBubble (no mocking of the unit under test; the
 * probe runs entirely in-process, which is its purpose).
 *
 * The bug being guarded against: in the reference build the output-contract
 * violation was thrown but collapsed into a generic failure at the wrapper
 * boundary, and NOTHING consumed it. Here we prove:
 *  1. The violation is a DISTINCT, identifiable signal
 *     (BubbleOutputContractViolationError, code OUTPUT_CONTRACT_VIOLATION).
 *  2. The observation reaches the sink BEFORE any error propagation — so a
 *     user try/catch that swallows the error cannot swallow the signal.
 *  3. Mocked results emit grounded:false observations (the KB refuses them).
 *  4. A broken sink never breaks execution.
 */
import type {
  ContractObservation,
  BubbleOperationResult,
} from '@bubblelab/shared-schemas';
import { OUTPUT_CONTRACT_VIOLATION } from '@bubblelab/shared-schemas';
import { ContractDriftProbeBubble } from '../bubbles/service-bubble/contract-drift-probe.js';
import {
  BubbleOutputContractViolationError,
  BubbleValidationError,
} from './bubble-errors.js';
import type { BubbleContext } from './bubble.js';

const CALL_SITE = 'DriftProbeFlow.contract-drift-probe#1';

function collector() {
  const observations: ContractObservation[] = [];
  return {
    observations,
    context: {
      invocationCallSiteKey: CALL_SITE,
      contractObservationSink: (observation: ContractObservation) => {
        observations.push(observation);
      },
    } as BubbleContext,
  };
}

describe('drift signal — conforming real response', () => {
  it('emits ONE grounded observation carrying the real output', async () => {
    const { observations, context } = collector();
    const probe = new ContractDriftProbeBubble(
      { operation: 'probe_read', shape: 'conform' },
      context
    );
    const result = await probe.action();

    expect(result.success).toBe(true);
    expect(observations).toHaveLength(1);
    const obs = observations[0];
    expect(obs.grounded).toBe(true);
    expect(obs.mocked).toBeUndefined();
    expect(obs.errorCode).toBeUndefined();
    expect(obs.bubbleName).toBe('contract-drift-probe');
    expect(obs.operation).toBe('probe_read');
    expect(obs.callSiteKey).toBe(CALL_SITE);
    expect(obs.output).toMatchObject({
      operation: 'probe_read',
      record: { id: 'probe-1', status: 'ok' },
    });
  });
});

describe('drift signal — violating real response', () => {
  it('throws the DISTINCT violation error with the stable code and findings', async () => {
    const { context } = collector();
    const probe = new ContractDriftProbeBubble(
      { operation: 'probe_read', shape: 'drift' },
      context
    );

    let caught: unknown;
    try {
      await probe.action();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BubbleOutputContractViolationError);
    // Backward compatible: every existing instanceof branch still matches.
    expect(caught).toBeInstanceOf(BubbleValidationError);

    const violation = caught as BubbleOutputContractViolationError;
    expect(violation.code).toBe(OUTPUT_CONTRACT_VIOLATION);
    expect(violation.driftFindings.length).toBeGreaterThan(0);
    expect(violation.operation).toBe('probe_read');
    expect(violation.callSiteKey).toBe(CALL_SITE);
    expect(violation.observedOutput).toMatchObject({
      record: { id: 42, shape: 'changed' },
    });
    const paths = violation.driftFindings.map((f) => f.path);
    // The drifted field is named, not a vague failure.
    expect(paths.some((p) => p.includes('record'))).toBe(true);
  });

  it('★ the observation SURVIVES a user try/catch that swallows the error', async () => {
    const { observations, context } = collector();
    const probe = new ContractDriftProbeBubble(
      { operation: 'probe_read', shape: 'drift' },
      context
    );

    // Generated flow code often wraps bubble calls — the collapse scenario.
    let swallowed = false;
    try {
      await probe.action();
    } catch {
      swallowed = true; // the error dies here; the signal must not
    }
    expect(swallowed).toBe(true);

    expect(observations).toHaveLength(1);
    const obs = observations[0];
    expect(obs.grounded).toBe(true);
    expect(obs.errorCode).toBe(OUTPUT_CONTRACT_VIOLATION);
    expect(obs.driftFindings!.length).toBeGreaterThan(0);
    expect(obs.output).toMatchObject({ record: { id: 42, shape: 'changed' } });
    expect(obs.callSiteKey).toBe(CALL_SITE);
  });

  it('sink also honored when installed via executionMeta (generated-code channel)', async () => {
    const observations: ContractObservation[] = [];
    const probe = new ContractDriftProbeBubble(
      { operation: 'probe_read', shape: 'drift' },
      {
        currentUniqueId: CALL_SITE,
        executionMeta: {
          contractObservationSink: (observation: ContractObservation) => {
            observations.push(observation);
          },
        },
      } as BubbleContext
    );
    await probe.action().catch(() => undefined);
    expect(observations).toHaveLength(1);
    expect(observations[0].errorCode).toBe(OUTPUT_CONTRACT_VIOLATION);
    expect(observations[0].callSiteKey).toBe(CALL_SITE);
  });
});

describe('drift signal — mocked results are ungrounded', () => {
  it('test-mode mocked write emits grounded:false (the KB will refuse it)', async () => {
    const { observations, context } = collector();
    const probe = new ContractDriftProbeBubble(
      { operation: 'record_write', note: 'should-not-run' },
      { ...context, testMode: true }
    );
    const result = await probe.action();

    expect(result.mocked).toBe(true);
    expect(observations).toHaveLength(1);
    const obs = observations[0];
    expect(obs.grounded).toBe(false);
    expect(obs.mocked).toBe(true);
    expect(obs.operation).toBe('record_write');
  });

  it('test-mode READ runs for real and emits a grounded observation', async () => {
    const { observations, context } = collector();
    const probe = new ContractDriftProbeBubble(
      { operation: 'probe_read', shape: 'conform' },
      { ...context, testMode: true }
    );
    const result = await probe.action();
    expect(result.mocked).toBeUndefined();
    expect(observations).toHaveLength(1);
    expect(observations[0].grounded).toBe(true);
  });

  it('recorded mock is preferred in test mode and still emits ungrounded', async () => {
    const recorded: BubbleOperationResult = {
      operation: 'record_write',
      receipt: { id: 'recorded-from-production', note: 'real note' },
      success: true,
      error: '',
    };
    const observations: ContractObservation[] = [];
    const probe = new ContractDriftProbeBubble(
      { operation: 'record_write' },
      {
        testMode: true,
        recordedMockProvider: () => recorded,
        contractObservationSink: (observation: ContractObservation) => {
          observations.push(observation);
        },
      } as BubbleContext
    );
    const result = await probe.action();
    expect(result.mocked).toBe(true);
    expect(
      (result.data as { receipt?: { id?: string } }).receipt?.id
    ).toBe('recorded-from-production');
    expect(observations).toHaveLength(1);
    expect(observations[0].grounded).toBe(false);
  });
});

describe('drift signal — a broken consumer never breaks execution', () => {
  it('conform path returns normally when the sink throws', async () => {
    const probe = new ContractDriftProbeBubble(
      { operation: 'probe_read', shape: 'conform' },
      {
        contractObservationSink: () => {
          throw new Error('sink exploded');
        },
      } as BubbleContext
    );
    const result = await probe.action();
    expect(result.success).toBe(true);
  });

  it('drift path still throws the violation (not the sink error)', async () => {
    const probe = new ContractDriftProbeBubble(
      { operation: 'probe_read', shape: 'drift' },
      {
        contractObservationSink: () => {
          throw new Error('sink exploded');
        },
      } as BubbleContext
    );
    await expect(probe.action()).rejects.toBeInstanceOf(
      BubbleOutputContractViolationError
    );
  });
});
