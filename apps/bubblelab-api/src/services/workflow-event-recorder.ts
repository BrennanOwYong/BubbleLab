/**
 * Errors-as-events, API layer: per-execution subscribers on the
 * WorkflowEventBus.
 *
 * 1. persist  — every event becomes a workflow_events row (telemetry-first:
 *               written before any reaction runs, never fails the flow).
 * 2. bridge   — every event is forwarded into the existing StreamingLogEvent
 *               collection path as type 'workflow_event', so it lands in
 *               bubble_flow_executions.executionLogs and the SSE stream with
 *               zero extra plumbing.
 * 3. reactor  — EXTERNAL reactions (notify, trigger_flow dispatch) for
 *               failure-class events. Flow-control reactions (halt, continue,
 *               retry) are applied inside BaseBubble.action(); this side only
 *               performs effects that need DB access / user identity.
 *
 * Design doc: docs/plan/ERRORS-AS-EVENTS-DESIGN.md
 */
import { db } from '../db/index.js';
import { workflowEvents } from '../db/schema.js';
import {
  resolveReaction,
  type StreamCallback,
  type WorkflowEvent,
  type WorkflowEventBus,
  type WorkflowEventPolicy,
} from '@bubblelab/shared-schemas';

/** Failure-class events the reactor consults the policy for. */
const REACTABLE_TYPES: ReadonlySet<WorkflowEvent['type']> = new Set([
  'step_failed',
  'validation_deviation',
  'flow_failed',
]);

/** Max chained trigger_flow hops; guards against trigger loops. */
export const MAX_TRIGGER_DEPTH = 2;

export interface TriggerFlowRequest {
  targetFlowId: number;
  userId: string;
  /** Depth of the CURRENT execution (target runs at depth + 1). */
  currentDepth: number;
  sourceEvent: WorkflowEvent;
  sourceExecutionId: number;
  sourceFlowId: number;
}

export interface WorkflowEventSubscriberOptions {
  executionId: number;
  bubbleFlowId: number;
  userId: string;
  policy?: WorkflowEventPolicy;
  /** The existing collection callback (executionLogs + SSE). */
  streamCallback?: StreamCallback;
  /** Depth of this execution in a trigger_flow chain (0 = user-initiated). */
  triggerDepth?: number;
  /**
   * Dispatches the target flow of a trigger_flow reaction. Injected by the
   * execution service to avoid a circular import.
   */
  triggerFlow?: (request: TriggerFlowRequest) => Promise<void>;
}

export async function persistWorkflowEvent(
  executionId: number,
  bubbleFlowId: number,
  event: WorkflowEvent
): Promise<void> {
  await db.insert(workflowEvents).values({
    executionId,
    bubbleFlowId,
    type: event.type,
    code: event.code,
    severity: event.severity,
    stepId: event.stepId ?? null,
    variableId: event.variableId ?? null,
    bubbleName: event.bubbleName ?? null,
    message: event.message,
    errorClass: event.errorClass ?? null,
    payload: event.payload,
    timestamp: new Date(event.timestamp),
  });
}

/**
 * Wire the three subscribers onto a per-execution bus. Returns the bus for
 * chaining.
 */
export function attachWorkflowEventSubscribers(
  bus: WorkflowEventBus,
  options: WorkflowEventSubscriberOptions
): WorkflowEventBus {
  const {
    executionId,
    bubbleFlowId,
    userId,
    policy,
    streamCallback,
    triggerDepth = 0,
    triggerFlow,
  } = options;

  // 1. Persist — telemetry-first, ordered before bridge/reactor by
  //    subscription order (the bus runs handlers sequentially).
  bus.on('*', async (event) => {
    try {
      await persistWorkflowEvent(executionId, bubbleFlowId, event);
    } catch (error) {
      // A persistence failure must never fail the execution.
      console.error(
        '[workflow-event-recorder] failed to persist event',
        event.type,
        event.code,
        error instanceof Error ? error.message : error
      );
    }
  });

  // 2. Bridge into the existing StreamingLogEvent path.
  if (streamCallback) {
    bus.on('*', async (event) => {
      await streamCallback({
        type: 'workflow_event',
        timestamp: event.timestamp,
        variableId: event.variableId,
        bubbleName: event.bubbleName,
        message: `[${event.severity}] ${event.code}: ${event.message}`,
        workflowEvent: event,
      });
    });
  }

  // 3. Reactor — external reactions for failure-class events.
  bus.on('*', async (event) => {
    if (!REACTABLE_TYPES.has(event.type)) return;
    const resolved = resolveReaction(policy, event);
    if (!resolved) return;
    const { rule, ruleIndex } = resolved;

    if (rule.reaction.kind === 'notify') {
      const notifyMessage =
        rule.reaction.message ??
        `[bubblelab] flow ${bubbleFlowId} execution ${executionId}: ${event.code} at ${event.bubbleName ?? 'flow'} — ${event.message}`;
      let delivered = false;
      if (rule.reaction.webhookUrl) {
        try {
          const response = await fetch(rule.reaction.webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              source: 'bubblelab.workflow_events',
              flowId: bubbleFlowId,
              executionId,
              event,
              message: notifyMessage,
            }),
            signal: AbortSignal.timeout(5000),
          });
          delivered = response.ok;
        } catch (error) {
          console.error(
            '[workflow-event-recorder] notify webhook failed:',
            error instanceof Error ? error.message : error
          );
        }
      }
      await emitReaction(bus, event, 'notify', ruleIndex, {
        webhookUrl: rule.reaction.webhookUrl,
        delivered,
        // Without a webhook the notification is the streamed + persisted
        // reaction_applied event itself (surfaced by the studio/agents).
        channel: rule.reaction.webhookUrl ? 'webhook' : 'stream',
      });
      return;
    }

    if (rule.reaction.kind === 'trigger_flow') {
      if (triggerDepth >= MAX_TRIGGER_DEPTH) {
        await emitReaction(bus, event, 'trigger_flow', ruleIndex, {
          targetFlowId: rule.reaction.targetFlowId,
          dispatched: false,
          reason: `depth_limit_reached (${triggerDepth}/${MAX_TRIGGER_DEPTH})`,
        });
        return;
      }
      if (!triggerFlow) {
        await emitReaction(bus, event, 'trigger_flow', ruleIndex, {
          targetFlowId: rule.reaction.targetFlowId,
          dispatched: false,
          reason: 'no_trigger_dispatcher_wired',
        });
        return;
      }
      // Fire-and-forget: the triggered flow must not block or fail the
      // source flow. Its own execution gets its own row, bus, and events.
      void triggerFlow({
        targetFlowId: rule.reaction.targetFlowId,
        userId,
        currentDepth: triggerDepth,
        sourceEvent: event,
        sourceExecutionId: executionId,
        sourceFlowId: bubbleFlowId,
      }).catch((error) => {
        console.error(
          '[workflow-event-recorder] trigger_flow dispatch failed:',
          error instanceof Error ? error.message : error
        );
      });
      await emitReaction(bus, event, 'trigger_flow', ruleIndex, {
        targetFlowId: rule.reaction.targetFlowId,
        dispatched: true,
        depth: triggerDepth + 1,
      });
    }
    // halt / continue / retry: flow-control — applied in BaseBubble.action().
  });

  return bus;
}

async function emitReaction(
  bus: WorkflowEventBus,
  source: WorkflowEvent,
  reaction: string,
  ruleIndex: number,
  detail: Record<string, unknown>
): Promise<void> {
  await bus.emit({
    type: 'reaction_applied',
    code: 'REACTION_APPLIED',
    severity: 'info',
    timestamp: new Date().toISOString(),
    stepId: source.stepId,
    variableId: source.variableId,
    bubbleName: source.bubbleName,
    message: `Policy rule ${ruleIndex} applied external reaction '${reaction}' to ${source.code}`,
    payload: {
      reaction,
      ruleIndex,
      detail: { ...detail, sourceType: source.type, sourceCode: source.code },
    },
  });
}
