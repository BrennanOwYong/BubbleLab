/**
 * Plain-language checklist derivation for the Checklist tab.
 *
 * Primary source: the flow's parsed `workflow` step graph (function_call /
 * transformation_function nodes carry human-readable descriptions written at
 * generation time). Fallback source: the approved plan inside the flow's
 * saved conversation thread (metadata.conversationMessages).
 */
import {
  CoffeeMessageSchema,
  type CoffeeMessage,
  type ParsedWorkflow,
  type PlanMessage,
} from '@bubblelab/shared-schemas';
import { extractStepGraph } from './workflowToSteps';

export interface ChecklistItem {
  id: string;
  /** One human-readable line describing what this step does */
  text: string;
  /** Friendly names of the tools (bubbles) the step uses */
  tools: string[];
}

/**
 * Parse the conversation thread persisted on a flow's metadata.
 * Validates each entry against CoffeeMessageSchema individually so one
 * unknown message shape does not drop the whole thread.
 */
export function parseConversationMessages(
  metadata: Record<string, unknown> | undefined
): CoffeeMessage[] {
  const raw = metadata?.conversationMessages;
  if (!Array.isArray(raw)) return [];

  const messages: CoffeeMessage[] = [];
  for (const entry of raw) {
    const parsed = CoffeeMessageSchema.safeParse(entry);
    if (parsed.success) {
      messages.push(parsed.data);
    }
  }
  return messages;
}

/** Latest plan message in the thread (the plan the user approved), if any */
export function findPlanMessage(
  messages: CoffeeMessage[]
): PlanMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type === 'plan') return message;
  }
  return undefined;
}

/** 'ai-agent' -> 'AI Agent', 'google-sheets' -> 'Google Sheets' */
export function humanizeToolName(bubbleName: string): string {
  const ALL_CAPS = new Set(['ai', 'api', 'http', 'sql', 'ai-agent']);
  return bubbleName
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) =>
      ALL_CAPS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(' ');
}

/** 'queryRecentDeals' -> 'Query recent deals' */
export function humanizeFunctionName(functionName: string): string {
  const spaced = functionName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Derive the checklist from the flow's parsed workflow. Reuses the same step
 * extraction the canvas uses (extractStepGraph), so the checklist and the
 * visualizer always describe the same steps.
 */
function deriveFromWorkflow(workflow: ParsedWorkflow): ChecklistItem[] {
  const { steps } = extractStepGraph(workflow, workflow.bubbles);

  return steps.map((step) => {
    const toolNames = new Set<string>();
    for (const bubbleId of step.bubbleIds) {
      const bubble = workflow.bubbles[bubbleId];
      if (bubble) toolNames.add(humanizeToolName(bubble.bubbleName));
    }

    if (step.id === 'step-main') {
      return {
        id: step.id,
        text: 'Sets up the tools this flow uses',
        tools: Array.from(toolNames),
      };
    }

    return {
      id: step.id,
      text: step.description || humanizeFunctionName(step.functionName),
      tools: Array.from(toolNames),
    };
  });
}

/** Derive the checklist from the approved plan in the conversation thread */
function deriveFromPlan(plan: PlanMessage): ChecklistItem[] {
  return plan.plan.steps.map((step, index) => ({
    id: `plan-step-${index}`,
    text: step.description || step.title,
    tools: (step.bubblesUsed ?? []).map(humanizeToolName),
  }));
}

/**
 * Build the plain-language checklist for a flow. Workflow steps win (they
 * describe the code that was built); the plan is the fallback for flows
 * whose workflow has not been parsed yet.
 */
export function deriveChecklistItems(
  workflow: ParsedWorkflow | undefined,
  conversationMessages: CoffeeMessage[]
): ChecklistItem[] {
  if (workflow && workflow.root && workflow.root.length > 0) {
    const items = deriveFromWorkflow(workflow);
    if (items.length > 0) return items;
  }

  const plan = findPlanMessage(conversationMessages);
  if (plan) return deriveFromPlan(plan);

  return [];
}

/**
 * One-paragraph summary of the flow: the approved plan's summary when
 * present, else the flow's stored description.
 */
export function deriveFlowSummary(
  conversationMessages: CoffeeMessage[],
  flowDescription: string | undefined
): string | undefined {
  const plan = findPlanMessage(conversationMessages);
  return plan?.plan.summary || flowDescription || undefined;
}
