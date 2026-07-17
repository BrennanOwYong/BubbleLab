/**
 * Contract observation types (IR-11/12 — the Contract Knowledge Base feed).
 *
 * A ContractObservation is one record of what a bubble invocation ACTUALLY
 * returned, emitted from BaseBubble.action() at the result-validation site —
 * BEFORE any error propagation. Emitting at that site is the drift-bug fix:
 * in the reference build the output-contract-violation signal was thrown by
 * the adapter but collapsed into a generic failure at the wrapper boundary,
 * so nothing downstream could consume it and the KB only ever learned from
 * lab tests. Here the observation travels through a side channel (the sink on
 * ExecutionMeta) that no wrapper boundary and no user try/catch can swallow,
 * and the API execution service consumes it after every run — production
 * traffic included.
 *
 * Design source: docs/plan/HANDOFF.md §9, docs/plan/REPO-MAP.md §3
 * "Contract KB (IR-11/12)".
 */

/**
 * Stable machine-readable code for "the response violated the declared
 * resultSchema". Survives every wrapper boundary: carried on
 * BubbleOutputContractViolationError, on the emitted ContractObservation, and
 * on ExecutionResult.errorCode when the violation propagates out of the flow.
 */
export const OUTPUT_CONTRACT_VIOLATION = 'OUTPUT_CONTRACT_VIOLATION' as const;
export type OutputContractViolationCode = typeof OUTPUT_CONTRACT_VIOLATION;

/** One structural mismatch between an observed value and the declared contract. */
export interface ContractDriftFinding {
  /** Dotted path into the observed value ('' is the root). */
  path: string;
  message: string;
}

/**
 * One observed bubble result, keyed by BubbleLab's existing per-call-site
 * identity (invocationCallSiteKey / currentUniqueId — the same identity the
 * credential and logging systems already use; no new identity layer).
 */
export interface ContractObservation {
  /** The bubble (integration) that produced the observation. */
  bubbleName: string;
  /** The `operation` discriminator of the current params, when the bubble has one. */
  operation?: string;
  /** Per-call-site identity: invocationCallSiteKey ?? currentUniqueId. */
  callSiteKey?: string;
  /** The per-invocation variable id BubbleLab hashes for this call site. */
  variableId?: number;
  /**
   * True only when the value came from a REAL performAction execution.
   * Mocked results (test-mode gate) are emitted with grounded: false so the
   * KB can refuse them explicitly — a mock is derived from the declared
   * contract and can never teach the KB anything about reality.
   */
  grounded: boolean;
  /** True when the result was a mock (test-mode gate), never executed. */
  mocked?: boolean;
  /** The bubble-reported success flag of the observed result. */
  success: boolean;
  /** The raw performAction result (or mock data for ungrounded observations). */
  output?: unknown;
  /** Sanitized params of the invocation (credentials removed). */
  input?: unknown;
  /** Present iff the output violated the declared resultSchema. */
  driftFindings?: ContractDriftFinding[];
  /** Present iff the output violated the declared resultSchema. */
  errorCode?: OutputContractViolationCode;
  /** ISO timestamp of the observation. */
  observedAt: string;
}

/**
 * The consumer seam. The API execution service installs a collector sink on
 * ExecutionMeta; BaseBubble.action() calls it for every fresh result. Sink
 * failures never break execution (the emitter catches).
 */
export type ContractObservationSink = (
  observation: ContractObservation
) => void | Promise<void>;

/** Drift surfaced on an ExecutionResult when a violation propagates out of a flow. */
export interface ExecutionDriftRecord {
  bubbleName: string;
  operation?: string;
  callSiteKey?: string;
  findings: ContractDriftFinding[];
}
