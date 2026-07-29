/**
 * Plain-language checklist derivation for the Checklist tab.
 *
 * Primary source: the flow's parsed `workflow` step graph (function_call /
 * transformation_function nodes carry human-readable descriptions written at
 * generation time). Fallback source: the approved plan inside the flow's
 * saved conversation thread (metadata.conversationMessages).
 */
import { type ParsedWorkflow } from '@bubblelab/shared-schemas';
import {
  ConversationMessageSchema,
  type ConversationMessage,
  type PlanMessage,
} from '../types/conversation';
import { extractStepGraph } from './workflowToSteps';
import {
  humanizeFieldName,
  isFieldDescriptor,
  type FieldDescriptor,
} from './fieldDescriptor';

export interface ChecklistItem {
  id: string;
  /** One human-readable line describing what this step does */
  text: string;
  /** Friendly names of the tools (bubbles) the step uses */
  tools: string[];
}

/**
 * Programmatic status message the generate route appends to
 * metadata.conversationMessages when a build finishes. Distinct from the
 * ConversationMessage union (role/kind/timestampMs instead of type/id/timestamp).
 */
export interface WorkflowStatusMessage {
  role: 'system';
  kind: 'workflow-done' | 'workflow-done-needs-info';
  /** Unix epoch milliseconds */
  timestampMs: number;
  text: string;
  /** Present on workflow-done-needs-info: the default-value form to re-render */
  fields?: FieldDescriptor[];
}

/** One entry of the full conversation thread, in persisted order */
export type ConversationEntry =
  | { kind: 'coffee'; message: ConversationMessage }
  | { kind: 'status'; message: WorkflowStatusMessage };

function isWorkflowStatusMessage(
  entry: unknown
): entry is WorkflowStatusMessage {
  if (typeof entry !== 'object' || entry === null) return false;
  const candidate = entry as Record<string, unknown>;
  if (candidate.role !== 'system') return false;
  if (
    candidate.kind !== 'workflow-done' &&
    candidate.kind !== 'workflow-done-needs-info'
  ) {
    return false;
  }
  return (
    typeof candidate.timestampMs === 'number' &&
    typeof candidate.text === 'string'
  );
}

/**
 * Parse the FULL persisted thread — Coffee planning messages AND programmatic
 * workflow-status messages — preserving array order. Unknown shapes are
 * skipped individually so one bad entry never drops the thread.
 */
export function parseConversationThread(
  metadata: Record<string, unknown> | undefined
): ConversationEntry[] {
  const raw = metadata?.conversationMessages;
  if (!Array.isArray(raw)) return [];

  const entries: ConversationEntry[] = [];
  for (const entry of raw) {
    if (isWorkflowStatusMessage(entry)) {
      const fields = Array.isArray((entry as { fields?: unknown[] }).fields)
        ? (entry as { fields: unknown[] }).fields.filter(isFieldDescriptor)
        : undefined;
      entries.push({
        kind: 'status',
        message: { ...entry, fields },
      });
      continue;
    }
    const parsed = ConversationMessageSchema.safeParse(entry);
    if (parsed.success) {
      entries.push({ kind: 'coffee', message: parsed.data });
    }
  }
  return entries;
}

/**
 * Parse the conversation thread persisted on a flow's metadata.
 * Validates each entry against ConversationMessageSchema individually so one
 * unknown message shape does not drop the whole thread.
 */
export function parseConversationMessages(
  metadata: Record<string, unknown> | undefined
): ConversationMessage[] {
  const raw = metadata?.conversationMessages;
  if (!Array.isArray(raw)) return [];

  const messages: ConversationMessage[] = [];
  for (const entry of raw) {
    const parsed = ConversationMessageSchema.safeParse(entry);
    if (parsed.success) {
      messages.push(parsed.data);
    }
  }
  return messages;
}

/** Latest plan message in the thread (the plan the user approved), if any */
export function findPlanMessage(
  messages: ConversationMessage[]
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
  // "HTML parse mode" / "parse mode" before the HTML and parse rules —
  // otherwise they compose into the factually wrong "read mode"
  [/\bHTML parse mode\b/gi, 'formatted text'],
  [/\bparse mode\b/gi, 'formatting'],
  [/\bHTML email\b/gi, 'email'],
  [/\bHTML\s+/gi, ''],
  [/\bHTML\b/gi, 'formatted text'],
  [/\bin UTC\b/gi, ''],
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
  // Compound first so "search query" never becomes "search search"
  [/\bsearch queries\b/gi, 'searches'],
  [/\bsearch query\b/gi, 'search'],
  // Noun-safe: "a query" -> "a search", "Queries Gmail" -> "Searches Gmail"
  // (the old "look up" swap broke noun uses: "a Gmail search look up")
  [/\bquery\b/gi, 'search'],
  [/\bqueries\b/gi, 'searches'],
  [/\brenders\b/gi, 'creates'],
  [/\brender\b/gi, 'create'],
  [/\bmarkdown\b/gi, 'formatted text'],
  [/\bstrings?\b/gi, 'text'],
  [/\ban integer\b/gi, 'a number'],
  [/\bintegers?\b/gi, 'number'],
  [/\bISO[- ]?8601\s*/gi, ''],
  [/\bURLs?\b/g, 'link'],
  [/\bnull\b/gi, 'empty'],
  [/\bundefined\b/gi, 'empty'],
  [/\btimestamps?\b/gi, 'time'],
  [/\bschemas?\b/gi, 'form'],
  [/\bexecutes\b/gi, 'runs'],
  [/\bexecute\b/gi, 'run'],
  [/\bexecution\b/gi, 'run'],
  [/\bconcatenates?\b/gi, 'combines'],
  [/\biterates? over\b/gi, 'goes through'],
  [/`([^`]+)`/g, '$1'],
  // Bracketed technical asides ("the [since, until] window") add nothing in
  // plain language — drop them
  [/\s*\[[^\][\n]{0,60}\]/g, ''],
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
  // Identifier spacing can duplicate a word ("since sinceIso" -> "since
  // since iso"); collapse immediate repeats
  result = result.replace(/\b([A-Za-z]+)( \1\b)+/gi, '$1');
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
  query: 'looks up',
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
 * Turn a step-graph edge label ("if aiResult.isMatch === true", "else",
 * "else if deals.length > 0") into a short phrase a non-technical viewer
 * reads as the reason a branch is taken. Used by the flow canvas to label
 * conditional edges.
 */
export function humanizeConditionLabel(label: string): string {
  const trimmed = label.trim();
  if (/^else$/i.test(trimmed)) return 'otherwise';
  const match = trimmed.match(/^(else if|if)\s*(.*)$/i);
  const prefix = match
    ? match[1].toLowerCase() === 'else if'
      ? 'or if'
      : 'if'
    : '';
  let expr = match ? match[2] : trimmed;

  expr = expr
    .replace(/\?\./g, '.')
    // Common boolean shapes first, so they read as phrases not equations
    .replace(/\s*(?:===|==)\s*true\b/g, '')
    .replace(/(\S+)\s*(?:===|==)\s*false\b/g, 'not $1')
    .replace(/(\S+)\s*(?:!==|!=)\s*(?:null|undefined)\b/g, '$1 exists')
    .replace(/(\S+)\s*(?:===|==)\s*(?:null|undefined)\b/g, '$1 is empty')
    .replace(/!==|!=/g, ' is not ')
    .replace(/===|==/g, ' is ')
    .replace(/>=/g, ' at least ')
    .replace(/<=/g, ' at most ')
    .replace(/>/g, ' more than ')
    .replace(/</g, ' less than ')
    .replace(/&&/g, ' and ')
    .replace(/\|\|/g, ' or ')
    .replace(/!\s*([A-Za-z_$])/g, 'not $1')
    .replace(/\.length\b/g, ' count')
    .replace(/\btrue\b/g, 'yes')
    .replace(/\bfalse\b/g, 'no')
    .replace(/\b(?:null|undefined)\b/g, 'empty')
    .replace(/[()]/g, ' ');

  // Object paths -> their last segment, then space out identifiers
  expr = expr.replace(
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g,
    (path) => path.split('.').pop() ?? path
  );
  expr = expr.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (token) =>
    token.replace(/_/g, ' ')
  );
  expr = expr.replace(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, (token) =>
    token.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  );
  expr = expr.replace(/\s{2,}/g, ' ').trim();
  // "if is match" (from isMatch) reads better as "if match"
  expr = expr.replace(/^is (?=[a-z])/, '');

  if (expr.length > 46) {
    expr = `${expr.slice(0, 45).trimEnd()}…`;
  }
  const phrase = prefix ? `${prefix} ${expr}`.trim() : expr;
  return phrase || 'condition';
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
  conversationMessages: ConversationMessage[]
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
  conversationMessages: ConversationMessage[],
  flowDescription: string | undefined
): string | undefined {
  const plan = findPlanMessage(conversationMessages);
  const summary = plan?.plan.summary || flowDescription;
  return summary ? toPlainLanguage(summary) : undefined;
}

// ============================================================================
// Section-based checklist (B3): the checklist expresses ONLY required inputs,
// expected outcomes, trigger/frequency, and error responses — plain language.
// ============================================================================

export interface ChecklistSections {
  /** When and how often the flow runs */
  trigger: ChecklistItem[];
  /** The inputs the user must provide before the flow can run */
  requiredInputs: ChecklistItem[];
  /** What the flow does / produces, step by step */
  outcomes: ChecklistItem[];
  /** What happens when something fails */
  errorResponses: ChecklistItem[];
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function formatHourMinute(hour: number, minute: number): string {
  const period = hour >= 12 ? 'pm' : 'am';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  const displayMinute =
    minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`;
  return `${displayHour}${displayMinute} ${period}`;
}

/** '0 17 * * 5' -> 'every Friday at 5 pm'. Falls back to 'on a set schedule'. */
export function describeCronSchedule(cron: string | null | undefined): string {
  if (!cron) return 'on a set schedule';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'on a set schedule';
  const [minutePart, hourPart, dayOfMonthPart, monthPart, dayOfWeekPart] =
    parts;

  const everyMinuteMatch = minutePart.match(/^\*\/(\d+)$/);
  if (everyMinuteMatch && hourPart === '*') {
    return `every ${everyMinuteMatch[1]} minutes`;
  }
  if (minutePart === '*' && hourPart === '*') return 'every few minutes';

  const minute = Number(minutePart);
  const hour = Number(hourPart);
  if (Number.isNaN(minute)) return 'on a set schedule';
  if (hourPart === '*') {
    return minute === 0 ? 'every hour' : `every hour at ${minute} past`;
  }
  if (Number.isNaN(hour)) return 'on a set schedule';
  const time = formatHourMinute(hour, minute);

  if (dayOfWeekPart !== '*' && dayOfMonthPart === '*') {
    const days = dayOfWeekPart
      .split(',')
      .map((token) => DAY_NAMES[Number(token) % 7])
      .filter(Boolean);
    if (days.length > 0) {
      return `every ${days.join(' and ')} at ${time}`;
    }
  }
  if (dayOfMonthPart !== '*' && monthPart === '*') {
    const day = Number(dayOfMonthPart);
    if (!Number.isNaN(day)) {
      return `on day ${day} of each month at ${time}`;
    }
  }
  if (dayOfMonthPart === '*' && dayOfWeekPart === '*') {
    return `every day at ${time}`;
  }
  return 'on a set schedule';
}

/** First sentence of a hint/description, plain-language */
function firstSentencePlain(text: string): string {
  const sentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return toPlainLanguage(sentence.replace(/[.!?]$/, ''));
}

interface InputSchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
}

/** Required input fields from the flow's inputSchema, in plain language */
function deriveRequiredInputItems(inputSchema: unknown): ChecklistItem[] {
  if (typeof inputSchema !== 'object' || inputSchema === null) return [];
  const schema = inputSchema as {
    properties?: Record<string, InputSchemaProperty>;
    required?: unknown;
  };
  if (!schema.properties) return [];
  const requiredNames = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : [];

  return requiredNames
    .filter((name) => schema.properties && name in schema.properties)
    .map((name) => {
      const property = schema.properties![name];
      const label = humanizeFieldName(name);
      const description = property.description
        ? firstSentencePlain(property.description)
        : undefined;
      return {
        id: `input-${name}`,
        text: description ? `${label} — ${description}` : label,
        tools: [],
      };
    });
}

/** One plain line for when/how often the flow runs */
function deriveTriggerItems(
  eventType: string | undefined,
  cron: string | null | undefined,
  cronActive: boolean | undefined
): ChecklistItem[] {
  if (!eventType) return [];
  if (eventType.startsWith('schedule')) {
    const schedule = describeCronSchedule(cron);
    const suffix =
      cronActive === false ? ' (the schedule is currently switched off)' : '';
    return [
      {
        id: 'trigger-schedule',
        text: `Runs by itself ${schedule}${suffix}. You can also run it any time with the Run button.`,
        tools: [],
      },
    ];
  }
  if (eventType.startsWith('webhook') || eventType.includes('http')) {
    return [
      {
        id: 'trigger-webhook',
        text: 'Runs when another app sends this flow a signal. You can also run it any time with the Run button.',
        tools: [],
      },
    ];
  }
  return [
    {
      id: 'trigger-manual',
      text: 'Runs when you press the Run button.',
      tools: [],
    },
  ];
}

/** One plain line for what happens when a run fails */
function deriveErrorItems(eventType: string | undefined): ChecklistItem[] {
  const base =
    'If a step fails, that run stops and the problem is saved in the History tab so you can see what went wrong.';
  if (eventType?.startsWith('schedule')) {
    return [
      {
        id: 'error-schedule',
        text: `${base} The next scheduled run still happens.`,
        tools: [],
      },
    ];
  }
  return [{ id: 'error-default', text: base, tools: [] }];
}

/**
 * Build the four checklist sections for a flow. Outcomes reuse the existing
 * step derivation (workflow first, approved plan as fallback); the other
 * three sections derive from the flow's inputSchema, eventType and cron.
 */
export function deriveChecklistSections(options: {
  workflow: ParsedWorkflow | undefined;
  conversationMessages: ConversationMessage[];
  inputSchema?: unknown;
  eventType?: string;
  cron?: string | null;
  cronActive?: boolean;
}): ChecklistSections {
  const outcomes = deriveChecklistItems(
    options.workflow,
    options.conversationMessages
  );
  return {
    trigger: deriveTriggerItems(
      options.eventType,
      options.cron,
      options.cronActive
    ),
    requiredInputs: deriveRequiredInputItems(options.inputSchema),
    outcomes,
    // Only meaningful once the flow has steps to fail
    errorResponses:
      outcomes.length > 0 ? deriveErrorItems(options.eventType) : [],
  };
}
