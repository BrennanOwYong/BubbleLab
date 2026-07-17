/**
 * Custom error classes for bubble operations
 * These errors carry metadata like variableId to enable better error tracking and logging
 */
import {
  OUTPUT_CONTRACT_VIOLATION,
  type ContractDriftFinding,
  type OutputContractViolationCode,
} from '@bubblelab/shared-schemas';

/**
 * Base error class for all bubble-related errors
 * Includes variableId and bubbleName for context tracking
 */
export class BubbleError extends Error {
  public readonly variableId?: number;
  public readonly bubbleName?: string;

  constructor(
    message: string,
    options?: {
      variableId?: number;
      bubbleName?: string;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = 'BubbleError';
    this.variableId = options?.variableId;
    this.bubbleName = options?.bubbleName;

    // Maintain proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }

    // Attach the original cause if provided
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * Thrown when bubble parameter validation fails
 * Used in BaseBubble constructor when schema.parse() fails
 */
export class BubbleValidationError extends BubbleError {
  public readonly validationErrors?: string[];

  constructor(
    message: string,
    options?: {
      variableId?: number;
      bubbleName?: string;
      validationErrors?: string[];
      cause?: Error;
    }
  ) {
    super(message, options);
    this.name = 'BubbleValidationError';
    this.validationErrors = options?.validationErrors;
  }
}

/**
 * Thrown when a REAL performAction response violates the bubble's declared
 * resultSchema — contract drift (IR-11/12). Distinct and identifiable by its
 * stable `code` (OUTPUT_CONTRACT_VIOLATION) so the signal survives every
 * wrapper boundary instead of collapsing into a generic validation failure
 * (the reference-build bug this class exists to fix: the drift code was
 * thrown by the adapter but nothing downstream could tell it apart from any
 * other failure, so nothing consumed it).
 *
 * Extends BubbleValidationError so every existing
 * `instanceof BubbleValidationError` branch keeps working; consumers that
 * care about drift check `instanceof BubbleOutputContractViolationError`
 * (or the `code`) FIRST.
 */
export class BubbleOutputContractViolationError extends BubbleValidationError {
  public readonly code: OutputContractViolationCode =
    OUTPUT_CONTRACT_VIOLATION;
  /** Structural mismatches between the observed value and the declared schema. */
  public readonly driftFindings: ContractDriftFinding[];
  /** The raw performAction result that violated the contract. */
  public readonly observedOutput: unknown;
  /** The `operation` discriminator of the invocation, when present. */
  public readonly operation?: string;
  /** Per-call-site identity (invocationCallSiteKey ?? currentUniqueId). */
  public readonly callSiteKey?: string;

  constructor(
    message: string,
    options: {
      driftFindings: ContractDriftFinding[];
      observedOutput: unknown;
      operation?: string;
      callSiteKey?: string;
      variableId?: number;
      bubbleName?: string;
      cause?: Error;
    }
  ) {
    super(message, {
      variableId: options.variableId,
      bubbleName: options.bubbleName,
      validationErrors: options.driftFindings.map(
        (finding) => `${finding.path}: ${finding.message}`
      ),
      cause: options.cause,
    });
    this.name = 'BubbleOutputContractViolationError';
    this.driftFindings = options.driftFindings;
    this.observedOutput = options.observedOutput;
    this.operation = options.operation;
    this.callSiteKey = options.callSiteKey;
  }
}

/**
 * Thrown when bubble execution fails during performAction
 * Used in BaseBubble.action() when the operation fails
 */
export class BubbleExecutionError extends BubbleError {
  public readonly executionPhase?: 'instantiation' | 'execution' | 'validation';

  constructor(
    message: string,
    options?: {
      variableId?: number;
      bubbleName?: string;
      executionPhase?: 'instantiation' | 'execution' | 'validation';
      cause?: Error;
    }
  ) {
    super(message, options);
    this.name = 'BubbleExecutionError';
    this.executionPhase = options?.executionPhase;
  }
}
