/**
 * Errors-as-events unit tests: event schema, bus semantics, policy matching.
 * Design doc: docs/plan/ERRORS-AS-EVENTS-DESIGN.md
 */
import { describe, test, expect, vi } from 'vitest';
import {
  WorkflowEventBus,
  workflowEventSchema,
  workflowEventPolicySchema,
  parseWorkflowEventPolicy,
  resolveReaction,
  eventMatchesRule,
  type WorkflowEvent,
} from './workflow-events.js';

const stepFailed = (overrides: Partial<WorkflowEvent> = {}): WorkflowEvent => ({
  type: 'step_failed',
  code: 'BUBBLE_EXECUTION_ERROR',
  severity: 'error',
  timestamp: new Date().toISOString(),
  stepId: 'slack#1',
  variableId: 7,
  bubbleName: 'slack',
  message: 'boom',
  errorClass: 'BubbleExecutionError',
  payload: { failureMode: 'thrown', attempt: 1 },
  ...overrides,
});

describe('workflowEventSchema', () => {
  test('accepts a valid step_failed event', () => {
    expect(() => workflowEventSchema.parse(stepFailed())).not.toThrow();
  });

  test('rejects an unknown type and an unknown code', () => {
    expect(
      workflowEventSchema.safeParse({ ...stepFailed(), type: 'nope' }).success
    ).toBe(false);
    expect(
      workflowEventSchema.safeParse({ ...stepFailed(), code: 'NOPE' }).success
    ).toBe(false);
  });

  test('narrows payload per type: step_failed requires failureMode', () => {
    expect(
      workflowEventSchema.safeParse({ ...stepFailed(), payload: {} }).success
    ).toBe(false);
  });
});

describe('WorkflowEventBus', () => {
  test('runs type-specific and wildcard handlers in subscription order', async () => {
    const bus = new WorkflowEventBus();
    const order: string[] = [];
    bus.on('step_failed', () => {
      order.push('typed');
    });
    bus.on('*', () => {
      order.push('wildcard');
    });
    await bus.emit(stepFailed());
    expect(order).toEqual(['typed', 'wildcard']);
    expect(bus.emittedCount).toBe(1);
  });

  test('unsubscribe stops delivery', async () => {
    const bus = new WorkflowEventBus();
    const handler = vi.fn();
    const off = bus.on('*', handler);
    await bus.emit(stepFailed());
    off();
    await bus.emit(stepFailed());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('a throwing handler is isolated: later handlers still run, emit never rejects', async () => {
    const bus = new WorkflowEventBus();
    const after = vi.fn();
    bus.on('*', () => {
      throw new Error('handler bug');
    });
    bus.on('*', after);
    await expect(bus.emit(stepFailed())).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
    expect(bus.handlerErrorCount).toBe(1);
  });

  test('a malformed event is dropped, not delivered', async () => {
    const bus = new WorkflowEventBus();
    const handler = vi.fn();
    bus.on('*', handler);
    await bus.emit({ ...stepFailed(), code: 'NOT_A_CODE' } as WorkflowEvent);
    expect(handler).not.toHaveBeenCalled();
    expect(bus.emittedCount).toBe(0);
  });
});

describe('policy schema + resolveReaction', () => {
  test('retry defaults: maxAttempts 3, backoffMs 0, then halt', () => {
    const policy = workflowEventPolicySchema.parse({
      version: 1,
      rules: [{ match: {}, reaction: { kind: 'retry' } }],
    });
    expect(policy.rules[0].reaction).toEqual({
      kind: 'retry',
      maxAttempts: 3,
      backoffMs: 0,
      then: 'halt',
    });
  });

  test('parseWorkflowEventPolicy returns undefined for junk and null', () => {
    expect(parseWorkflowEventPolicy(null)).toBeUndefined();
    expect(parseWorkflowEventPolicy({ version: 2, rules: [] })).toBeUndefined();
    expect(parseWorkflowEventPolicy('not a policy')).toBeUndefined();
    expect(parseWorkflowEventPolicy({ version: 1, rules: [] })).toBeDefined();
  });

  test('match fields AND together; arrays OR within a field', () => {
    const event = stepFailed();
    expect(
      eventMatchesRule(
        { codes: ['BUBBLE_EXECUTION_ERROR', 'BUBBLE_SOFT_FAILURE'] },
        event
      )
    ).toBe(true);
    expect(
      eventMatchesRule(
        { codes: ['BUBBLE_EXECUTION_ERROR'], bubbleNames: ['gmail'] },
        event
      )
    ).toBe(false);
    expect(
      eventMatchesRule(
        { codes: ['BUBBLE_EXECUTION_ERROR'], stepIds: ['slack#1'] },
        event
      )
    ).toBe(true);
    // A stepIds constraint never matches an event without a stepId
    expect(
      eventMatchesRule(
        { stepIds: ['slack#1'] },
        {
          ...event,
          stepId: undefined,
        }
      )
    ).toBe(false);
    // Empty match = matches everything
    expect(eventMatchesRule({}, event)).toBe(true);
  });

  test('first match wins', () => {
    const policy = workflowEventPolicySchema.parse({
      version: 1,
      rules: [
        {
          match: { bubbleNames: ['slack'] },
          reaction: { kind: 'halt' },
        },
        { match: {}, reaction: { kind: 'continue' } },
      ],
    });
    const hit = resolveReaction(policy, stepFailed());
    expect(hit?.ruleIndex).toBe(0);
    expect(hit?.rule.reaction.kind).toBe('halt');
    const other = resolveReaction(
      policy,
      stepFailed({ bubbleName: 'gmail', stepId: 'gmail#1' })
    );
    expect(other?.ruleIndex).toBe(1);
  });

  test('no policy or no matching rule resolves to undefined', () => {
    expect(resolveReaction(undefined, stepFailed())).toBeUndefined();
    const policy = workflowEventPolicySchema.parse({
      version: 1,
      rules: [
        {
          match: { codes: ['RESULT_SCHEMA_DEVIATION'] },
          reaction: { kind: 'halt' },
        },
      ],
    });
    expect(resolveReaction(policy, stepFailed())).toBeUndefined();
  });
});
