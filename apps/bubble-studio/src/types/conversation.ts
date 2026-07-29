/**
 * Local conversation-message types for VIEWING a flow's persisted
 * metadata.conversationMessages thread.
 *
 * The studio no longer generates flows; an external agent writes these
 * messages. The Coffee schemas were removed from @bubblelab/shared-schemas
 * together with the generation pipeline, so the studio keeps its own lenient
 * copy of the persisted message shapes here — read-only rendering (the
 * Conversation tab) and checklist plan-fallback derivation are the only
 * consumers.
 */
import { z } from 'zod';

export const ClarificationChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export const ClarificationQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  choices: z.array(ClarificationChoiceSchema),
  context: z.string().optional(),
  allowMultiple: z.boolean().optional(),
});

export const PlanStepSchema = z.object({
  title: z.string(),
  description: z.string(),
  bubblesUsed: z.array(z.string()).optional(),
});

export const ConversationPlanSchema = z
  .object({
    summary: z.string(),
    steps: z.array(PlanStepSchema),
    estimatedBubbles: z.array(z.string()).default([]),
  })
  .passthrough();

const BaseMessageSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
});

export const UserMessageSchema = BaseMessageSchema.extend({
  type: z.literal('user'),
  content: z.string(),
});

export const AssistantMessageSchema = BaseMessageSchema.extend({
  type: z.literal('assistant'),
  content: z.string(),
});

export const ClarificationRequestMessageSchema = BaseMessageSchema.extend({
  type: z.literal('clarification_request'),
  questions: z.array(ClarificationQuestionSchema),
});

export const ClarificationResponseMessageSchema = BaseMessageSchema.extend({
  type: z.literal('clarification_response'),
  answers: z.record(z.string(), z.array(z.string())),
  originalQuestions: z.array(ClarificationQuestionSchema).optional(),
});

export const ContextRequestMessageSchema = BaseMessageSchema.extend({
  type: z.literal('context_request'),
  request: z.object({ description: z.string() }).passthrough(),
});

export const ContextResponseMessageSchema = BaseMessageSchema.extend({
  type: z.literal('context_response'),
  answer: z
    .object({ status: z.enum(['success', 'rejected', 'error']) })
    .passthrough(),
});

export const PlanMessageSchema = BaseMessageSchema.extend({
  type: z.literal('plan'),
  plan: ConversationPlanSchema,
});

export const PlanApprovalMessageSchema = BaseMessageSchema.extend({
  type: z.literal('plan_approval'),
  approved: z.boolean(),
  comment: z.string().optional(),
});

export const SystemMessageSchema = BaseMessageSchema.extend({
  type: z.literal('system'),
  content: z.string(),
});

export const ToolResultMessageSchema = BaseMessageSchema.extend({
  type: z.literal('tool_result'),
  toolName: z.string(),
  success: z.boolean(),
});

/** Union of persisted conversation message shapes the studio renders */
export const ConversationMessageSchema = z.discriminatedUnion('type', [
  UserMessageSchema,
  AssistantMessageSchema,
  ClarificationRequestMessageSchema,
  ClarificationResponseMessageSchema,
  ContextRequestMessageSchema,
  ContextResponseMessageSchema,
  PlanMessageSchema,
  PlanApprovalMessageSchema,
  SystemMessageSchema,
  ToolResultMessageSchema,
]);

export type ClarificationChoice = z.infer<typeof ClarificationChoiceSchema>;
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanMessage = z.infer<typeof PlanMessageSchema>;
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
