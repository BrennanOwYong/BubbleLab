/**
 * Errors-as-events API tests: policy endpoint, event persistence, event
 * inspection endpoint, and the external reactor (notify / trigger_flow guard).
 * Design doc: docs/plan/ERRORS-AS-EVENTS-DESIGN.md
 */
// @ts-expect-error bun:test is not in TypeScript definitions
import { describe, test, expect, beforeEach } from 'bun:test';
import { TestApp } from '../test/test-app.js';
import { TEST_USER_ID } from '../test/setup.js';
import { db } from '../db/index.js';
import {
  bubbleFlows,
  bubbleFlowExecutions,
  workflowEvents,
} from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  WorkflowEventBus,
  workflowEventPolicySchema,
  type WorkflowEvent,
} from '@bubblelab/shared-schemas';
import {
  attachWorkflowEventSubscribers,
  MAX_TRIGGER_DEPTH,
  type TriggerFlowRequest,
} from '../services/workflow-event-recorder.js';

async function seedFlow(): Promise<number> {
  const rows = await db
    .insert(bubbleFlows)
    .values({
      userId: TEST_USER_ID,
      name: 'events-test-flow',
      description: 'errors-as-events test flow',
      code: 'export {}',
      eventType: 'webhook/http',
    })
    .returning();
  return rows[0].id;
}

async function seedExecution(flowId: number): Promise<number> {
  const rows = await db
    .insert(bubbleFlowExecutions)
    .values({ bubbleFlowId: flowId, payload: {}, status: 'running' })
    .returning();
  return rows[0].id;
}

const stepFailedEvent = (
  overrides: Partial<WorkflowEvent> = {}
): WorkflowEvent =>
  ({
    type: 'step_failed',
    code: 'BUBBLE_EXECUTION_ERROR',
    severity: 'error',
    timestamp: new Date().toISOString(),
    stepId: 'slack#1',
    variableId: 3,
    bubbleName: 'slack',
    message: 'boom',
    errorClass: 'BubbleExecutionError',
    payload: { failureMode: 'thrown', attempt: 1 },
    ...overrides,
  }) as WorkflowEvent;

describe('PUT /bubble-flow/:id/event-policy', () => {
  test('stores a valid policy on the flow', async () => {
    const flowId = await seedFlow();
    const policy = {
      version: 1,
      rules: [
        {
          match: { codes: ['BUBBLE_SOFT_FAILURE'] },
          reaction: { kind: 'halt' },
        },
      ],
    };
    const res = await TestApp.request(`/bubble-flow/${flowId}/event-policy`, {
      method: 'PUT',
      body: { policy },
    });
    expect(res.status).toBe(200);

    const flow = await db.query.bubbleFlows.findFirst({
      where: eq(bubbleFlows.id, flowId),
    });
    const stored = workflowEventPolicySchema.parse(flow?.eventPolicy);
    expect(stored.rules[0].reaction.kind).toBe('halt');
  });

  test('rejects an invalid policy with 400', async () => {
    const flowId = await seedFlow();
    const res = await TestApp.request(`/bubble-flow/${flowId}/event-policy`, {
      method: 'PUT',
      body: {
        policy: {
          version: 1,
          rules: [{ match: {}, reaction: { kind: 'explode' } }],
        },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid event policy');
  });

  test('null clears the policy', async () => {
    const flowId = await seedFlow();
    await TestApp.request(`/bubble-flow/${flowId}/event-policy`, {
      method: 'PUT',
      body: { policy: { version: 1, rules: [] } },
    });
    const res = await TestApp.request(`/bubble-flow/${flowId}/event-policy`, {
      method: 'PUT',
      body: { policy: null },
    });
    expect(res.status).toBe(200);
    const flow = await db.query.bubbleFlows.findFirst({
      where: eq(bubbleFlows.id, flowId),
    });
    expect(flow?.eventPolicy).toBeNull();
  });

  test('404 for a flow the user does not own', async () => {
    const res = await TestApp.request(`/bubble-flow/999999/event-policy`, {
      method: 'PUT',
      body: { policy: null },
    });
    expect(res.status).toBe(404);
  });
});

describe('event persistence + GET /bubble-flow/:id/events', () => {
  test('every emitted event becomes a workflow_events row, inspectable via the API', async () => {
    const flowId = await seedFlow();
    const executionId = await seedExecution(flowId);
    const bus = new WorkflowEventBus();
    attachWorkflowEventSubscribers(bus, {
      executionId,
      bubbleFlowId: flowId,
      userId: TEST_USER_ID,
    });

    await bus.emit(stepFailedEvent());
    await bus.emit(
      stepFailedEvent({
        type: 'validation_deviation',
        code: 'RESULT_SCHEMA_DEVIATION',
        errorClass: 'BubbleValidationError',
        payload: { phase: 'result', schemaDiff: 'expected string, got number' },
      })
    );

    const rows = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.executionId, executionId));
    expect(rows.length).toBe(2);
    expect(rows[0].code).toBe('BUBBLE_EXECUTION_ERROR');
    expect(rows[0].message).toBe('boom');
    expect(rows[1].code).toBe('RESULT_SCHEMA_DEVIATION');

    const res = await TestApp.request(
      `/bubble-flow/${flowId}/events?executionId=${executionId}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ code: string; errorClass: string | null }>;
    };
    expect(body.events.length).toBe(2);
    // Newest first
    expect(body.events[0].code).toBe('RESULT_SCHEMA_DEVIATION');
    expect(body.events[1].errorClass).toBe('BubbleExecutionError');
  });

  test('a failing insert never breaks emit (telemetry must not fail the flow)', async () => {
    const flowId = await seedFlow();
    const bus = new WorkflowEventBus();
    // Nonexistent execution id → FK violation inside the persist handler
    attachWorkflowEventSubscribers(bus, {
      executionId: 99999999,
      bubbleFlowId: flowId,
      userId: TEST_USER_ID,
    });
    await expect(bus.emit(stepFailedEvent())).resolves.toBeUndefined();
  });
});

describe('external reactor', () => {
  test('notify without webhook records a reaction_applied event (channel stream)', async () => {
    const flowId = await seedFlow();
    const executionId = await seedExecution(flowId);
    const bus = new WorkflowEventBus();
    attachWorkflowEventSubscribers(bus, {
      executionId,
      bubbleFlowId: flowId,
      userId: TEST_USER_ID,
      policy: workflowEventPolicySchema.parse({
        version: 1,
        rules: [
          {
            match: { codes: ['BUBBLE_EXECUTION_ERROR'] },
            reaction: { kind: 'notify' },
          },
        ],
      }),
    });

    await bus.emit(stepFailedEvent());

    const rows = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.executionId, executionId));
    const reaction = rows.find((r) => r.type === 'reaction_applied');
    expect(reaction).toBeDefined();
    expect(
      (reaction?.payload as { detail?: { channel?: string } })?.detail?.channel
    ).toBe('stream');
  });

  test('trigger_flow dispatches through the injected dispatcher with depth+1', async () => {
    const flowId = await seedFlow();
    const executionId = await seedExecution(flowId);
    const bus = new WorkflowEventBus();
    const dispatched: TriggerFlowRequest[] = [];
    attachWorkflowEventSubscribers(bus, {
      executionId,
      bubbleFlowId: flowId,
      userId: TEST_USER_ID,
      triggerDepth: 0,
      triggerFlow: async (request) => {
        dispatched.push(request);
      },
      policy: workflowEventPolicySchema.parse({
        version: 1,
        rules: [
          {
            match: { codes: ['BUBBLE_EXECUTION_ERROR'] },
            reaction: { kind: 'trigger_flow', targetFlowId: 4242 },
          },
        ],
      }),
    });

    await bus.emit(stepFailedEvent());

    expect(dispatched.length).toBe(1);
    expect(dispatched[0].targetFlowId).toBe(4242);
    expect(dispatched[0].currentDepth).toBe(0);
    expect(dispatched[0].userId).toBe(TEST_USER_ID);

    const rows = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.executionId, executionId));
    const reaction = rows.find((r) => r.type === 'reaction_applied');
    expect(
      (reaction?.payload as { detail?: { dispatched?: boolean } })?.detail
        ?.dispatched
    ).toBe(true);
  });

  test('trigger_flow at the depth limit is blocked, recorded as not dispatched', async () => {
    const flowId = await seedFlow();
    const executionId = await seedExecution(flowId);
    const bus = new WorkflowEventBus();
    const dispatched: TriggerFlowRequest[] = [];
    attachWorkflowEventSubscribers(bus, {
      executionId,
      bubbleFlowId: flowId,
      userId: TEST_USER_ID,
      triggerDepth: MAX_TRIGGER_DEPTH,
      triggerFlow: async (request) => {
        dispatched.push(request);
      },
      policy: workflowEventPolicySchema.parse({
        version: 1,
        rules: [
          {
            match: { codes: ['BUBBLE_EXECUTION_ERROR'] },
            reaction: { kind: 'trigger_flow', targetFlowId: 4242 },
          },
        ],
      }),
    });

    await bus.emit(stepFailedEvent());

    expect(dispatched.length).toBe(0);
    const rows = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.executionId, executionId));
    const reaction = rows.find((r) => r.type === 'reaction_applied');
    const detail = (
      reaction?.payload as {
        detail?: { dispatched?: boolean; reason?: string };
      }
    )?.detail;
    expect(detail?.dispatched).toBe(false);
    expect(detail?.reason).toContain('depth_limit_reached');
  });

  test('events are bridged into the stream callback as workflow_event entries', async () => {
    const flowId = await seedFlow();
    const executionId = await seedExecution(flowId);
    const bus = new WorkflowEventBus();
    const streamed: Array<{ type: string; workflowEvent?: WorkflowEvent }> = [];
    attachWorkflowEventSubscribers(bus, {
      executionId,
      bubbleFlowId: flowId,
      userId: TEST_USER_ID,
      streamCallback: (event) => {
        streamed.push({ type: event.type, workflowEvent: event.workflowEvent });
      },
    });

    await bus.emit(stepFailedEvent());

    expect(streamed.length).toBe(1);
    expect(streamed[0].type).toBe('workflow_event');
    expect(streamed[0].workflowEvent?.code).toBe('BUBBLE_EXECUTION_ERROR');
  });
});
