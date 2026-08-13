/**
 * U1 — curated expanded-node view-model (PLAN-DOCS/discovery/U1.md).
 *
 * Single source of truth for what an expanded canvas node shows by default.
 * The BubbleNode renderer AND the `node.curated_view_rendered` telemetry
 * event both consume this derivation, so the panel and the event cannot
 * disagree (DISPATCH-CONTRACT.md Pillar 2: assert on events, not DOM).
 *
 * F0.5 invariant (PRODUCT-PRINCIPLES.md): every RENDERED string this model
 * produces is a plain product word — humanized tool names, humanized
 * capability labels, provider display names. Machine keys (`credType`,
 * `model.paramPath`) are wiring/event data and are never used as labels.
 *
 * Memory-sources default (U1.md open question 2, accepted default): the
 * ai-agent schema defaults `memoryEnabled` to true when the param is absent
 * (packages/bubble-core/src/bubbles/service-bubble/ai-agent.ts:393), so an
 * absent param lists 'Persistent memory'; capabilities[].id entries are
 * humanized and appended. Read-only.
 */

import type { ParsedBubbleWithInfo } from '@bubblelab/shared-schemas';
import { resolveLogoByName } from '@/lib/integrations';
import { extractParamValue } from '@/utils/bubbleParamEditor';

/**
 * Field whitelists — the exact keys each view kind may expose (U1 accept
 * clause, tightened per the MVP simplification pass 2026-08-05: model and
 * credentialSlots dropped from the curated default — credential binding now
 * auto-assigns (S1/S9), and the raw override still lives in "Advanced" via
 * its own independent state, not this view-model).
 */
export const AGENT_FIELDS = [
  'systemPrompt',
  'allowedTools',
  'memorySources',
] as const;
export const TOOL_FIELDS = ['description'] as const;

export interface CuratedAgentView {
  kind: 'agent';
  systemPrompt: { value?: string; editable: boolean };
  /** Humanized tool names, e.g. 'Web Search' (never raw slugs). */
  allowedTools: string[];
  /** Humanized memory/capability labels, e.g. 'Persistent memory'. Read-only. */
  memorySources: string[];
}

export interface CuratedToolView {
  kind: 'tool';
  description?: string;
}

export type CuratedNodeView = CuratedAgentView | CuratedToolView;

export interface CuratedViewInput {
  bubble: ParsedBubbleWithInfo;
}

/**
 * Humanize a bubble/tool/capability slug for display:
 * 'web-search-tool' -> 'Web Search', 'google-doc-knowledge-base' ->
 * 'Google Doc Knowledge Base'. Uses the integrations catalog first so known
 * products carry their canonical name.
 */
export function humanizeSlug(slug: string): string {
  const resolved = resolveLogoByName(slug);
  if (resolved) return resolved.name;
  return slug
    .replace(/-tool$/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

const CRED_SUFFIXES = [
  /_CRED$/,
  /_API_KEY$/,
  /_API$/,
  /_OAUTH_TOKEN$/,
  /_OAUTH$/,
  /_TOKEN$/,
  /_KEY$/,
];

/**
 * Friendly provider name for a credential type:
 * 'GOOGLE_DRIVE_CRED' -> 'Google Drive', 'FIRECRAWL_API_KEY' -> 'Firecrawl'.
 * Guaranteed to never return a `*_CRED` / SCREAMING_SNAKE string.
 */
export function credentialTypeDisplayName(credType: string): string {
  let stripped = credType;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of CRED_SUFFIXES) {
      const next = stripped.replace(suffix, '');
      if (next !== stripped && next.length > 0) {
        stripped = next;
        changed = true;
      }
    }
  }
  return humanizeSlug(stripped.toLowerCase().replace(/_/g, '-'));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Tool names for an agent: dependencyGraph first, raw `tools` code-string regex fallback. */
function collectToolSlugs(bubble: ParsedBubbleWithInfo): string[] {
  const deps = bubble.dependencyGraph?.dependencies ?? [];
  const fromGraph = deps
    .filter((dep) => dep.nodeType === 'tool')
    .map((dep) => dep.name as string);
  if (fromGraph.length > 0) return dedupe(fromGraph);

  const toolsParam = bubble.parameters.find((p) => p.name === 'tools');
  if (typeof toolsParam?.value !== 'string') return [];
  const names: string[] = [];
  const namePattern = /name:\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(toolsParam.value)) !== null) {
    names.push(match[1]);
  }
  return dedupe(names);
}

/** Memory sources: 'Persistent memory' when enabled (absent = schema default true) + capability ids. */
function deriveMemorySources(bubble: ParsedBubbleWithInfo): string[] {
  const sources: string[] = [];
  const memoryParam = bubble.parameters.find((p) => p.name === 'memoryEnabled');
  const memoryEnabled =
    memoryParam === undefined
      ? true // schema default (ai-agent.ts memoryEnabled: default(true))
      : memoryParam.value === true || memoryParam.value === 'true';
  if (memoryEnabled) sources.push('Persistent memory');

  const capsParam = bubble.parameters.find((p) => p.name === 'capabilities');
  const capabilityIds: string[] = [];
  if (Array.isArray(capsParam?.value)) {
    for (const entry of capsParam.value) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { id?: unknown }).id === 'string'
      ) {
        capabilityIds.push((entry as { id: string }).id);
      }
    }
  } else if (typeof capsParam?.value === 'string') {
    const idPattern = /id:\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = idPattern.exec(capsParam.value)) !== null) {
      capabilityIds.push(match[1]);
    }
  }
  sources.push(...dedupe(capabilityIds).map(humanizeSlug));
  return sources;
}

/** Derive the curated view-model for one node. Pure: no store reads, no side effects. */
export function deriveCuratedNodeView(
  input: CuratedViewInput
): CuratedNodeView {
  const { bubble } = input;

  if (bubble.bubbleName === 'ai-agent') {
    const promptParam = bubble.parameters.find(
      (p) => p.name === 'systemPrompt'
    );
    const promptExtracted = promptParam
      ? extractParamValue(promptParam, 'systemPrompt', bubble.bubbleName)
      : undefined;

    return {
      kind: 'agent',
      systemPrompt: {
        value:
          typeof promptExtracted?.value === 'string'
            ? promptExtracted.value
            : undefined,
        editable: promptExtracted?.shouldBeEditable ?? false,
      },
      allowedTools: collectToolSlugs(bubble).map(humanizeSlug),
      memorySources: deriveMemorySources(bubble),
    };
  }

  return {
    kind: 'tool',
    description: bubble.description,
  };
}

/** The event/assertion field list: view keys minus the discriminant. */
export function curatedFields(view: CuratedNodeView): string[] {
  return Object.keys(view).filter((key) => key !== 'kind');
}

/**
 * Telemetry payload for `node.curated_view_rendered` — derived from the SAME
 * view object the panel renders, so the event asserts exactly what rendered.
 */
export function curatedViewTelemetryPayload(
  flowId: number,
  bubble: ParsedBubbleWithInfo,
  view: CuratedNodeView
): {
  flowId: number;
  bubbleName: string;
  nodeKind: 'agent' | 'tool';
  fields: string[];
  allowedTools?: string[];
  memorySources?: string[];
} {
  const base = {
    flowId,
    bubbleName: bubble.bubbleName as string,
    nodeKind: view.kind,
    fields: curatedFields(view),
  };
  if (view.kind === 'agent') {
    return {
      ...base,
      allowedTools: view.allowedTools,
      memorySources: view.memorySources,
    };
  }
  return base;
}
