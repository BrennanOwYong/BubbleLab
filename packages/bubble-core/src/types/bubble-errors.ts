/**
 * Custom error classes for bubble operations
 * These errors carry metadata like variableId to enable better error tracking and logging
 */

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
 * Contract drift: a REAL response violated the bubble's declared resultSchema.
 *
 * Distinct from input validation and from generic execution failure — the
 * declared contract and observed reality disagree, which is the Contract KB's
 * docs-are-wrong signal (HANDOFF §9: the reference build collapsed this into
 * a generic failure at the wrapper boundary and nothing could consume it).
 *
 * The DISTINCT identity is the `code` property ('OUTPUT_MISMATCH'), not the
 * class: boundaries that cross module instances (the temp-file import in
 * BubbleRunner) must check `code`/`name`, never rely on instanceof alone.
 * Extends BubbleValidationError so existing catch sites keep working.
 */
export class BubbleDriftError extends BubbleValidationError {
  public readonly code = 'OUTPUT_MISMATCH';
  public readonly operation?: string;
  public readonly callSiteKey?: string;
  /** Every schema deviation, as { path, message }. */
  public readonly deviations: Array<{ path: string; message: string }>;

  constructor(
    message: string,
    options?: {
      variableId?: number;
      bubbleName?: string;
      operation?: string;
      callSiteKey?: string;
      deviations?: Array<{ path: string; message: string }>;
      cause?: Error;
    }
  ) {
    super(message, options);
    this.name = 'BubbleDriftError';
    this.operation = options?.operation;
    this.callSiteKey = options?.callSiteKey;
    this.deviations = options?.deviations ?? [];
  }
}

/**
 * Structural drift check that survives module-instance boundaries: the
 * generated temp-file flow links its own bubble-core module, so instanceof
 * fails across it; the code/name pair does not.
 */
export function isDriftError(error: unknown): error is BubbleDriftError {
  if (error instanceof BubbleDriftError) return true;
  if (!(error instanceof Error)) return false;
  return (
    (error as { code?: unknown }).code === 'OUTPUT_MISMATCH' ||
    error.name === 'BubbleDriftError'
  );
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
