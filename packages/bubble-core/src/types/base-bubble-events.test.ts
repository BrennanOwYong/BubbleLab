/**
 * Errors-as-events acceptance tests for BaseBubble.action().
 *
 * The unit under test is the REAL action() lifecycle: events emitted at every
 * failure/success seam, and the declarative reaction policy applied as flow
 * control (halt / continue / retry). The core regression guarantee: with no
 * bus and no policy, behavior is identical to before the feature.
 *
 * Design doc: docs/plan/ERRORS-AS-EVENTS-DESIGN.md
 */
import { z } from 'zod';
import { ServiceBubble } from './service-bubble-class.js';
import type { BubbleContext } from './bubble.js';
import {
  BubbleExecutionError,
  BubbleValidationError,
  FlowHaltedByPolicyError,
} from './bubble-errors.js';
import {
  WorkflowEventBus,
  workflowEventPolicySchema,
  type WorkflowEvent,
  type WorkflowEventPolicy,
} from '@bubblelab/shared-schemas';

// ── Fixture: a bubble whose failure mode is scripted per instance ────────────

const ParamsSchema = z.object({
  /** How many performAction calls fail before one succeeds. */
  failTimes: z.number().default(0),
  /** What a failure looks like. */
  mode: z.enum(['throw', 'soft', 'bad-shape']).default('throw'),
});
const ResultSchema = z.object({
  value: z.string(),
  success: z.boolean(),
  error: z.string(),
});
type Params = z.output<typeof ParamsSchema>;
type Result = z.output<typeof ResultSchema>;

class ScriptedBubble extends ServiceBubble<Params, Result> {
  static readonly bubbleName = 'scripted-events-test-bubble';
  static readonly type = 'service' as const;
  static readonly service = 'test';
  static readonly authType = 'none' as const;
  static readonly schema = ParamsSchema;
  static readonly resultSchema = ResultSchema;
  static readonly shortDescription = 'Scripted failure fixture';
  static readonly longDescription = 'Scripted failure fixture';
  static readonly alias = 'scripted-test';

  static performActionCount = 0;

  constructor(params: z.input<typeof ParamsSchema>, context?: BubbleContext) {
    super(params, context);
  }
  public async testCredential(): Promise<boolean> {
    return true;
  }
  protected chooseCredential(): string | undefined {
    return undefined;
  }
  protected async performAction(): Promise<Result> {
    ScriptedBubble.performActionCount++;
    const failing = ScriptedBubble.performActionCount <= this.params.failTimes;
    if (!failing) {
      return { value: 'ok', success: true, error: '' };
    }
    if (this.params.mode === 'throw') {
      throw new Error('scripted hard failure');
    }
    if (this.params.mode === 'soft') {
      return { value: 'nope', success: false, error: 'scripted soft failure' };
    }
    // bad-shape: violates the result schema (value must be a string)
    return {
      value: 123 as unknown as string,
      success: true,
      error: '',
    };
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

function harness(policy?: WorkflowEventPolicy): {
  bus: WorkflowEventBus;
  events: WorkflowEvent[];
  context: BubbleContext;
} {
  const bus = new WorkflowEventBus();
  const events: WorkflowEvent[] = [];
  bus.on('*', (event) => {
    events.push(event);
  });
  return {
    bus,
    events,
    context: {
      currentUniqueId: 'scripted-events-test-bubble#1',
      variableId: 42,
      executionMeta: { eventBus: bus, eventPolicy: policy },
    },
  };
}

const policyOf = (rules: unknown[]): WorkflowEventPolicy =>
  workflowEventPolicySchema.parse({ version: 1, rules });

const types = (events: WorkflowEvent[]): string[] => events.map((e) => e.type);

beforeEach(() => {
  ScriptedBubble.performActionCount = 0;
});

// ── Regression: no bus, no policy → pre-events behavior ─────────────────────

describe('default behavior unchanged without bus/policy', () => {
  test('hard failure throws BubbleExecutionError', async () => {
    const bubble = new ScriptedBubble({ failTimes: 99, mode: 'throw' });
    await expect(bubble.action()).rejects.toThrow(BubbleExecutionError);
    expect(ScriptedBubble.performActionCount).toBe(1);
  });

  test('soft failure warns and continues (returns success:false)', async () => {
    const bubble = new ScriptedBubble({ failTimes: 99, mode: 'soft' });
    const result = await bubble.action();
    expect(result.success).toBe(false);
    expect(result.error).toBe('scripted soft failure');
  });

  test('result-schema deviation throws BubbleValidationError', async () => {
    const bubble = new ScriptedBubble({ failTimes: 99, mode: 'bad-shape' });
    await expect(bubble.action()).rejects.toThrow(BubbleValidationError);
  });

  test('success returns the BubbleResult envelope', async () => {
    const bubble = new ScriptedBubble({ failTimes: 0 });
    const result = await bubble.action();
    expect(result.success).toBe(true);
    expect(result.data.value).toBe('ok');
  });
});

// ── Telemetry-first: events always emitted alongside the existing path ──────

describe('event emission (no policy)', () => {
  test('success emits step_started then step_succeeded', async () => {
    const { events, context } = harness();
    await new ScriptedBubble({ failTimes: 0 }, context).action();
    expect(types(events)).toEqual(['step_started', 'step_succeeded']);
    expect(events[1].payload).toMatchObject({});
    expect(events[0].stepId).toBe('scripted-events-test-bubble#1');
    expect(events[0].variableId).toBe(42);
  });

  test('hard failure emits step_failed with typed code and STILL throws', async () => {
    const { events, context } = harness();
    const bubble = new ScriptedBubble(
      { failTimes: 99, mode: 'throw' },
      context
    );
    await expect(bubble.action()).rejects.toThrow(BubbleExecutionError);
    expect(types(events)).toEqual(['step_started', 'step_failed']);
    const failed = events[1];
    expect(failed.code).toBe('BUBBLE_EXECUTION_ERROR');
    expect(failed.errorClass).toBe('BubbleExecutionError');
    expect(failed.payload).toMatchObject({ failureMode: 'thrown', attempt: 1 });
  });

  test('soft failure emits step_failed BUBBLE_SOFT_FAILURE and continues', async () => {
    const { events, context } = harness();
    const result = await new ScriptedBubble(
      { failTimes: 99, mode: 'soft' },
      context
    ).action();
    expect(result.success).toBe(false);
    expect(types(events)).toEqual(['step_started', 'step_failed']);
    expect(events[1].code).toBe('BUBBLE_SOFT_FAILURE');
    expect(events[1].payload).toMatchObject({ failureMode: 'soft' });
  });

  test('result deviation emits validation_deviation with the schema diff and throws', async () => {
    const { events, context } = harness();
    const bubble = new ScriptedBubble(
      { failTimes: 99, mode: 'bad-shape' },
      context
    );
    await expect(bubble.action()).rejects.toThrow(BubbleValidationError);
    expect(types(events)).toEqual(['step_started', 'validation_deviation']);
    expect(events[1].code).toBe('RESULT_SCHEMA_DEVIATION');
    expect(
      (events[1].payload as { phase: string; schemaDiff?: string }).phase
    ).toBe('result');
    expect(
      (events[1].payload as { schemaDiff?: string }).schemaDiff
    ).toBeTruthy();
  });

  test('input-schema failure emits validation_deviation (fire-and-forget) and throws', async () => {
    const { events, context } = harness();
    expect(
      () =>
        new ScriptedBubble({ failTimes: 'wrong' as unknown as number }, context)
    ).toThrow(BubbleValidationError);
    // Constructor emit is fire-and-forget: flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));
    expect(types(events)).toEqual(['validation_deviation']);
    expect(events[0].code).toBe('INPUT_SCHEMA_VALIDATION_FAILED');
    expect((events[0].payload as { phase: string }).phase).toBe('input');
  });
});

// ── The policy: errors as declarative conditions ────────────────────────────

describe('reaction policy applied as flow control', () => {
  test('retry: fails twice, third attempt succeeds', async () => {
    const policy = policyOf([
      {
        match: { codes: ['BUBBLE_EXECUTION_ERROR'] },
        reaction: { kind: 'retry', maxAttempts: 3 },
      },
    ]);
    const { events, context } = harness(policy);
    const result = await new ScriptedBubble(
      { failTimes: 2, mode: 'throw' },
      context
    ).action();
    expect(result.success).toBe(true);
    expect(ScriptedBubble.performActionCount).toBe(3);
    expect(types(events)).toEqual([
      'step_started',
      'step_failed',
      'step_retried',
      'step_failed',
      'step_retried',
      'step_succeeded',
    ]);
  });

  test('retry exhausted with then:halt throws FlowHaltedByPolicyError', async () => {
    const policy = policyOf([
      {
        match: { codes: ['BUBBLE_EXECUTION_ERROR'] },
        reaction: { kind: 'retry', maxAttempts: 2, then: 'halt' },
      },
    ]);
    const { events, context } = harness(policy);
    const bubble = new ScriptedBubble(
      { failTimes: 99, mode: 'throw' },
      context
    );
    await expect(bubble.action()).rejects.toThrow(FlowHaltedByPolicyError);
    expect(ScriptedBubble.performActionCount).toBe(2);
    expect(types(events)).toContain('reaction_applied');
  });

  test('retry exhausted with then:continue returns a failed BubbleResult', async () => {
    const policy = policyOf([
      {
        match: { codes: ['BUBBLE_EXECUTION_ERROR'] },
        reaction: { kind: 'retry', maxAttempts: 2, then: 'continue' },
      },
    ]);
    const { context } = harness(policy);
    const result = await new ScriptedBubble(
      { failTimes: 99, mode: 'throw' },
      context
    ).action();
    expect(result.success).toBe(false);
    expect(result.error).toContain('scripted hard failure');
    expect(ScriptedBubble.performActionCount).toBe(2);
  });

  test('continue on hard error suppresses the throw (opt-in only)', async () => {
    const policy = policyOf([
      {
        match: { codes: ['BUBBLE_EXECUTION_ERROR'] },
        reaction: { kind: 'continue' },
      },
    ]);
    const { events, context } = harness(policy);
    const result = await new ScriptedBubble(
      { failTimes: 99, mode: 'throw' },
      context
    ).action();
    expect(result.success).toBe(false);
    expect(types(events)).toEqual([
      'step_started',
      'step_failed',
      'reaction_applied',
    ]);
  });

  test('halt on SOFT failure: the user-declared deviation stops the flow', async () => {
    const policy = policyOf([
      {
        match: { codes: ['BUBBLE_SOFT_FAILURE'] },
        reaction: { kind: 'halt' },
      },
    ]);
    const { context } = harness(policy);
    const bubble = new ScriptedBubble({ failTimes: 99, mode: 'soft' }, context);
    await expect(bubble.action()).rejects.toThrow(FlowHaltedByPolicyError);
  });

  test('retry applies to soft failures too', async () => {
    const policy = policyOf([
      {
        match: { codes: ['BUBBLE_SOFT_FAILURE'] },
        reaction: { kind: 'retry', maxAttempts: 3 },
      },
    ]);
    const { context } = harness(policy);
    const result = await new ScriptedBubble(
      { failTimes: 1, mode: 'soft' },
      context
    ).action();
    expect(result.success).toBe(true);
    expect(ScriptedBubble.performActionCount).toBe(2);
  });

  test('continue on result deviation returns failure instead of throwing', async () => {
    const policy = policyOf([
      {
        match: { codes: ['RESULT_SCHEMA_DEVIATION'] },
        reaction: { kind: 'continue' },
      },
    ]);
    const { context } = harness(policy);
    const result = await new ScriptedBubble(
      { failTimes: 99, mode: 'bad-shape' },
      context
    ).action();
    expect(result.success).toBe(false);
    expect(result.error).toContain('Result schema validation failed');
  });

  test('notify rule leaves flow control at default (soft failure continues)', async () => {
    const policy = policyOf([
      {
        match: { codes: ['BUBBLE_SOFT_FAILURE'] },
        reaction: { kind: 'notify' },
      },
    ]);
    const { context } = harness(policy);
    const result = await new ScriptedBubble(
      { failTimes: 99, mode: 'soft' },
      context
    ).action();
    expect(result.success).toBe(false); // continued, not thrown
  });

  test('trigger_flow with haltAfter halts; without it, default control', async () => {
    const haltPolicy = policyOf([
      {
        match: { codes: ['BUBBLE_SOFT_FAILURE'] },
        reaction: { kind: 'trigger_flow', targetFlowId: 7, haltAfter: true },
      },
    ]);
    const { context } = harness(haltPolicy);
    await expect(
      new ScriptedBubble({ failTimes: 99, mode: 'soft' }, context).action()
    ).rejects.toThrow(FlowHaltedByPolicyError);

    ScriptedBubble.performActionCount = 0;
    const noHaltPolicy = policyOf([
      {
        match: { codes: ['BUBBLE_SOFT_FAILURE'] },
        reaction: { kind: 'trigger_flow', targetFlowId: 7 },
      },
    ]);
    const second = harness(noHaltPolicy);
    const result = await new ScriptedBubble(
      { failTimes: 99, mode: 'soft' },
      second.context
    ).action();
    expect(result.success).toBe(false); // continued
  });

  test('a rule scoped to another bubble does not fire (per-step policy)', async () => {
    const policy = policyOf([
      {
        match: { bubbleNames: ['some-other-bubble'] },
        reaction: { kind: 'continue' },
      },
    ]);
    const { context } = harness(policy);
    const bubble = new ScriptedBubble(
      { failTimes: 99, mode: 'throw' },
      context
    );
    // No matching rule → default behavior: typed throw.
    await expect(bubble.action()).rejects.toThrow(BubbleExecutionError);
  });
});
