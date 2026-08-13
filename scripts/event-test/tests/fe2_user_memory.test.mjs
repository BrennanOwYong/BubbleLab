#!/usr/bin/env node
/**
 * FE2 — agent silently remembers user default data across flows
 * (BACKLOG FE2, brief PLAN-DOCS/discovery/FE2.md).
 *
 * Under test: the hidden remember_user_default MCP tool writes to the
 * user_defaults Postgres table (scoped by the x-user-id the API build proxy
 * forwards); the write and its paired tool_result are suppressed from the live
 * SSE stream AND the rehydrated thread transcript (chip-alignment invariant),
 * while the raw session_entries transcript keeps them (Pillar 2 logged event);
 * the next turn's system prompt is injected with the stored defaults so a
 * later flow already knows the datapoint.
 *
 * Event chain asserted (logged events + stored records, never the DOM):
 * 1. Flow A turn (THROUGH the API proxy, so x-user-id forwarding is on the
 *    asserted path) captures the email via remember_user_default.
 * 2. Capture: sidecar GET /memory?userId=mock-user-id holds {email, value}.
 * 3. Write path proven, not hallucinated: raw session_entries rows for the
 *    session contain a mcp__builder__remember_user_default tool_use.
 * 4. Invisibility, live stream: no remember_user_default tool_use frame, and
 *    visible tool_use count === visible tool_result count (pairing parity —
 *    the studio closes chips by order-matching).
 * 5. Invisibility, rehydration: GET /build/:A/thread transcript has no
 *    remember_user_default block and its tool_use/tool_result counts pair off.
 * 6. Telemetry: builder.user_default_saved logged for the write.
 * 7. Cross-flow read path: a flow B turn (no email given) knows the stored
 *    email — the system-prompt injection is the only channel it could come
 *    from — and does not ask for it.
 *
 * Deviations from the brief's organic scenario (the FE1 precedent): both
 * turns are DIRECTED instructions so the machinery is asserted
 * deterministically instead of relying on a one-shot organic build choosing
 * to capture (model compliance is probabilistic — brief risk 2; the organic
 * variant stays the [USER-TEST] card). Step 7 asserts the injected knowledge
 * directly (the agent states the stored email) rather than defaultInputs of a
 * fully built flow, for the same determinism reason.
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/fe2_user_memory.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHarness } from '../harness.mjs';
import { STEPS_BRANCH_CODE } from '../lib/uxFixtures.mjs';
import { threadToolUses } from '../lib/studio.mjs';

const USER_ID = 'mock-user-id'; // API dev user (seed-dev-user.ts DEV_USER_ID)
const MEMORY_KEY = 'email';
const MEMORY_VALUE = 'fe2-test@example.com';
const HIDDEN_TOOL = 'remember_user_default';
const DB_URL =
  process.env.DATABASE_URL ??
  'postgres://bubblelab:bubblelab@localhost:5432/bubblelab';

const t = await createHarness({
  name: 'fe2_user_memory',
  backlogId: 'FE2',
  timeoutMs: 15 * 60_000,
});

/** Reduce a build turn's SSE frames to visible tool activity + text. */
function reduceTurnFrames(frames) {
  const toolUses = [];
  let toolResults = 0;
  const texts = [];
  for (const f of frames) {
    if (f.event === 'assistant' && Array.isArray(f.data?.blocks)) {
      for (const b of f.data.blocks) {
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          toolUses.push(b.name);
        } else if (b.type === 'text' && b.text) {
          texts.push(b.text);
        }
      }
    } else if (f.event === 'tool_result' && Array.isArray(f.data?.results)) {
      toolResults += f.data.results.length;
    } else if (f.event === 'result' && typeof f.data?.result === 'string') {
      texts.push(f.data.result);
    }
  }
  return { toolUses, toolResults, assistantText: texts.join('\n') };
}

function psqlScalar(sql) {
  const out = spawnSync('psql', [DB_URL, '-t', '-A', '-c', sql], {
    encoding: 'utf8',
  });
  return out.status === 0 ? out.stdout.trim() : null;
}

// --- arrange: hermetic memory state ------------------------------------------
t.section('arrange: clean memory + fixture flows');
const preClean = await fetch(
  `${t.stack.sidecar}/memory?userId=${USER_ID}&key=${MEMORY_KEY}`,
  { method: 'DELETE' }
).catch(() => null);
t.assert(
  'pre-clean DELETE /memory reachable',
  preClean !== null && preClean.status === 200,
  `status=${preClean?.status}`
);
t.cleanup(() =>
  fetch(`${t.stack.sidecar}/memory?userId=${USER_ID}&key=${MEMORY_KEY}`, {
    method: 'DELETE',
  }).catch(() => null)
);

const flowA = await t.seedFlow({
  name: 'EVENT-TEST FE2 fixture A',
  prompt: 'FE2 fixture: capture flow',
  eventType: 'schedule/cron',
  code: STEPS_BRANCH_CODE,
});
const flowB = await t.seedFlow({
  name: 'EVENT-TEST FE2 fixture B',
  prompt: 'FE2 fixture: recall flow',
  eventType: 'schedule/cron',
  code: STEPS_BRANCH_CODE,
});
t.assert('fixture flows seeded', Boolean(flowA && flowB), `A=${flowA} B=${flowB}`);
// deleteFlow orphans build_threads (known); drop the rows directly.
t.cleanup(() => {
  spawnSync('psql', [
    DB_URL,
    '-c',
    `DELETE FROM build_threads WHERE flow_id IN (${Number(flowA)}, ${Number(flowB)}) AND agent_kind = 'flow'`,
  ]);
});

// --- act: capture turn on flow A, through the API build proxy ----------------
t.section('flow A: silent capture turn (via API proxy)');
const baseline = await t.telemetryBaseline();
const CAPTURE_INSTRUCTION =
  `The user says: "Also, email me the results at ${MEMORY_VALUE}." ` +
  `Do exactly this and nothing else: first call the get_flow tool once for flow ${flowA}, ` +
  `then call the ${HIDDEN_TOOL} tool once with key '${MEMORY_KEY}', value '${MEMORY_VALUE}', ` +
  `and description "user's personal email", then reply with the single word done. ` +
  `Do not modify the flow, do not run it, do not call any other tool.`;
const framesA = await t.sse(
  t.stack.api,
  `/build/${flowA}/message`,
  { message: CAPTURE_INSTRUCTION },
  8 * 60_000
);
const turnA = reduceTurnFrames(framesA);
t.assert(
  'turn A completed with a done frame',
  framesA.some((f) => f.event === 'done'),
  `frames=${framesA.length}`
);

// 4 — live-stream invisibility + pairing parity
t.assert(
  `live stream carries NO ${HIDDEN_TOOL} tool_use frame`,
  !turnA.toolUses.some((name) => name.endsWith(HIDDEN_TOOL)),
  JSON.stringify(turnA.toolUses)
);
t.assert(
  'a visible tool_use survived suppression (get_flow — suppression is not a blanket drop)',
  turnA.toolUses.some((name) => name.endsWith('get_flow')),
  JSON.stringify(turnA.toolUses)
);
t.assert(
  'visible tool_use count === visible tool_result count (chip pairing parity)',
  turnA.toolUses.length === turnA.toolResults,
  `uses=${turnA.toolUses.length} results=${turnA.toolResults}`
);

// 2 — capture stored under the proxied user id
const memory = await fetch(`${t.stack.sidecar}/memory?userId=${USER_ID}`).then(
  (r) => r.json()
);
const storedRow = (memory.defaults ?? []).find((d) => d.key === MEMORY_KEY);
t.assert(
  `GET /memory holds {key:'${MEMORY_KEY}', value:'${MEMORY_VALUE}'} for ${USER_ID} (x-user-id forwarded)`,
  storedRow?.value === MEMORY_VALUE,
  JSON.stringify(memory).slice(0, 300)
);
t.assert(
  'stored row carries provenance (source_flow_id = flow A)',
  storedRow?.sourceFlowId === flowA,
  JSON.stringify(storedRow)
);

// 3 + 5 — raw transcript keeps the call; rehydrated transcript hides it, paired
const threadA = await t.buildThread(flowA);
t.assert('thread A has a sessionId', Boolean(threadA?.sessionId), threadA?.status);
const rawCount = psqlScalar(
  `SELECT count(*) FROM session_entries WHERE session_id = '${threadA?.sessionId}' AND entry::text LIKE '%mcp__builder__${HIDDEN_TOOL}%'`
);
t.assert(
  `raw session_entries contain the mcp__builder__${HIDDEN_TOOL} tool_use (write path proven)`,
  Number(rawCount) >= 1,
  `rawCount=${rawCount}`
);
const hiddenInThread = threadToolUses(threadA, HIDDEN_TOOL);
t.assert(
  `rehydrated transcript carries NO ${HIDDEN_TOOL} block`,
  hiddenInThread.length === 0,
  JSON.stringify(hiddenInThread).slice(0, 200)
);
let threadUses = 0;
let threadResults = 0;
for (const item of threadA?.transcript ?? []) {
  for (const block of item.blocks ?? []) {
    if (block.type === 'tool_use') threadUses += 1;
    else if (block.type === 'tool_result') threadResults += 1;
  }
}
t.assert(
  'rehydrated tool_use/tool_result counts pair off (no orphaned result)',
  threadUses === threadResults,
  `uses=${threadUses} results=${threadResults}`
);

// 6 — the silent write is an assertable logged event
const telemetryEvents = await t.telemetry({ sinceSeq: baseline });
const savedEvents = telemetryEvents.filter(
  (e) =>
    e.event?.event === 'builder.user_default_saved' &&
    e.event?.key === MEMORY_KEY &&
    e.event?.subjectId === flowA
);
t.assert(
  'telemetry logged builder.user_default_saved for the capture',
  savedEvents.length >= 1,
  `count=${savedEvents.length}`
);

// --- act: recall turn on flow B, no email given ------------------------------
t.section('flow B: cross-flow recall turn (no email in the message)');
const RECALL_INSTRUCTION =
  `Without calling any tools: if you already know this user's default email ` +
  `address, reply with exactly that email address and nothing else. ` +
  `If you do not know it, reply with exactly the single word UNKNOWN. ` +
  `Do not ask the user any question.`;
const framesB = await t.sse(
  t.stack.api,
  `/build/${flowB}/message`,
  { message: RECALL_INSTRUCTION },
  8 * 60_000
);
const turnB = reduceTurnFrames(framesB);
t.assert(
  'turn B completed with a done frame',
  framesB.some((f) => f.event === 'done'),
  `frames=${framesB.length}`
);
t.assert(
  `flow B's agent knows ${MEMORY_VALUE} without being told (system-prompt injection)`,
  turnB.assistantText.includes(MEMORY_VALUE),
  turnB.assistantText.slice(0, 300)
);
t.assert(
  'flow B did not answer UNKNOWN (no re-ask, datapoint carried across flows)',
  !turnB.assistantText.includes('UNKNOWN'),
  turnB.assistantText.slice(0, 300)
);

await t.finish();
