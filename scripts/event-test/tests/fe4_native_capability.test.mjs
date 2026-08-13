#!/usr/bin/env node
/**
 * FE4 — native-capability discovery + routing (BACKLOG FE4, brief
 * PLAN-DOCS/discovery/FE4.md).
 *
 * Under test: the typed native-capability manifest
 * (packages/bubble-shared-schemas/src/native-capabilities.ts) surfaces
 * through get_bubble_details, and the ai-agent's nativeCapabilities param
 * routes open-web research to the provider-native web search (OpenAI
 * Responses API built-in tool) instead of the Firecrawl-backed
 * web-search-tool. Routing rule: native > any tool source.
 *
 * Part 1 — discovery record (deterministic, no LLM): GET
 * /bubble-flow/bubble-details/ai-agent carries the manifest entry.
 *
 * Part 2 — runtime capability (deterministic seed, one real LLM run): a
 * fixture flow whose ai-agent has nativeCapabilities: ['web-search'],
 * tools: [], an openai model. Asserts on logged events only:
 * execution_complete success, tool_call_start/complete StreamingLogEvents
 * naming 'native-web-search', zero events naming web-search-tool, and a
 * persisted run in /executions. No FIRECRAWL_API_KEY slot ever appears
 * because no Firecrawl bubble is authored (the S1 unbound-slot trap is
 * sidestepped, not fixed).
 *
 * The brief's Part B (LLM build-from-prompt choosing the native route) is
 * probabilistic builder behavior; it belongs to the benchmark/verification
 * pass, same split as s3's stage-2 (see FE4.md "Event-based acceptance
 * test").
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/fe4_native_capability.test.mjs
 */
import { createHarness } from '../harness.mjs';

const t = await createHarness({
  name: 'fe4_native_capability',
  backlogId: 'FE4',
  timeoutMs: 10 * 60_000,
});

// --- Part 1: discovery record ------------------------------------------------
t.section('discovery: bubble-details carries the native-capability manifest');
const details = await t.api('/bubble-flow/bubble-details/ai-agent');
t.assert('ai-agent details respond 200', details.status === 200, `HTTP ${details.status}`);
const caps = details.body?.nativeCapabilities ?? [];
t.assert(
  'nativeCapabilities is non-empty',
  Array.isArray(caps) && caps.length > 0,
  JSON.stringify(caps).slice(0, 200)
);
const webSearch = caps.find((c) => c?.id === 'web-search');
t.assert('a web-search capability is declared', Boolean(webSearch), JSON.stringify(caps).slice(0, 300));
t.assert(
  "web-search replaces web-search-tool",
  (webSearch?.replaces ?? []).includes('web-search-tool'),
  JSON.stringify(webSearch?.replaces)
);
t.assert(
  'openai provider support is declared implemented',
  webSearch?.substrates?.['ai-agent']?.providers?.openai?.implemented === true,
  JSON.stringify(webSearch?.substrates?.['ai-agent']?.providers)
);
t.assert(
  'the routing boundary (notReplaced) names URL-specific extraction',
  /url/i.test(webSearch?.notReplaced ?? ''),
  webSearch?.notReplaced
);

// A non-substrate bubble must NOT gain the field (additive, scoped).
const sheetDetails = await t.api('/bubble-flow/bubble-details/google-sheets');
t.assert(
  'google-sheets details carry no nativeCapabilities',
  sheetDetails.status === 200 && sheetDetails.body?.nativeCapabilities === undefined,
  JSON.stringify(sheetDetails.body?.nativeCapabilities)
);

// --- Part 2: runtime — native web search runs, no Firecrawl tool -------------
t.section('runtime: nativeCapabilities routes to provider-native web search');

const FE4_FIXTURE_CODE = `import {
  BubbleFlow,
  AIAgentBubble,
} from '@bubblelab/bubble-core';
import type { CronEvent } from '@bubblelab/shared-schemas';

export interface Fe4FixturePayload extends CronEvent {
  /**
   * @header Research topic
   * @hint What topic should be researched?
   */
  topic?: string;
}

export class EventTestFe4NativeSearchFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 13 * * 1';

  constructor() {
    super(
      'event-test-fe4-native-search',
      'Researches a topic with the agent native web search and returns a one-line summary'
    );
  }

  // Research the topic with the agent's native web search (no tool bubble)
  private async researchTopic(topic: string): Promise<string | null> {
    const result = await new AIAgentBubble({
      message: \`Search the web for the latest news about "\${topic}" and reply with ONE sentence naming one concrete recent development you found.\`,
      nativeCapabilities: ['web-search'],
      tools: [],
      model: { model: 'openai/gpt-5-mini', maxTokens: 10000 },
    }).action();
    if (!result.success || !result.data?.response) return null;
    return result.data.response;
  }

  async handle(payload: Fe4FixturePayload): Promise<{ ok: boolean; summary: string }> {
    const { topic = 'TypeScript compiler releases' } = payload;
    const summary = await this.researchTopic(topic);
    if (summary === null) {
      return { ok: false, summary: '' };
    }
    return { ok: true, summary };
  }
}
`;

const flowId = await t.seedFlow({
  name: 'EVENT-TEST FE4 fixture',
  prompt: 'FE4 fixture: native web search research flow',
  eventType: 'schedule/cron',
  code: FE4_FIXTURE_CODE,
});
t.assert('fixture flow seeded', Boolean(flowId), `flowId=${flowId}`);

// No Firecrawl-backed bubble is authored -> no web-search-tool anywhere in
// the parsed bubble surface or the code (the FE4 side effect: the S1
// unbound-slot trap never opens because the slot never exists).
// NOTE (brief deviation): the record's requiredCredentials map is the
// per-bubble credential OPTION set, and BUBBLE_CREDENTIAL_OPTIONS['ai-agent']
// statically lists FIRECRAWL_API_KEY (credential-schema.ts:3127-3131), so the
// brief's "requiredCredentials carries no FIRECRAWL_API_KEY" is unassertable
// as written; the bubble-level absence below is the real invariant.
const flowRecord = await t.api(`/bubble-flow/${flowId}`);
const bubbles = JSON.stringify(flowRecord.body?.bubbleParameters ?? {});
t.assert(
  'no web-search-tool bubble in the parsed flow',
  !bubbles.includes('web-search-tool') && !/firecrawl/i.test(bubbles),
  bubbles.slice(0, 200)
);
t.assert(
  'flow code binds no web-search-tool',
  !String(flowRecord.body?.code ?? '').includes('web-search-tool'),
  'web-search-tool found in code'
);
t.assert(
  "ai-agent bubble parameter carries nativeCapabilities ['web-search']",
  /nativeCapabilities/.test(bubbles) && /web-search/.test(bubbles),
  bubbles.slice(0, 300)
);

const run = await t.executeStream(flowId, {}, 5 * 60_000);
t.assert('execution_complete success', run.success === true, JSON.stringify(run.signals).slice(0, 400));

const nativeStarts = run.events.filter(
  (e) => e.type === 'tool_call_start' && e.toolName === 'native-web-search'
);
const nativeCompletes = run.events.filter(
  (e) => e.type === 'tool_call_complete' && e.toolName === 'native-web-search'
);
t.assert(
  'at least one native-web-search tool_call_start event',
  nativeStarts.length >= 1,
  `starts=${nativeStarts.length} types=${[...new Set(run.events.map((e) => e.type))].join(',')}`
);
t.assert(
  'at least one native-web-search tool_call_complete event',
  nativeCompletes.length >= 1,
  `completes=${nativeCompletes.length}`
);
t.assert(
  'no event names web-search-tool (no Firecrawl path ran)',
  !run.events.some((e) => JSON.stringify(e).includes('web-search-tool')),
  'web-search-tool found in run events'
);
t.assert(
  'no event names firecrawl',
  !run.events.some((e) => /firecrawl/i.test(JSON.stringify(e))),
  'firecrawl found in run events'
);

const history = await t.executions(flowId, 1);
t.assert('run persisted in execution history', history.length >= 1, `items=${history.length}`);

await t.finish();
