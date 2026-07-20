/**
 * Errors as events: one typed event union, one bus, one declarative reaction
 * policy. Every error (and lifecycle transition) in a flow run is emitted as a
 * WorkflowEvent so it can be persisted for agents and matched as a condition,
 * exactly like an if-else branches on a value.
 *
 * Design doc: docs/plan/ERRORS-AS-EVENTS-DESIGN.md
 * References:
 * - Zod discriminated unions: https://zod.dev/?id=discriminated-unions
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Event taxonomy
// ---------------------------------------------------------------------------

export const workflowEventTypes = [
  'flow_started',
  'flow_completed',
  'flow_failed',
  'step_started',
  'step_succeeded',
  'step_failed',
  'step_retried',
  'validation_deviation',
  'reaction_applied',
  'event_bus_error',
] as const;

export const workflowEventTypeSchema = z.enum(workflowEventTypes);
export type WorkflowEventType = z.infer<typeof workflowEventTypeSchema>;

/** Stable machine-branchable codes. Policies and agents branch on these. */
export const workflowEventCodes = [
  'FLOW_STARTED',
  'FLOW_COMPLETED',
  'FLOW_FATAL',
  'FLOW_HALTED_BY_POLICY',
  'STEP_STARTED',
  'STEP_SUCCEEDED',
  'BUBBLE_EXECUTION_ERROR',
  'BUBBLE_SOFT_FAILURE',
  'INPUT_SCHEMA_VALIDATION_FAILED',
  'RESULT_SCHEMA_DEVIATION',
  'STEP_RETRIED',
  'REACTION_APPLIED',
  'EVENT_BUS_ERROR',
] as const;

export const workflowEventCodeSchema = z.enum(workflowEventCodes);
export type WorkflowEventCode = z.infer<typeof workflowEventCodeSchema>;

export const workflowEventSeveritySchema = z.enum([
  'info',
  'warning',
  'error',
  'fatal',
]);
export type WorkflowEventSeverity = z.infer<typeof workflowEventSeveritySchema>;

const baseEventFields = {
  code: workflowEventCodeSchema,
  severity: workflowEventSeveritySchema,
  /** ISO timestamp of emission. */
  timestamp: z.string(),
  /** Call-site identity: currentUniqueId ?? invocationCallSiteKey. */
  stepId: z.string().optional(),
  variableId: z.number().optional(),
  bubbleName: z.string().optional(),
  /** Human-readable, ALWAYS pre-sanitized by the emitter (error-sanitizer). */
  message: z.string(),
  /** Typed error class name when the event wraps an error. */
  errorClass: z.string().optional(),
};

export const workflowEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseEventFields,
    type: z.literal('flow_started'),
    payload: z.object({
      flowId: z.number().optional(),
      executionId: z.number().optional(),
      eventType: z.string().optional(),
    }),
  }),
  z.object({
    ...baseEventFields,
    type: z.literal('flow_completed'),
    payload: z.object({ durationMs: z.number().optional() }),
  }),
  z.object({
    ...baseEventFields,
    type: z.literal('flow_failed'),
    payload: z.object({
      haltedByPolicy: z.boolean().optional(),
      durationMs: z.number().optional(),
    }),
  }),
  z.object({
    ...baseEventFields,
    type: z.literal('step_started'),
    payload: z.object({ operation: z.string().optional() }),
  }),
  z.object({
    ...baseEventFields,
    type: z.literal('step_succeeded'),
    payload: z.object({
      durationMs: z.number().optional(),
      mocked: z.boolean().optional(),
    }),
  }),
  z.object({
    ...baseEventFields,
    type: z.literal('step_failed'),
    payload: z.object({
      /** 'thrown' = performAction threw; 'soft' = returned success:false. */
      failureMode: z.enum(['thrown', 'soft']),
      attempt: z.number().optional(),
    }),
  }),
  z.object({
    ...baseEventFields,
    type: z.literal('step_retried'),
    payload: z.object({
      attempt: z.number(),
      maxAttempts: z.number(),
      backoffMs: z.number(),
    }),
  }),
  z.object({
    ...baseEventFields,
    type: z.literal('validation_deviation'),
    payload: z.object({
      phase: z.enum(['input', 'result']),
      /** formatSchemaExpectedVsActual diff, sanitized. */
      schemaDiff: z.string().optional(),
    }),
  }),
  z.object({
    ...baseEventFields,
    type: z.literal('reaction_applied'),
    payload: z.object({
      reaction: z.string(),
      ruleIndex: z.number(),
      detail: z.record(z.unknown()).optional(),
    }),
  }),
  z.object({
    ...baseEventFields,
    type: z.literal('event_bus_error'),
    payload: z.object({ source: z.string() }),
  }),
]);

export type WorkflowEvent = z.infer<typeof workflowEventSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Emitter-side input: the discriminated payload narrowing is preserved while
 * the identity/context fields (stepId, variableId, bubbleName, timestamp) are
 * optional — the emitter (e.g. BaseBubble) fills them from its context.
 */
export type WorkflowEventInput = DistributiveOmit<
  WorkflowEvent,
  'timestamp' | 'stepId' | 'variableId' | 'bubbleName'
> & {
  timestamp?: string;
  stepId?: string;
  variableId?: number;
  bubbleName?: string;
};

// ---------------------------------------------------------------------------
// Reaction policy: errors as declarative conditions
// ---------------------------------------------------------------------------

export const workflowReactionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('halt'), message: z.string().optional() }),
  z.object({ kind: z.literal('continue') }),
  z.object({
    kind: z.literal('retry'),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    backoffMs: z.number().int().min(0).max(60_000).default(0),
    /** Applied after retries are exhausted. Defaults to today's behavior. */
    then: z.enum(['halt', 'continue']).default('halt'),
  }),
  z.object({
    kind: z.literal('notify'),
    webhookUrl: z.string().url().optional(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal('trigger_flow'),
    targetFlowId: z.number().int(),
    /** When true the source flow also halts; default keeps current behavior. */
    haltAfter: z.boolean().default(false),
  }),
]);
export type WorkflowReaction = z.infer<typeof workflowReactionSchema>;

/** All present fields must match (AND); arrays are OR within a field. */
export const workflowEventMatchSchema = z.object({
  types: z.array(workflowEventTypeSchema).optional(),
  codes: z.array(workflowEventCodeSchema).optional(),
  stepIds: z.array(z.string()).optional(),
  bubbleNames: z.array(z.string()).optional(),
  severities: z.array(workflowEventSeveritySchema).optional(),
});
export type WorkflowEventMatch = z.infer<typeof workflowEventMatchSchema>;

export const workflowPolicyRuleSchema = z.object({
  description: z.string().optional(),
  match: workflowEventMatchSchema,
  reaction: workflowReactionSchema,
});
export type WorkflowPolicyRule = z.infer<typeof workflowPolicyRuleSchema>;

export const workflowEventPolicySchema = z.object({
  version: z.literal(1),
  rules: z.array(workflowPolicyRuleSchema),
});
export type WorkflowEventPolicy = z.infer<typeof workflowEventPolicySchema>;

export function eventMatchesRule(
  match: WorkflowEventMatch,
  event: WorkflowEvent
): boolean {
  if (match.types && !match.types.includes(event.type)) return false;
  if (match.codes && !match.codes.includes(event.code)) return false;
  if (match.severities && !match.severities.includes(event.severity)) {
    return false;
  }
  if (match.stepIds) {
    if (event.stepId === undefined || !match.stepIds.includes(event.stepId)) {
      return false;
    }
  }
  if (match.bubbleNames) {
    if (
      event.bubbleName === undefined ||
      !match.bubbleNames.includes(event.bubbleName)
    ) {
      return false;
    }
  }
  return true;
}

export interface ResolvedReaction {
  rule: WorkflowPolicyRule;
  ruleIndex: number;
}

/** First-match-wins over the policy's rules. Pure. */
export function resolveReaction(
  policy: WorkflowEventPolicy | undefined,
  event: WorkflowEvent
): ResolvedReaction | undefined {
  if (!policy) return undefined;
  for (let i = 0; i < policy.rules.length; i++) {
    if (eventMatchesRule(policy.rules[i].match, event)) {
      return { rule: policy.rules[i], ruleIndex: i };
    }
  }
  return undefined;
}

/** Parse an unknown value (e.g. a DB JSON column) into a policy, or undefined. */
export function parseWorkflowEventPolicy(
  value: unknown
): WorkflowEventPolicy | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = workflowEventPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------------------
// The bus
// ---------------------------------------------------------------------------

export type WorkflowEventHandler = (
  event: WorkflowEvent
) => void | Promise<void>;

/**
 * One bus per flow execution. Handlers run sequentially in subscription order
 * so persistence ordering matches emission ordering. A handler that throws is
 * counted and logged, never allowed to break the flow: the bus is telemetry
 * infrastructure, not a failure source.
 */
export class WorkflowEventBus {
  private handlers = new Map<WorkflowEventType | '*', WorkflowEventHandler[]>();
  /** Telemetry about the machinery itself. */
  public emittedCount = 0;
  public handlerErrorCount = 0;

  on(type: WorkflowEventType | '*', handler: WorkflowEventHandler): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return () => {
      const current = this.handlers.get(type) ?? [];
      const idx = current.indexOf(handler);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  async emit(event: WorkflowEvent): Promise<void> {
    const validated = workflowEventSchema.safeParse(event);
    if (!validated.success) {
      // Malformed events are a machinery bug: surface loudly, never throw.
      this.handlerErrorCount++;
      console.error(
        '[WorkflowEventBus] dropping malformed event:',
        validated.error.message
      );
      return;
    }
    this.emittedCount++;
    const targets = [
      ...(this.handlers.get(event.type) ?? []),
      ...(this.handlers.get('*') ?? []),
    ];
    for (const handler of targets) {
      try {
        await handler(validated.data);
      } catch (error) {
        this.handlerErrorCount++;
        console.error(
          `[WorkflowEventBus] handler failed for ${event.type}/${event.code}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }
}
