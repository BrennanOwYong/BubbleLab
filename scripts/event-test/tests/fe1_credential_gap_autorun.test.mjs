#!/usr/bin/env node
/**
 * FE1 — credential-gap auto-run (BACKLOG FE1, brief PLAN-DOCS/discovery/FE1.md).
 *
 * Under test: API credential writes fire POST /internal/credentials-changed at
 * the sidecar, which scans blocked_on_credential build threads and runs the
 * persisted deferred setup headless (runBuildTurn autoUnblockOnly). No user
 * chat message is sent after the arrange step — that is the point.
 *
 * Event chain asserted (Pillar 2, logged events only):
 * 1. Arrange: a directed build turn calls report_missing_credential for a
 *    credential type the user does NOT have -> thread blocked_on_credential.
 * 2. NEGATIVE CONTROL (cost guard): adding a credential of a DIFFERENT type
 *    kicks the scan but must not unblock — deferred_setup.lastAttempt records
 *    {reason naming the still-missing type, trigger 'credential-added'},
 *    status stays blocked, telemetry logs builder.auto_unblock resolved:false,
 *    and no execution ran (no agent turn burned).
 * 3. Adding the RIGHT type auto-resolves: deferredSetup.resolvedAt set with
 *    resolvedBy 'credential-added' (proves the trigger, not a user turn),
 *    the transcript gains the [Automatic setup notice] user message, and the
 *    thread settles at 'ready'. Telemetry logs credentials.builder_notify,
 *    builder.credentials_changed{kicked}, builder.auto_unblock{resolved:true}.
 *
 * Deviation from the brief's scenario 1: the blocked state is arranged with a
 * directed instruction (the u-1 pattern) instead of an organic build, and the
 * resumed turn is instructed to reply 'done' — so the test asserts the FE1
 * trigger machinery deterministically without depending on a one-shot organic
 * build choosing report_missing_credential/test_run_flow. The organic variant
 * (real Sheets gap + provision_spreadsheet) stays a manual/gated scenario.
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/fe1_credential_gap_autorun.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHarness } from '../harness.mjs';
import { STEPS_BRANCH_CODE } from '../lib/uxFixtures.mjs';
import { threadToolUses } from '../lib/studio.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t = await createHarness({
  name: 'fe1_credential_gap_autorun',
  backlogId: 'FE1',
  timeoutMs: 15 * 60_000,
});

// --- pick gap + control types the user does NOT have ------------------------
// Dynamic pick keeps the test deterministic regardless of what credentials the
// dev box already holds (the resolver checks USER credentials via
// GET /credentials; platform env backing is irrelevant to it).
t.section('arrange: pick missing credential types');
const CANDIDATES = [
  'FIRECRAWL_API_KEY',
  'CRUSTDATA_API_KEY',
  'FULLENRICH_API_KEY',
  'APIFY_CRED',
];
const credsList = await t.api('/credentials');
t.assert('GET /credentials responds 200', credsList.status === 200, `HTTP ${credsList.status}`);
const ownedTypes = new Set(
  (Array.isArray(credsList.body) ? credsList.body : []).map((c) => c.credentialType)
);
const missing = CANDIDATES.filter((type) => !ownedTypes.has(type));
t.assert(
  'two candidate credential types are unconnected (gap + negative control)',
  missing.length >= 2,
  `owned=${JSON.stringify([...ownedTypes])} missing=${JSON.stringify(missing)}`
);
const GAP_TYPE = missing[0];
const WRONG_TYPE = missing[1];
if (!GAP_TYPE || !WRONG_TYPE) await t.finish();

// --- arrange the blocked thread ---------------------------------------------
t.section('arrange: blocked build thread');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST FE1 fixture',
  prompt: 'FE1 fixture: flow blocked on a missing credential',
  eventType: 'schedule/cron',
  code: STEPS_BRANCH_CODE,
});
t.assert('fixture flow seeded', Boolean(flowId), `flowId=${flowId}`);

// Best-effort orphan guard: if the test dies while the thread is still
// blocked, the row would be re-kicked on every future credential write.
// deleteFlow orphans build_threads (known), so drop the row directly.
t.cleanup(() => {
  const url =
    process.env.DATABASE_URL ??
    'postgres://bubblelab:bubblelab@localhost:5432/bubblelab';
  spawnSync('psql', [
    url,
    '-c',
    `DELETE FROM build_threads WHERE flow_id = ${Number(flowId)} AND agent_kind = 'flow'`,
  ]);
});

const INSTRUCTION =
  `Do exactly this and nothing else: call the report_missing_credential tool once ` +
  `with credentialType '${GAP_TYPE}' and deferredSetupScript []. ` +
  `Then reply with the single word done. Do not modify the flow, do not run it, do not call any other tool. ` +
  `If this session is ever resumed later — for any reason, including an automatic setup notice — ` +
  `reply with the single word done and call no tools.`;

const turn = await t.buildMessage(flowId, INSTRUCTION, 8 * 60_000);
t.assert(
  'arrange turn called report_missing_credential',
  turn.toolCalls.some((tc) => tc.name.endsWith('report_missing_credential')),
  JSON.stringify(turn.toolCalls).slice(0, 300)
);
const blockedThread = await t.buildThread(flowId);
t.assert(
  "thread status is 'blocked_on_credential'",
  blockedThread?.status === 'blocked_on_credential',
  blockedThread?.status
);
t.assert(
  `deferredSetup.credentialType is ${GAP_TYPE}`,
  blockedThread?.deferredSetup?.credentialType === GAP_TYPE,
  JSON.stringify(blockedThread?.deferredSetup).slice(0, 300)
);
const reportUses = threadToolUses(blockedThread, 'report_missing_credential');
t.assert(
  'transcript logs the report_missing_credential tool_use',
  reportUses.some((input) => input.credentialType === GAP_TYPE),
  JSON.stringify(reportUses).slice(0, 300)
);

const execsBefore = await t.executions(flowId, 5);

// --- negative control: wrong-type credential must not unblock ---------------
t.section('negative control: unrelated credential add (cost guard)');
const negBaseline = await t.telemetryBaseline();
const wrongCred = await t.api('/credentials', {
  method: 'POST',
  body: JSON.stringify({
    credentialType: WRONG_TYPE,
    value: 'fe1-event-test-not-a-real-key',
    name: 'fe1 event-test wrong-type',
    skipValidation: true,
  }),
});
t.assert(
  'wrong-type credential created',
  wrongCred.status === 201 || wrongCred.status === 200,
  `HTTP ${wrongCred.status}: ${JSON.stringify(wrongCred.body).slice(0, 200)}`
);
const wrongCredId = wrongCred.body?.id;
if (wrongCredId) {
  t.cleanup(() => t.api(`/credentials/${wrongCredId}`, { method: 'DELETE' }));
}

// The kick is background; poll for the persisted lastAttempt annotation.
let negThread = null;
for (let i = 0; i < 12; i++) {
  await sleep(5000);
  negThread = await t.buildThread(flowId);
  if (negThread?.deferredSetup?.lastAttempt) break;
}
t.assert(
  'thread STAYS blocked_on_credential after the wrong-type add',
  negThread?.status === 'blocked_on_credential',
  negThread?.status
);
const lastAttempt = negThread?.deferredSetup?.lastAttempt;
t.assert(
  "deferredSetup.lastAttempt persisted with trigger 'credential-added'",
  lastAttempt?.trigger === 'credential-added',
  JSON.stringify(lastAttempt)
);
t.assert(
  `lastAttempt.reason names the still-missing type ${GAP_TYPE}`,
  typeof lastAttempt?.reason === 'string' && lastAttempt.reason.includes(GAP_TYPE),
  lastAttempt?.reason
);
t.assert(
  'deferredSetup.resolvedAt still unset',
  negThread?.deferredSetup?.resolvedAt === undefined,
  JSON.stringify(negThread?.deferredSetup).slice(0, 300)
);
const negTelemetry = await t.telemetry({ sinceSeq: negBaseline });
const negNotify = negTelemetry.filter(
  (e) => e.event?.event === 'credentials.builder_notify' && e.event?.credentialType === WRONG_TYPE
);
t.assert(
  'API logged credentials.builder_notify for the wrong-type write',
  negNotify.length >= 1,
  `count=${negNotify.length}`
);
const negUnblock = negTelemetry.filter(
  (e) => e.event?.event === 'builder.auto_unblock' && e.event?.subjectId === flowId
);
t.assert(
  'sidecar logged builder.auto_unblock with resolved:false (no agent turn burned)',
  negUnblock.some((e) => e.event?.resolved === false),
  JSON.stringify(negUnblock.map((e) => e.event)).slice(0, 300)
);
const execsAfterNeg = await t.executions(flowId, 5);
t.assert(
  'no new execution appeared during the negative control',
  execsAfterNeg.length === execsBefore.length,
  `before=${execsBefore.length} after=${execsAfterNeg.length}`
);

// --- act: add the RIGHT credential; no chat message from here on ------------
t.section('auto-run: right-type credential add');
const posBaseline = await t.telemetryBaseline();
const gapCred = await t.api('/credentials', {
  method: 'POST',
  body: JSON.stringify({
    credentialType: GAP_TYPE,
    value: 'fe1-event-test-gap-key',
    name: 'fe1 event-test gap credential',
    skipValidation: true,
  }),
});
t.assert(
  'gap-type credential created',
  gapCred.status === 201 || gapCred.status === 200,
  `HTTP ${gapCred.status}: ${JSON.stringify(gapCred.body).slice(0, 200)}`
);
const gapCredId = gapCred.body?.id;
if (gapCredId) {
  t.cleanup(() => t.api(`/credentials/${gapCredId}`, { method: 'DELETE' }));
}

// The headless resume runs a (small, instructed) agent turn: poll for the
// resolution annotation, then for the settled status.
let posThread = null;
const deadline = Date.now() + 6 * 60_000;
while (Date.now() < deadline) {
  await sleep(5000);
  posThread = await t.buildThread(flowId);
  if (posThread?.deferredSetup?.resolvedAt && posThread.status !== 'building') break;
}
t.assert(
  'deferredSetup.resolvedAt set without any user message',
  Boolean(posThread?.deferredSetup?.resolvedAt),
  JSON.stringify(posThread?.deferredSetup).slice(0, 300)
);
t.assert(
  "deferredSetup.resolvedBy === 'credential-added' (the FE1 trigger, not a user turn)",
  posThread?.deferredSetup?.resolvedBy === 'credential-added',
  posThread?.deferredSetup?.resolvedBy
);
t.assert(
  "thread status settled at 'ready' (left blocked_on_credential)",
  posThread?.status === 'ready',
  posThread?.status
);
const noticeTurn = (posThread?.transcript ?? []).find(
  (item) =>
    item.role === 'user' &&
    (item.blocks ?? []).some(
      (b) => b.type === 'text' && b.text?.includes('[Automatic setup notice')
    )
);
t.assert(
  'transcript carries the [Automatic setup notice] resume message',
  Boolean(noticeTurn),
  `transcript length=${posThread?.transcript?.length}`
);
const posTelemetry = await t.telemetry({ sinceSeq: posBaseline });
const posNotify = posTelemetry.filter(
  (e) => e.event?.event === 'credentials.builder_notify' && e.event?.credentialType === GAP_TYPE
);
t.assert(
  'API logged credentials.builder_notify for the gap-type write',
  posNotify.length >= 1,
  `count=${posNotify.length}`
);
const kickEvents = posTelemetry.filter(
  (e) => e.event?.event === 'builder.credentials_changed'
);
t.assert(
  'sidecar logged builder.credentials_changed with this thread kicked',
  kickEvents.some((e) =>
    (e.event?.kicked ?? []).some((k) => k.subjectId === flowId)
  ),
  JSON.stringify(kickEvents.map((e) => e.event)).slice(0, 300)
);
const posUnblock = posTelemetry.filter(
  (e) => e.event?.event === 'builder.auto_unblock' && e.event?.subjectId === flowId
);
t.assert(
  'sidecar logged builder.auto_unblock with resolved:true',
  posUnblock.some((e) => e.event?.resolved === true),
  JSON.stringify(posUnblock.map((e) => e.event)).slice(0, 300)
);

await t.finish();
