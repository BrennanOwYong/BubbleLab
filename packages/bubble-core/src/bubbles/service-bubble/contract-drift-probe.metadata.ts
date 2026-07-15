/**
 * Per-operation side-effect metadata for the 'contract-drift-probe' bubble
 * (IR-8 format). Hand-written, not backfilled: this bubble wraps no vendor
 * API — it runs entirely in-process, so the classification source is
 * 'manual' with the bubble's own contract as the citation.
 */
import type { BubbleOperationMetadata } from '@bubblelab/shared-schemas';

export const CONTRACT_DRIFT_PROBE_OPERATION_METADATA: BubbleOperationMetadata =
  {
    probe_read: {
      sideEffect: 'read',
      destructive: false,
      idempotent: true,
      confidence: 1,
      source: 'manual',
      citation:
        'contract-drift-probe.ts performAction — in-process diagnostic; returns local data, mutates nothing, calls no external API',
    },
    record_write: {
      sideEffect: 'write',
      destructive: false,
      idempotent: true,
      confidence: 1,
      source: 'manual',
      citation:
        'contract-drift-probe.ts performAction — classified write ON PURPOSE so the test-mode gate mocks it and the recorded-mock loop is exercisable; the operation itself only returns a local receipt',
    },
  };
