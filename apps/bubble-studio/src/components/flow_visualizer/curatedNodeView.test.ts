/**
 * U1 unit layer (PLAN-DOCS/discovery/U1.md acceptance test): asserts the
 * curated view-model's field whitelists and the F0.5 no-technical-leakage
 * invariant from fixtures — "assert on the node's props/derived list, not
 * pixels". Runs in CI without a browser; the F0.1 event-harness script is a
 * bolt-on on top of the node.curated_view_rendered event this model feeds.
 *
 * Tightened 2026-08-05 (MVP simplification pass): model and credentialSlots
 * dropped from the curated view entirely — credential binding auto-assigns
 * (S1/S9) and the raw override lives in "Advanced", independent of this
 * view-model. Assertions on those fields were removed along with the fields.
 */
import { describe, expect, it } from 'vitest';
import { BubbleParameterType } from '@bubblelab/shared-schemas';
import type { ParsedBubbleWithInfo } from '@bubblelab/shared-schemas';
import {
  AGENT_FIELDS,
  TOOL_FIELDS,
  credentialTypeDisplayName,
  curatedFields,
  curatedViewTelemetryPayload,
  deriveCuratedNodeView,
  humanizeSlug,
} from './curatedNodeView';

const LOCATION = { startLine: 1, startCol: 0, endLine: 2, endCol: 0 };

/** Raw param names banned from every curated surface (F0.5 checklist). */
const BANNED_RAW_PARAM_NAMES = [
  'message',
  'url',
  'limit',
  'operation',
  'tools',
  'capabilities',
  'memoryEnabled',
  'credentials',
];

const agentBubble: ParsedBubbleWithInfo = {
  variableId: 414,
  variableName: 'agent',
  bubbleName: 'ai-agent',
  className: 'AIAgentBubble',
  nodeType: 'service',
  hasAwait: false,
  hasActionCall: false,
  location: LOCATION,
  parameters: [
    {
      name: 'message',
      value: 'query',
      type: BubbleParameterType.VARIABLE,
      source: 'object-property',
    },
    {
      name: 'systemPrompt',
      value: '`Answer briefly`',
      type: BubbleParameterType.STRING,
      source: 'object-property',
    },
    {
      name: 'model',
      value: "{\n  model: 'google/gemini-2.5-pro'\n}",
      type: BubbleParameterType.OBJECT,
      source: 'object-property',
    },
    {
      name: 'tools',
      value:
        "[\n  { name: 'web-search-tool', config: { limit: 1 } },\n  { name: 'web-scrape-tool' },\n]",
      type: BubbleParameterType.ARRAY,
      source: 'object-property',
    },
    {
      name: 'capabilities',
      value: "[{ id: 'google-doc-knowledge-base', inputs: { docId: 'x' } }]",
      type: BubbleParameterType.ARRAY,
      source: 'object-property',
    },
  ],
  dependencyGraph: {
    name: 'ai-agent',
    uniqueId: '414',
    variableId: 414,
    variableName: 'agent',
    nodeType: 'service',
    dependencies: [
      {
        name: 'web-search-tool',
        uniqueId: '414.web-search-tool#1',
        variableId: 605684,
        nodeType: 'tool',
        dependencies: [
          {
            name: 'firecrawl',
            uniqueId: '414.web-search-tool#1.firecrawl#1',
            variableId: 881696,
            nodeType: 'service',
            dependencies: [],
          },
        ],
      },
      {
        name: 'web-scrape-tool',
        uniqueId: '414.web-scrape-tool#1',
        variableId: 605685,
        nodeType: 'tool',
        dependencies: [],
      },
    ],
  },
};

const driveBubble: ParsedBubbleWithInfo = {
  variableId: 501,
  variableName: 'driveUploader',
  bubbleName: 'google-drive',
  className: 'GoogleDriveBubble',
  nodeType: 'service',
  hasAwait: true,
  hasActionCall: true,
  location: LOCATION,
  description: 'Uploads the weekly report to your Google Drive folder',
  parameters: [
    {
      name: 'operation',
      value: 'upload_file',
      type: BubbleParameterType.STRING,
      source: 'object-property',
    },
  ],
};

/** Every string the panel renders as a label/value for this view. */
function renderedLabels(view: ReturnType<typeof deriveCuratedNodeView>) {
  if (view.kind === 'agent') {
    return [...view.allowedTools, ...view.memorySources];
  }
  return [view.description ?? ''].filter(Boolean);
}

function expectNoLeakage(labels: string[]) {
  for (const label of labels) {
    expect(label).not.toMatch(/_CRED\b/);
    expect(label, `SCREAMING_SNAKE leaked: ${label}`).not.toMatch(
      /^[A-Z0-9_]+$/
    );
    // Raw bubble slugs (e.g. 'web-search-tool') banned as display labels
    expect(label).not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
  }
}

describe('deriveCuratedNodeView — agent', () => {
  const view = deriveCuratedNodeView({ bubble: agentBubble });

  it('exposes exactly the agent whitelist', () => {
    expect(view.kind).toBe('agent');
    expect(curatedFields(view)).toEqual([...AGENT_FIELDS]);
  });

  it('derives the system prompt through the inline-param path', () => {
    if (view.kind !== 'agent') throw new Error('expected agent view');
    expect(view.systemPrompt.value).toBe('Answer briefly');
    expect(view.systemPrompt.editable).toBe(true);
  });

  it('lists humanized tools from the dependency graph (no raw slugs)', () => {
    if (view.kind !== 'agent') throw new Error('expected agent view');
    expect(view.allowedTools).toEqual(['Web Search', 'Web Scrape']);
  });

  it('lists memory sources: persistent (schema default) + capabilities', () => {
    if (view.kind !== 'agent') throw new Error('expected agent view');
    expect(view.memorySources).toEqual([
      'Persistent memory',
      'Google Doc Knowledge Base',
    ]);
  });

  it('drops persistent memory when memoryEnabled is explicitly false', () => {
    const disabled = deriveCuratedNodeView({
      bubble: {
        ...agentBubble,
        parameters: [
          ...agentBubble.parameters,
          {
            name: 'memoryEnabled',
            value: 'false',
            type: BubbleParameterType.BOOLEAN,
            source: 'object-property',
          },
        ],
      },
    });
    if (disabled.kind !== 'agent') throw new Error('expected agent view');
    expect(disabled.memorySources).toEqual(['Google Doc Knowledge Base']);
  });

  it('falls back to the raw tools code string when the graph is absent', () => {
    const noGraph = deriveCuratedNodeView({
      bubble: { ...agentBubble, dependencyGraph: undefined },
    });
    if (noGraph.kind !== 'agent') throw new Error('expected agent view');
    expect(noGraph.allowedTools).toEqual(['Web Search', 'Web Scrape']);
  });

  it('leaks no technical strings in rendered labels', () => {
    expectNoLeakage(renderedLabels(view));
  });
});

describe('deriveCuratedNodeView — tool', () => {
  const view = deriveCuratedNodeView({ bubble: driveBubble });

  it('exposes exactly the tool whitelist', () => {
    expect(view.kind).toBe('tool');
    expect(curatedFields(view)).toEqual([...TOOL_FIELDS]);
  });

  it('carries the description written by the coding agent', () => {
    if (view.kind !== 'tool') throw new Error('expected tool view');
    expect(view.description).toBe(
      'Uploads the weekly report to your Google Drive folder'
    );
  });

  it('never exposes raw param names as fields', () => {
    const fields = curatedFields(view);
    for (const banned of BANNED_RAW_PARAM_NAMES) {
      expect(fields).not.toContain(banned);
    }
  });

  it('leaks no technical strings in rendered labels', () => {
    expectNoLeakage(renderedLabels(view));
  });
});

describe('credentialTypeDisplayName / humanizeSlug', () => {
  it('maps credential types to product names', () => {
    expect(credentialTypeDisplayName('GOOGLE_DRIVE_CRED')).toBe('Google Drive');
    expect(credentialTypeDisplayName('FIRECRAWL_API_KEY')).toBe('Firecrawl');
    expect(credentialTypeDisplayName('NOTION_OAUTH_TOKEN')).toBe('Notion');
    expect(credentialTypeDisplayName('OPENAI_CRED')).toBe('OpenAI');
  });

  it('never returns SCREAMING_SNAKE or *_CRED strings', () => {
    const samples = [
      'GOOGLE_DRIVE_CRED',
      'TELEGRAM_BOT_TOKEN',
      'DATABASE_CRED',
      'CLOUDFLARE_R2_ACCESS_KEY',
      'SOME_FUTURE_THING_CRED',
    ];
    for (const credType of samples) {
      const name = credentialTypeDisplayName(credType);
      expect(name).not.toMatch(/_CRED\b/);
      expect(name).not.toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it('humanizes slugs via the integrations catalog with title-case fallback', () => {
    expect(humanizeSlug('web-search-tool')).toBe('Web Search');
    expect(humanizeSlug('google-doc-knowledge-base')).toBe(
      'Google Doc Knowledge Base'
    );
  });
});

describe('curatedViewTelemetryPayload', () => {
  it('mirrors the agent view exactly', () => {
    const view = deriveCuratedNodeView({ bubble: agentBubble });
    const payload = curatedViewTelemetryPayload(81, agentBubble, view);
    expect(payload.nodeKind).toBe('agent');
    expect(payload.fields).toEqual([...AGENT_FIELDS]);
    expect(payload.allowedTools).toEqual(['Web Search', 'Web Scrape']);
    expect(payload.memorySources).toContain('Persistent memory');
  });

  it('mirrors the tool view (description only, no credential data)', () => {
    const view = deriveCuratedNodeView({ bubble: driveBubble });
    const payload = curatedViewTelemetryPayload(81, driveBubble, view);
    expect(payload.nodeKind).toBe('tool');
    expect(payload.fields).toEqual([...TOOL_FIELDS]);
  });
});
