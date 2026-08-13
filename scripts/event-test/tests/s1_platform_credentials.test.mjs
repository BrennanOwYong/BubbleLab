#!/usr/bin/env node
/**
 * S1 — nested-tool credential recognition via effective classification
 * (BACKLOG S1/S1b, brief PLAN-DOCS/discovery/S1.md).
 *
 * Root cause under test: FIRECRAWL_API_KEY ∈ SYSTEM_CREDENTIALS made every
 * binding surface skip the slot while the platform env did not actually back
 * it (env-name trap: map says FIRE_CRAWL_API_KEY). Fix: platform-provided =
 * SYSTEM ∩ env-backed (GET /credentials/platform-types), consulted by the
 * server auto-bind and all studio surfaces; non-backed declared-SYSTEM types
 * bind from user credentials like GOOGLE_DRIVE_CRED; plus a pre-flight warn
 * event for required slots no connected account satisfies.
 *
 * The test branches on the stack's OWN classification answer so it is
 * deterministic for either env state (firecrawl backed or not):
 *  - backed  -> negative control: slot must stay unbound (env injection path)
 *  - unbacked-> a seeded user FIRECRAWL credential must auto-bind to the slot
 * Pre-flight: a flow requiring TELEGRAM_BOT_TOKEN (user cred, none connected)
 * must emit the warn event with additionalData.preflight=missing_credential.
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/s1_platform_credentials.test.mjs
 */
import { createHarness } from '../harness.mjs';

const t = await createHarness({
  name: 's1_platform_credentials',
  backlogId: 'S1',
});

// --- 1. classification seam -------------------------------------------------
t.section('GET /credentials/platform-types');
const platform = await t.api('/credentials/platform-types');
t.assert('endpoint responds 200', platform.status === 200, `HTTP ${platform.status}`);
const platformTypes = platform.body?.platformCredentialTypes;
t.assert(
  'platformCredentialTypes is a string array',
  Array.isArray(platformTypes) && platformTypes.every((x) => typeof x === 'string'),
  JSON.stringify(platformTypes ?? null)?.slice(0, 200)
);
const DECLARED_SYSTEM = [
  'GOOGLE_GEMINI_CRED', 'FIRECRAWL_API_KEY', 'OPENAI_CRED', 'ANTHROPIC_CRED',
  'RESEND_CRED', 'OPENROUTER_CRED', 'FIREWORKS_CRED',
  'CLOUDFLARE_R2_ACCESS_KEY', 'CLOUDFLARE_R2_SECRET_KEY',
  'CLOUDFLARE_R2_ACCOUNT_ID', 'APIFY_CRED', 'CRUSTDATA_API_KEY',
  'FULLENRICH_API_KEY',
];
t.assert(
  'platform set ⊆ declared SYSTEM_CREDENTIALS',
  (platformTypes ?? []).every((type) => DECLARED_SYSTEM.includes(type)),
  JSON.stringify((platformTypes ?? []).filter((x) => !DECLARED_SYSTEM.includes(x)))
);
const firecrawlPlatformProvided = (platformTypes ?? []).includes('FIRECRAWL_API_KEY');

// --- 2. nested-tool detection + binding (branch on classification) ----------
t.section('nested web-search-tool credential slot');
const FLOW_CODE = `import { BubbleFlow, AIAgentBubble } from '@bubblelab/bubble-core';

export interface Output {
  answer: string;
}

export class S1NestedToolFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 5 * * *';
  async handle(): Promise<Output> {
    const agent = new AIAgentBubble({
      message: 'Search the web for the BubbleLab product and summarize it in one line.',
      tools: [{ name: 'web-search-tool' }],
    });
    const result = await agent.action();
    return { answer: JSON.stringify(result.data?.response ?? '') };
  }
}
`;
const flowId = await t.seedFlow({
  name: 's1-nested-tool-classification',
  prompt: 'S1 event test: agent with nested web search tool',
  code: FLOW_CODE,
});

// Seed a user FIRECRAWL credential; the create/GET auto-bind heal decides
// whether it may bind based on the classification.
const credCreate = await t.api('/credentials', {
  method: 'POST',
  body: JSON.stringify({
    credentialType: 'FIRECRAWL_API_KEY',
    value: 'fc-s1-event-test-not-a-real-key',
    name: 's1 event-test firecrawl',
  }),
});
t.assert(
  'user FIRECRAWL credential created',
  credCreate.status === 201 || credCreate.status === 200,
  `HTTP ${credCreate.status}: ${JSON.stringify(credCreate.body).slice(0, 200)}`
);
const credId = credCreate.body?.id;
t.cleanup(() => t.api(`/credentials/${credId}`, { method: 'DELETE' }));

const details = await t.api(`/bubble-flow/${flowId}`);
t.assert('flow details respond 200', details.status === 200, `HTTP ${details.status}`);
const required = details.body?.requiredCredentials ?? {};
const agentEntry = Object.entries(required).find(([, types]) =>
  (types ?? []).includes('FIRECRAWL_API_KEY')
);
t.assert(
  'detection reports FIRECRAWL_API_KEY for the agent (nested tool)',
  Boolean(agentEntry),
  JSON.stringify(required).slice(0, 300)
);

const bubbleParameters = details.body?.bubbleParameters ?? {};
const agentKey = agentEntry?.[0];
const agentBubble = agentKey ? bubbleParameters[agentKey] : undefined;
const credParamValue =
  agentBubble?.parameters?.find((p) => p.name === 'credentials')?.value ?? {};
const boundFirecrawl = credParamValue['FIRECRAWL_API_KEY'];

if (firecrawlPlatformProvided) {
  t.assert(
    'NEGATIVE CONTROL (env-backed): agent slot stays unbound, env injection serves it',
    boundFirecrawl === undefined || boundFirecrawl === null,
    `bound=${JSON.stringify(boundFirecrawl)} platformTypes=${JSON.stringify(platformTypes)}`
  );
} else {
  t.assert(
    'user credential auto-bound to the nested-tool slot (same as a direct bubble)',
    boundFirecrawl === credId,
    `bound=${JSON.stringify(boundFirecrawl)} expected=${credId}`
  );
}

// --- 3. pre-flight warn for an unsatisfiable required slot ------------------
t.section('pre-flight missing-credential warn event');
const TELEGRAM_CODE = `import { BubbleFlow, TelegramBubble } from '@bubblelab/bubble-core';

export interface Output {
  ok: boolean;
}

export class S1PreflightFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 6 * * *';
  async handle(): Promise<Output> {
    const telegram = new TelegramBubble({
      operation: 'send_message',
      chat_id: '1',
      text: 'S1 pre-flight probe',
    });
    const result = await telegram.action();
    return { ok: result.success };
  }
}
`;
const preflightFlowId = await t.seedFlow({
  name: 's1-preflight-missing-cred',
  prompt: 'S1 event test: pre-flight missing credential',
  code: TELEGRAM_CODE,
});
// Whether the stack's user already has a telegram credential decides the
// branch: bound slot -> the pre-flight must stay SILENT; unbound -> it must
// warn. Both branches are event-asserted, so either env state is a real test.
const preflightDetails = await t.api(`/bubble-flow/${preflightFlowId}`);
const preflightParams = preflightDetails.body?.bubbleParameters ?? {};
const telegramBound = Object.values(preflightParams).some((bubbleEntry) => {
  const value =
    bubbleEntry?.parameters?.find((p) => p.name === 'credentials')?.value ?? {};
  const bound = value['TELEGRAM_BOT_TOKEN'];
  return bound !== undefined && bound !== null;
});
const run = await t.executeStream(preflightFlowId, {}, 120_000);
const preflightWarns = (run.events ?? []).filter(
  (e) =>
    e.type === 'warn' &&
    e.additionalData?.preflight === 'missing_credential' &&
    e.additionalData?.credentialType === 'TELEGRAM_BOT_TOKEN'
);
if (telegramBound) {
  t.assert(
    'bound slot: pre-flight stays silent (no missing_credential warn)',
    preflightWarns.length === 0,
    JSON.stringify(preflightWarns).slice(0, 300)
  );
} else {
  t.assert(
    'warn event names the unsatisfied TELEGRAM_BOT_TOKEN slot before the run',
    preflightWarns.length > 0,
    JSON.stringify((run.events ?? []).filter((e) => e.type === 'warn')).slice(0, 400)
  );
}

await t.finish();
