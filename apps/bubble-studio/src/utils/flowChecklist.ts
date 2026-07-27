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

/**
 * Chip names a non-technical person recognizes. Bubbles whose internal name
 * is an implementation term get a plain name; app bubbles keep the app name.
 */
const FRIENDLY_TOOL_NAMES: Record<string, string> = {
  'ai-agent': 'AI',
  http: 'Web',
  postgresql: 'Database',
  storage: 'File storage',
};

/** 'ai-agent' -> 'AI', 'google-sheets' -> 'Google Sheets' */
export function humanizeToolName(bubbleName: string): string {
  const friendly = FRIENDLY_TOOL_NAMES[bubbleName.toLowerCase()];
  if (friendly) return friendly;
  return bubbleName
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Ordered replacements that turn generation-time step descriptions into
 * language a non-technical reader follows. Compound phrases come before the
 * single words they contain.
 */
const PLAIN_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\ban AI agent in JSON mode\b/gi, 'AI'],
  [/\bAI agents?\b/gi, 'AI'],
  [/\bLLM\b/gi, 'AI'],
  [/\bprompts?\b/gi, 'instructions'],
  [/\b2D array\b/gi, 'table'],
  [/\barrays?\b/gi, 'list'],
  [/\bA1 range\b/gi, 'cell range'],
  [/\bJSON mode\b/gi, 'structured mode'],
  [/\bJSON\b/gi, 'structured data'],
  [/\braw XML\b/gi, 'raw data'],
  [/\bXML\b/gi, 'data'],
  [/\bHTML email\b/gi, 'email'],
  [/\bHTML\s+/gi, ''],
  [/\bHTML\b/gi, 'formatted text'],
  [/\bUTC\s+/gi, ''],
  [/\bRSS\s+/gi, 'news '],
  [/\bAPI\b/gi, 'service'],
  [/\bparses\b/gi, 'reads'],
  [/\bparsed\b/gi, 'read'],
  [/\bparsing\b/gi, 'reading'],
  [/\bparse\b/gi, 'read'],
  [/\bdeterministically\b/gi, 'reliably'],
  [/\bdownstream\b/gi, 'later'],
  [/\bconfigured\b/gi, 'chosen'],
  [/\bendpoints?\b/gi, 'address'],
  [/\bpayloads?\b/gi, 'data'],
  [/\bbooleans?\b/gi, 'yes/no value'],
  [/\bregexp?\b/gi, 'pattern'],
  [/\bwebhooks?\b/gi, 'automatic trigger'],
  [/\bcron\b/gi, 'schedule'],
  [/\bquery\b/gi, 'look up'],
  [/\bqueries\b/gi, 'looks up'],
  [/\brenders\b/gi, 'creates'],
  [/\brender\b/gi, 'create'],
];

/**
 * Rewrite one checklist line into plain language: swap technical terms for
 * everyday ones and spell out identifiers (chat_id -> chat id,
 * sendReminderEmail -> send reminder email).
 */
export function toPlainLanguage(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PLAIN_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  // snake_case identifiers -> spaced words
  result = result.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (token) =>
    token.replace(/_/g, ' ')
  );
  // camelCase identifiers -> spaced lowercase words
  result = result.replace(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, (token) =>
    token.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  );
  result = result.replace(/\s{2,}/g, ' ').trim();
  return result.charAt(0).toUpperCase() + result.slice(1);
}

/**
 * Coder verbs -> everyday verbs for lines derived from a function name
 * (used only when a step carries no written description).
 */
const VERB_MAP: Record<string, string> = {
  transform: 'prepares',
  build: 'creates',
  builds: 'creates',
  construct: 'creates',
  generate: 'creates',
  render: 'creates',
  compute: 'works out',
  calculate: 'works out',
  fetch: 'gets',
  execute: 'runs',
  init: 'sets up',
  initialize: 'sets up',
  validate: 'checks',
  handle: 'processes',
};

/** 'transformSheetRange' -> 'Prepares sheet range' */
export function humanizeFunctionName(functionName: string): string {
  const spaced = functionName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase()
    .trim();
  const words = spaced.split(' ');
  const mapped = VERB_MAP[words[0]];
  if (mapped) words[0] = mapped;
  const sentence = words.join(' ');
  return toPlainLanguage(sentence.charAt(0).toUpperCase() + sentence.slice(1));
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
        text: 'Connects the apps this flow uses',
        tools: Array.from(toolNames),
      };
    }

    return {
      id: step.id,
      text: step.description
        ? toPlainLanguage(step.description)
        : humanizeFunctionName(step.functionName),
      tools: Array.from(toolNames),
    };
  });
}

/** Derive the checklist from the approved plan in the conversation thread */
function deriveFromPlan(plan: PlanMessage): ChecklistItem[] {
  return plan.plan.steps.map((step, index) => ({
    id: `plan-step-${index}`,
    text: toPlainLanguage(step.description || step.title),
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
  const summary = plan?.plan.summary || flowDescription;
  return summary ? toPlainLanguage(summary) : undefined;
}
