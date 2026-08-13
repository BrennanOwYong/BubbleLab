#!/usr/bin/env node
/**
 * S6 — fixer binary-triage grounding (BACKLOG S6, brief PLAN-DOCS/discovery/S6.md).
 *
 * Root cause under test: prompts.ts hard-coded "the action is ALWAYS
 * reconnect" for any auth-shaped error text, and the flow agent had no tool
 * exposing bound-slot / health / SYSTEM state — so classification could not
 * be grounded in the failure layer (the Firecrawl misdiagnosis). Fix: the
 * two ALWAYS passages are replaced by one shared grounded decision table
 * (CREDENTIAL_TRIAGE), a new flow-agent tool inspect_flow_credentials wraps
 * the new GET /bubble-flow/:id/credential-state endpoint, and Branch P is a
 * table-licensed platform-fault terminal.
 *
 * Sections 1-3 are deterministic endpoint/telemetry assertions. Sections 4-5
 * drive real fixer turns (a minute or more each; model compliance is
 * probabilistic, so the hard evidence asserted is the inspect_flow_credentials
 * tool_use block in the thread plus the reply's connect/reconnect wording).
 *
 * Injection notes (deviations from the brief, discovered on the live stack):
 *  - Brief Case 1 (SYSTEM + env unset): post-S1, declared-SYSTEM types
 *    without env backing behave as USER credentials, so that layer is now a
 *    Branch-B connect case. The platform layer is asserted through the
 *    endpoint's platformProvided/systemEnvPresent fields (section 2), which
 *    decision-table row 5 keys on.
 *  - The brief's "bound but not injected" (unrecognized call site) injection
 *    is closed at authoring time: S2's lint HARD-rejects ternary bubble calls
 *    at validate (valid:false), so the flow cannot be seeded. Section 5
 *    records that prevention, and asserts the bound-AND-HEALTHY analog
 *    instead: a working credential bound while the run fails for a
 *    non-credential reason — the fixer must ground via inspect and must NOT
 *    tell the user to reconnect (the S6 contract acceptance).
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/s6_fixer_triage.test.mjs
 */
import { createHarness } from '../harness.mjs';
import { composeFixRequestMessage } from '../lib/signals.mjs';

const t = await createHarness({
  name: 's6_fixer_triage',
  backlogId: 'S6',
  timeoutMs: 25 * 60_000, // two fixer turns + three runs
});

const telemetryBase = await t.telemetryBaseline();

/** Sidecar tool names arrive namespaced (mcp__builder__<name>). */
const calledTool = (turn, name) =>
  turn.toolCalls.some((call) => call.name === name || call.name.endsWith(`__${name}`));
const toolNames = (turn) => JSON.stringify(turn.toolCalls.map((call) => call.name));

const TELEGRAM_FLOW_CODE = (marker) => `import { BubbleFlow, TelegramBubble } from '@bubblelab/bubble-core';

export interface Output {
  ok: boolean;
  failures: string[];
}

export class S6TelegramFlow${marker} extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 7 * * *';
  async handle(): Promise<Output> {
    const failures: string[] = [];
    const sent = await new TelegramBubble({
      operation: 'send_message',
      chat_id: '1',
      text: 'S6 triage probe ${marker}',
    }).action();
    if (!sent.success) failures.push('telegram send failed: ' + (sent.error ?? 'unknown'));
    return { ok: sent.success, failures };
  }
}
`;

/** Force-bind a credential id onto the flow's telegram bubble (deterministic
 * regardless of how many rows of the type exist — single-match auto-bind
 * would otherwise skip multi-row types). */
async function bindTelegramCredential(flowId, credId) {
  const details = await t.api(`/bubble-flow/${flowId}`);
  const params = details.body?.bubbleParameters ?? {};
  const entry = Object.entries(params).find(([, b]) => b?.bubbleName === 'telegram');
  if (!entry) return false;
  const [key, bubble] = entry;
  const parameters = bubble.parameters ?? [];
  const credParam = parameters.find((p) => p.name === 'credentials');
  if (credParam) {
    credParam.value = { TELEGRAM_BOT_TOKEN: credId };
  } else {
    parameters.push({
      name: 'credentials',
      value: { TELEGRAM_BOT_TOKEN: credId },
      type: 'object',
    });
  }
  const put = await t.api(`/bubble-flow/${flowId}`, {
    method: 'PUT',
    body: JSON.stringify({
      bubbleParameters: { ...params, [key]: { ...bubble, parameters } },
    }),
  });
  return put.status === 200;
}

// ---------------------------------------------------------------------------
// 1. Grounding endpoint: bound / dangling / count state (deterministic)
// ---------------------------------------------------------------------------
t.section('GET /bubble-flow/:id/credential-state — user-credential slot');

const preExistingCreds = await t.api('/credentials');
t.assert(
  'GET /credentials responds 200',
  preExistingCreds.status === 200,
  `HTTP ${preExistingCreds.status}`
);
const priorTelegramRows = (preExistingCreds.body ?? []).filter(
  (c) => c.credentialType === 'TELEGRAM_BOT_TOKEN'
);

// skipValidation: the create route live-validates values with the provider by
// default, and the whole point of this fixture is a stored-but-rejected value.
const credCreate = await t.api('/credentials', {
  method: 'POST',
  body: JSON.stringify({
    credentialType: 'TELEGRAM_BOT_TOKEN',
    value: '000000000:s6-garbage-not-a-real-telegram-token',
    name: 's6 event-test telegram (garbage)',
    skipValidation: true,
  }),
});
t.assert(
  'garbage TELEGRAM_BOT_TOKEN credential seeded (skipValidation)',
  (credCreate.status === 201 || credCreate.status === 200) &&
    typeof credCreate.body?.id === 'number',
  `HTTP ${credCreate.status}: ${JSON.stringify(credCreate.body).slice(0, 200)}`
);
const garbageCredId = credCreate.body?.id;
let garbageCredDeleted = false;
t.cleanup(async () => {
  if (!garbageCredDeleted && garbageCredId) {
    await t.api(`/credentials/${garbageCredId}`, { method: 'DELETE' });
  }
});

const boundFlowId = await t.seedFlow({
  name: 's6-bound-telegram',
  prompt: 'S6 event test: bound telegram credential triage',
  code: TELEGRAM_FLOW_CODE('A'),
});
t.assert(
  'garbage credential force-bound onto the telegram slot',
  garbageCredId !== undefined && (await bindTelegramCredential(boundFlowId, garbageCredId)),
  `credId=${garbageCredId}`
);

const state1 = await t.api(`/bubble-flow/${boundFlowId}/credential-state`);
t.assert('credential-state responds 200', state1.status === 200, `HTTP ${state1.status}`);
const slot1 = (state1.body?.slots ?? []).find(
  (s) => s.credentialType === 'TELEGRAM_BOT_TOKEN'
);
t.assert(
  'slot reports the bound garbage credential (bound + row exists + count)',
  Boolean(slot1) &&
    slot1.boundCredentialId === garbageCredId &&
    slot1.boundRowExists === true &&
    slot1.system === false &&
    slot1.platformProvided === false &&
    slot1.userCredentialsOfType === priorTelegramRows.length + 1 &&
    slot1.boundCredential?.id === garbageCredId,
  JSON.stringify(slot1 ?? state1.body).slice(0, 400)
);

// Dangling-id detection: delete the bound row; the slot keeps the stale id
// (auto-bind only fills UNBOUND slots) and boundRowExists flips false.
t.section('dangling bound id');
const delRes = await t.api(`/credentials/${garbageCredId}`, { method: 'DELETE' });
garbageCredDeleted = delRes.status === 200 || delRes.status === 204;
t.assert('garbage credential row deleted', garbageCredDeleted, `HTTP ${delRes.status}`);
const state2 = await t.api(`/bubble-flow/${boundFlowId}/credential-state`);
const slot2 = (state2.body?.slots ?? []).find(
  (s) => s.credentialType === 'TELEGRAM_BOT_TOKEN'
);
t.assert(
  'deleted bound row surfaces as dangling (boundRowExists false)',
  Boolean(slot2) &&
    slot2.boundCredentialId === garbageCredId &&
    slot2.boundRowExists === false,
  JSON.stringify(slot2 ?? state2.body).slice(0, 400)
);

// ---------------------------------------------------------------------------
// 2. Grounding endpoint: SYSTEM / platform classification (deterministic)
// ---------------------------------------------------------------------------
t.section('credential-state SYSTEM classification vs /credentials/platform-types');
const SYSTEM_FLOW_CODE = `import { BubbleFlow, AIAgentBubble } from '@bubblelab/bubble-core';

export interface Output {
  answer: string;
}

export class S6SystemSlotFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 8 * * *';
  async handle(): Promise<Output> {
    const agent = new AIAgentBubble({
      message: 'Search the web for BubbleLab and answer in one line.',
      tools: [{ name: 'web-search-tool' }],
    });
    const result = await agent.action();
    return { answer: JSON.stringify(result.data?.response ?? '') };
  }
}
`;
const systemFlowId = await t.seedFlow({
  name: 's6-system-slot',
  prompt: 'S6 event test: SYSTEM slot classification',
  code: SYSTEM_FLOW_CODE,
});
const platform = await t.api('/credentials/platform-types');
const platformTypes = platform.body?.platformCredentialTypes ?? [];
const state3 = await t.api(`/bubble-flow/${systemFlowId}/credential-state`);
const firecrawlSlot = (state3.body?.slots ?? []).find(
  (s) => s.credentialType === 'FIRECRAWL_API_KEY'
);
t.assert(
  'FIRECRAWL slot present with system=true',
  Boolean(firecrawlSlot) && firecrawlSlot.system === true,
  JSON.stringify(firecrawlSlot ?? state3.body).slice(0, 400)
);
const envBacked = platformTypes.includes('FIRECRAWL_API_KEY');
t.assert(
  'platformProvided/systemEnvPresent match the S1 platform-types seam',
  Boolean(firecrawlSlot) &&
    firecrawlSlot.platformProvided === envBacked &&
    firecrawlSlot.systemEnvPresent === envBacked,
  `slot=${JSON.stringify(firecrawlSlot).slice(0, 200)} platformTypes=${JSON.stringify(platformTypes)}`
);

// ---------------------------------------------------------------------------
// 3. Pillar-2 event: every grounding read is a queryable telemetry event
// ---------------------------------------------------------------------------
t.section('flow.credential_state.read telemetry');
const stateEvents = await t.telemetry({
  type: 'flow.credential_state.read',
  sinceSeq: telemetryBase,
});
t.assert(
  'credential-state reads recorded for both fixture flows',
  stateEvents.some((e) => e.event?.flowId === boundFlowId) &&
    stateEvents.some((e) => e.event?.flowId === systemFlowId),
  `events=${JSON.stringify(stateEvents.map((e) => e.event?.flowId))}`
);
t.assert(
  'event carries slot classification counters (incl. a dangling read)',
  stateEvents.every(
    (e) =>
      typeof e.event?.slotCount === 'number' &&
      typeof e.event?.unboundSlots === 'number' &&
      typeof e.event?.danglingSlots === 'number' &&
      typeof e.event?.platformProvidedSlots === 'number'
  ) && stateEvents.some((e) => e.event?.danglingSlots > 0),
  JSON.stringify(stateEvents.map((e) => e.event)).slice(0, 400)
);

// ---------------------------------------------------------------------------
// 4. Fixer turn — bound garbage credential: reconnect stays CORRECT, grounded
// ---------------------------------------------------------------------------
t.section('fixer turn: bound-but-rejected credential -> grounded reconnect');
const credCreate2 = await t.api('/credentials', {
  method: 'POST',
  body: JSON.stringify({
    credentialType: 'TELEGRAM_BOT_TOKEN',
    value: '000000001:s6-garbage-not-a-real-telegram-token',
    name: 's6 event-test telegram (garbage 2)',
    skipValidation: true,
  }),
});
const garbageCredId2 = credCreate2.body?.id;
let garbageCred2Deleted = false;
t.cleanup(async () => {
  if (!garbageCred2Deleted && garbageCredId2) {
    await t.api(`/credentials/${garbageCredId2}`, { method: 'DELETE' });
  }
});
t.assert(
  'second garbage credential seeded and bound',
  typeof garbageCredId2 === 'number' &&
    (await bindTelegramCredential(boundFlowId, garbageCredId2)),
  `credId=${garbageCredId2}`
);

const run1 = await t.executeStream(boundFlowId, {}, 180_000);
const run1AuthShaped = (run1.signals ?? []).some((s) =>
  /unauthorized|auth|401|token/i.test(s.message)
);
t.assert(
  'precondition: run with garbage bound token fails with an auth-shaped signal',
  (run1.signals?.length ?? 0) > 0 && run1AuthShaped,
  JSON.stringify(run1.signals ?? []).slice(0, 400)
);

if ((run1.signals?.length ?? 0) > 0) {
  const details1 = await t.api(`/bubble-flow/${boundFlowId}`);
  const fixMsg1 = composeFixRequestMessage(
    run1.events,
    undefined,
    details1.body?.bubbleParameters
  );
  const turn1 = await t.buildMessage(boundFlowId, fixMsg1, 420_000);
  t.assert(
    'grounding ran: inspect_flow_credentials tool_use in the fixer turn',
    calledTool(turn1, 'inspect_flow_credentials'),
    toolNames(turn1)
  );
  t.assert(
    'reply issues the licensed Branch-B action (reconnect/re-enter, naming Telegram)',
    /reconnect|re-?enter|re-?connect|setup tab/i.test(turn1.assistantText) &&
      /telegram/i.test(turn1.assistantText),
    turn1.assistantText.slice(0, 500)
  );
  t.assert(
    'no code workaround for the setup problem (no save_flow in the turn)',
    !calledTool(turn1, 'save_flow'),
    toolNames(turn1)
  );
}

// Remove the garbage row BEFORE section 5: the fixer's save_flow re-parses
// bubbleParameters and server auto-bind re-fills the slot from the user's
// rows — a leftover garbage telegram row would poison the bound-and-healthy
// scenario (observed in run 2: the healthy flow re-bound to the garbage cred
// after save_flow, turning the correct no-reconnect case into a reconnect one).
{
  const del2 = await t.api(`/credentials/${garbageCredId2}`, { method: 'DELETE' });
  garbageCred2Deleted = del2.status === 200 || del2.status === 204;
  t.assert('garbage credential 2 removed before the healthy-bound case', garbageCred2Deleted, `HTTP ${del2.status}`);
}

// ---------------------------------------------------------------------------
// 5. Fixer turn — the S6 contract acceptance: credential bound AND healthy,
//    run fails for a non-credential reason. The fixer must ground via
//    inspect_flow_credentials and must NOT tell the user to reconnect.
//    (The brief's unrecognized-call-site injection is lint-closed — recorded
//    below — so the bound-and-healthy analog carries the acceptance.)
// ---------------------------------------------------------------------------
t.section('fixer turn: bound + healthy credential -> NO reconnect instruction');

const TERNARY_FLOW_CODE = `import { BubbleFlow, TelegramBubble } from '@bubblelab/bubble-core';

export interface Output {
  ok: boolean;
}

export class S6ResolutionLayerFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 9 * * *';
  async handle(): Promise<Output> {
    const verbose = true;
    const sent = verbose
      ? await new TelegramBubble({ operation: 'send_message', chat_id: '1', text: 'S6 A' }).action()
      : await new TelegramBubble({ operation: 'send_message', chat_id: '1', text: 'S6 B' }).action();
    return { ok: sent.success };
  }
}
`;
let ternaryRejected = false;
try {
  await t.seedFlow({
    name: 's6-ternary-probe',
    prompt: 'S6 event test: ternary call-site probe',
    code: TERNARY_FLOW_CODE,
  });
} catch (e) {
  ternaryRejected = /ternary|call site|lint|valid/i.test(String(e?.message ?? ''));
}
t.assert(
  'unrecognized-call-site injection is closed at authoring time (S2 lint rejects the ternary)',
  ternaryRejected,
  'ternary flow seeded without rejection — the silent credential-less trap is open again'
);

if (priorTelegramRows.length === 0) {
  t.assert(
    'bound-and-healthy fixer case skipped: stack has no working TELEGRAM_BOT_TOKEN row',
    true,
    'seed a real telegram credential on this stack to exercise section 5'
  );
} else {
  const healthyCredId = priorTelegramRows[0].id;
  const healthyFlowId = await t.seedFlow({
    name: 's6-healthy-bound-telegram',
    prompt: 'S6 event test: healthy bound credential, non-credential failure',
    code: TELEGRAM_FLOW_CODE('B'),
  });
  t.assert(
    'working credential force-bound onto the telegram slot',
    await bindTelegramCredential(healthyFlowId, healthyCredId),
    `credId=${healthyCredId}`
  );

  const run2 = await t.executeStream(healthyFlowId, {}, 180_000);
  t.assert(
    'precondition: run fails although the bound credential is real (chat_id placeholder)',
    (run2.signals?.length ?? 0) > 0,
    JSON.stringify(run2.signals ?? []).slice(0, 400)
  );

  if ((run2.signals?.length ?? 0) > 0) {
    const details2 = await t.api(`/bubble-flow/${healthyFlowId}`);
    const fixMsg2 = composeFixRequestMessage(
      run2.events,
      undefined,
      details2.body?.bubbleParameters
    );
    const turn2 = await t.buildMessage(healthyFlowId, fixMsg2, 420_000);
    t.assert(
      'grounding ran: inspect_flow_credentials tool_use in the fixer turn',
      calledTool(turn2, 'inspect_flow_credentials'),
      toolNames(turn2)
    );
    t.assert(
      'S6 acceptance: the reply does NOT tell the user to reconnect a bound-and-healthy credential',
      !/reconnect/i.test(turn2.assistantText),
      turn2.assistantText.slice(0, 500)
    );
    t.assert(
      'the actual layer is addressed: a code/input fix was saved (Branch A) or the non-credential cause is named',
      calledTool(turn2, 'save_flow') ||
        /(chat.?id|input|code|not a credential|platform|our side|resolution)/i.test(
          turn2.assistantText
        ),
      `tools=${toolNames(turn2)} text=${turn2.assistantText.slice(0, 300)}`
    );
  }
}

await t.finish();
