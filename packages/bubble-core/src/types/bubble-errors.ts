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

/**
 * Thrown when a user-declared event-reaction policy says a deviation halts the
 * flow (errors-as-events). Extends BubbleError so every existing catch branch
 * (BubbleRunner and generated try/catch) handles it without changes.
 */
export class FlowHaltedByPolicyError extends BubbleError {
  /** The WorkflowEventCode of the event that matched the halting rule. */
  public readonly eventCode?: string;
  /** Index of the matched rule inside the flow's event policy. */
  public readonly ruleIndex?: number;

  constructor(
    message: string,
    options?: {
      variableId?: number;
      bubbleName?: string;
      eventCode?: string;
      ruleIndex?: number;
      cause?: Error;
    }
  ) {
    super(message, options);
    this.name = 'FlowHaltedByPolicyError';
    this.eventCode = options?.eventCode;
    this.ruleIndex = options?.ruleIndex;
  }
}
