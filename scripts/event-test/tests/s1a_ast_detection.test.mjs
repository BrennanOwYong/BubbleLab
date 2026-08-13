#!/usr/bin/env node
/**
 * S1a — nested-tool DETECTION via AST walk (BACKLOG S1a, packages/bubble-runtime/
 * src/injection/BubbleInjector.ts + apps/bubblelab-api/src/services/bubble-flow-parser.ts).
 *
 * Root cause under test: both extractToolCredentials() call sites parsed an
 * AI-agent bubble's `tools` parameter (TypeScript source text) with
 * `new Function('return ' + value)`, which only ever evaluates a literal
 * array/object. Any variable reference (const array, spread, ternary branch,
 * const-string name) threw a ReferenceError; the catch block silently
 * swallowed it and returned an empty credential list, so the editor dropdown
 * never defaulted the nested tool's credential and the Setup tab never
 * listed it. The fix replaces the string-eval with a TypeScript-compiler AST
 * walk that resolves those bindings against the flow's full source, and
 * reports a genuinely dynamic case (built by a function call) as a typed
 * `unresolved` detection instead of dropping it.
 *
 * Detection signal: DATABASE_CRED (via 'sql-query-tool') / APIFY_CRED (via
 * 'instagram-tool'), NOT FIRECRAWL_API_KEY — BUBBLE_CREDENTIAL_OPTIONS['ai-agent']
 * already lists FIRECRAWL_API_KEY as a base credential of every ai-agent
 * bubble regardless of its tools, so FIRECRAWL_API_KEY's presence alone
 * cannot prove nested-tool detection ran (verified empirically: it appears
 * even for the genuinely-unresolved dynamic-tools case). DATABASE_CRED and
 * APIFY_CRED are NOT in ai-agent's base set, so their presence can only come
 * from resolving the nested tool name.
 *
 * The frozen accept clause (BACKLOG.md S1a): "a flow with
 * tools: [{name:'web-search-tool'}] (and the const/spread/ternary/dynamic
 * variants) yields the FIRECRAWL_API_KEY requirement in the flow-detail
 * requiredCredentials + setup-panel data (asserted, not the screen); the
 * dynamic case is reported as unresolved not dropped." The literal-array
 * case (web-search-tool -> FIRECRAWL_API_KEY) is already covered by
 * s1_platform_credentials.test.mjs; this file covers the const/spread/
 * ternary/dynamic variants the accept clause names, using a credential type
 * that actually isolates tool-array resolution from bubble-level defaults.
 *
 * Each case only needs flow-detail data (GET /bubble-flow/:id), not a run —
 * detection is a save-time/read-time property, execution is out of scope
 * (BACKLOG note: "INJECTION for nested tools already works").
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/s1a_ast_detection.test.mjs
 */
import { createHarness } from '../harness.mjs';

const t = await createHarness({
  name: 's1a_ast_detection',
  backlogId: 'S1a',
});

const PREAMBLE = `import { BubbleFlow, AIAgentBubble } from '@bubblelab/bubble-core';

export interface Output {
  answer: string;
}
`;

/** Fetches flow detail and returns the entry (bubble key -> credential types) whose types include `cred`. */
function findAgentEntry(requiredCredentials, cred) {
  return Object.entries(requiredCredentials ?? {}).find(([, types]) =>
    (types ?? []).includes(cred)
  );
}

async function assertDetected(caseName, code, expectedCreds) {
  t.section(caseName);
  const flowId = await t.seedFlow({
    name: `s1a-${caseName}`,
    prompt: `S1a event test: ${caseName}`,
    code,
  });
  const details = await t.api(`/bubble-flow/${flowId}`);
  t.assert(
    `${caseName}: flow details respond 200`,
    details.status === 200,
    `HTTP ${details.status}`
  );
  const required = details.body?.requiredCredentials ?? {};
  for (const cred of expectedCreds) {
    const entry = findAgentEntry(required, cred);
    t.assert(
      `${caseName}: detects ${cred} for the nested tool`,
      Boolean(entry),
      JSON.stringify(required).slice(0, 400)
    );
  }
  return { flowId, details };
}

// --- 1. const array binding: tools: TOOLS -----------------------------------
await assertDetected(
  'const-array',
  PREAMBLE +
    `
export class S1aConstArrayFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 5 * * *';
  async handle(): Promise<Output> {
    const TOOLS: { name: 'sql-query-tool' }[] = [{ name: 'sql-query-tool' }];
    const agent = new AIAgentBubble({
      message: 'Query the database and summarize the results.',
      tools: TOOLS,
    });
    const result = await agent.action();
    return { answer: JSON.stringify(result.data?.response ?? '') };
  }
}
`,
  ['DATABASE_CRED']
);

// --- 2. array spread: tools: [...BASE_TOOLS, { name: 'instagram-tool' }] ----
await assertDetected(
  'spread',
  PREAMBLE +
    `
export class S1aSpreadFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 5 * * *';
  async handle(): Promise<Output> {
    const BASE_TOOLS: { name: 'sql-query-tool' }[] = [
      { name: 'sql-query-tool' },
    ];
    const agent = new AIAgentBubble({
      message: 'Query the database and check Instagram, then summarize.',
      tools: [...BASE_TOOLS, { name: 'instagram-tool' }],
    });
    const result = await agent.action();
    return { answer: JSON.stringify(result.data?.response ?? '') };
  }
}
`,
  ['DATABASE_CRED', 'APIFY_CRED']
);

// --- 3. ternary branch: tools: cond ? [...] : [...] -------------------------
// Both branches are reachable at runtime depending on input the static
// detector cannot evaluate, so BOTH branches' credentials must be listed
// regardless of which branch a specific run takes.
await assertDetected(
  'ternary',
  PREAMBLE +
    `
export class S1aTernaryFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 5 * * *';
  async handle(): Promise<Output> {
    const useInstagram = Math.random() > 2; // always false at runtime, but NOT statically decidable
    const agent = new AIAgentBubble({
      message: 'Answer the question using the right tool.',
      tools: useInstagram ? [{ name: 'instagram-tool' }] : [{ name: 'sql-query-tool' }],
    });
    const result = await agent.action();
    return { answer: JSON.stringify(result.data?.response ?? '') };
  }
}
`,
  ['DATABASE_CRED', 'APIFY_CRED']
);

// --- 4. const-string name indirection: tools: [{ name: TOOL_NAME }] ---------
await assertDetected(
  'const-string-name',
  PREAMBLE +
    `
export class S1aConstStringFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 5 * * *';
  async handle(): Promise<Output> {
    const TOOL_NAME: 'sql-query-tool' = 'sql-query-tool';
    const agent = new AIAgentBubble({
      message: 'Query the database and summarize the results.',
      tools: [{ name: TOOL_NAME }],
    });
    const result = await agent.action();
    return { answer: JSON.stringify(result.data?.response ?? '') };
  }
}
`,
  ['DATABASE_CRED']
);

// --- 5. genuinely dynamic: tools built by a function call --------------------
// Must NOT silently report zero credentials as if the agent needed none, and
// must NOT hallucinate a credential it cannot prove — it must surface as a
// typed `unresolved` detection (accept clause: "reported as unresolved not
// dropped").
t.section('dynamic-unresolved');
const dynamicFlowId = await t.seedFlow({
  name: 's1a-dynamic-unresolved',
  prompt: 'S1a event test: dynamic tools built by a function call',
  code:
    PREAMBLE +
    `
function pickTools(intent: string): { name: 'sql-query-tool' }[] {
  return intent === 'query' ? [{ name: 'sql-query-tool' }] : [];
}

export class S1aDynamicFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 5 * * *';
  async handle(): Promise<Output> {
    const agent = new AIAgentBubble({
      message: 'Answer using whichever tool is picked at runtime.',
      tools: pickTools('query'),
    });
    const result = await agent.action();
    return { answer: JSON.stringify(result.data?.response ?? '') };
  }
}
`,
});
const dynamicDetails = await t.api(`/bubble-flow/${dynamicFlowId}`);
t.assert(
  'dynamic: flow details respond 200',
  dynamicDetails.status === 200,
  `HTTP ${dynamicDetails.status}`
);
const dynamicRequired = dynamicDetails.body?.requiredCredentials ?? {};
t.assert(
  'dynamic: does NOT silently claim DATABASE_CRED it cannot statically prove',
  !findAgentEntry(dynamicRequired, 'DATABASE_CRED'),
  JSON.stringify(dynamicRequired).slice(0, 400)
);
const unresolved = dynamicDetails.body?.unresolvedToolDetections ?? [];
t.assert(
  'dynamic: reported as a typed unresolved record, not silently dropped',
  Array.isArray(unresolved) &&
    unresolved.some(
      (u) => u.param === 'tools' && u.reason === 'dynamic-expression'
    ),
  JSON.stringify(unresolved).slice(0, 400)
);

await t.finish();
