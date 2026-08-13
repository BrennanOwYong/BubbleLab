#!/usr/bin/env node
/**
 * FE5 — sidecar as switchable backend subroutine (BACKLOG FE5, brief
 * PLAN-DOCS/discovery/FE5.md).
 *
 * Under test: the API's builder runtime manager
 * (apps/bubblelab-api/src/services/builder-runtime.ts) + the /build-runtime
 * toggle surface + the sidecar's serve-identity stamp (build_threads.served_by
 * jsonb, `served_by` SSE frame, enriched /health).
 *
 * Every build here goes THROUGH THE API PROXY (never the sidecar directly),
 * because the routing switch is the thing under test. Assertions read logged
 * events only (Pillar 2): SSE frames, the stored thread record, /build-runtime
 * status, and the /telemetry ring buffer — never the DOM.
 *
 *  1. managed: PUT {mode:'managed'} spawns a child; a build's `served_by`
 *     frame and the thread's servedBy carry {mode:'managed', pid:P_managed}.
 *  2. off: PUT {mode:'off'} kills the child (ESRCH-verified); a build POST
 *     answers 503 {error:'builder_disabled'}; the telemetry ring buffer holds
 *     `build_rejected_builder_off`; the thread's servedBy is UNCHANGED (the
 *     build went around the sidecar, nothing served it).
 *  3. external: PUT {mode:'external', url:<the stack's standalone sidecar>};
 *     a build's servedBy.pid === that sidecar's /health pid !== P_managed,
 *     servedBy.mode === 'external'.
 *  4. restart heal seam (S8): under managed, POST /build-runtime/restart
 *     yields a new child pid; the next build's servedBy.pid is the new pid.
 *
 * NOTE: the API and sidecar must be running the FE5 code (restart the stack
 * after pulling this change; a pre-FE5 API has no /build-runtime route and
 * exits this test red at step 1).
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/fe5_builder_mode.test.mjs
 */
import { createHarness } from '../harness.mjs';

const t = await createHarness({
  name: 'fe5_builder_mode',
  backlogId: 'FE5',
  timeoutMs: 25 * 60_000, // three real model turns at 1-5 min each
});

const BUILD_PROMPT =
  'Reply with the single word OK. Do not call any tools or change the flow.';

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One build turn through the API proxy; returns { frames, servedByFrame, done }. */
async function buildViaApi(flowId, timeoutMs = 6 * 60_000) {
  const frames = await t.sse(
    t.stack.api,
    `/build/${flowId}/message`,
    { message: BUILD_PROMPT },
    timeoutMs
  );
  return {
    frames,
    servedByFrame: frames.find((f) => f.event === 'served_by'),
    done: frames.find((f) => f.event === 'done'),
  };
}

async function threadViaApi(flowId) {
  const { status, body } = await t.api(`/build/${flowId}/thread`);
  if (status !== 200) {
    throw new Error(`GET /build/${flowId}/thread -> HTTP ${status}`);
  }
  return body;
}

// --- setup: baseline runtime state + a scratch flow --------------------------
t.section('setup');
const baselineRes = await t.api('/build-runtime');
t.assert(
  'GET /build-runtime responds 200 with a mode',
  baselineRes.status === 200 && typeof baselineRes.body?.mode === 'string',
  `HTTP ${baselineRes.status} ${JSON.stringify(baselineRes.body).slice(0, 200)}`
);
const original = baselineRes.body;
// Restore the stack's routing no matter how the test ends (LIFO cleanup).
t.cleanup(async () => {
  await t.api('/build-runtime', {
    method: 'PUT',
    body: JSON.stringify({ mode: original.mode, url: original.externalUrl }),
  });
});
const telemetrySince = await t.telemetryBaseline();
const flowId = await t.seedFlow({
  name: 'fe5-builder-mode',
  prompt: 'FE5 event test: builder mode toggle fixture flow',
  code: `import { BubbleFlow } from '@bubblelab/bubble-core';

export interface Output {
  greeting: string;
}

export class Fe5BuilderModeFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 6 * * *';
  async handle(): Promise<Output> {
    return { greeting: 'hello' };
  }
}
`,
});

// --- 1. managed serve asserted ----------------------------------------------
t.section('managed: API-owned child serves the build');
const managedPut = await t.api('/build-runtime', {
  method: 'PUT',
  body: JSON.stringify({ mode: 'managed' }),
});
const managedChild = managedPut.body?.child;
t.assert(
  "PUT {mode:'managed'} spawns a child (pid + healthy serveMode 'managed')",
  managedPut.status === 200 &&
    managedPut.body?.mode === 'managed' &&
    typeof managedChild?.pid === 'number' &&
    managedPut.body?.health?.ok === true &&
    managedPut.body?.health?.serveMode === 'managed',
  `HTTP ${managedPut.status} ${JSON.stringify(managedPut.body).slice(0, 400)}`
);
const pManaged = managedChild?.pid ?? -1;

const managedTurn = await buildViaApi(flowId);
t.assert(
  "served_by frame carries {mode:'managed', pid:P_managed}",
  managedTurn.servedByFrame?.data?.mode === 'managed' &&
    managedTurn.servedByFrame?.data?.pid === pManaged,
  JSON.stringify(managedTurn.servedByFrame?.data ?? null)
);
t.assert(
  "managed build turn completed (done, status != 'error')",
  managedTurn.done !== undefined && managedTurn.done.data?.status !== 'error',
  JSON.stringify(managedTurn.done?.data ?? null)
);
const managedThread = await threadViaApi(flowId);
t.assert(
  "thread servedBy === {pid:P_managed, mode:'managed'}",
  managedThread.servedBy?.pid === pManaged &&
    managedThread.servedBy?.mode === 'managed',
  JSON.stringify(managedThread.servedBy ?? null)
);

// --- 2. off refuses, logs, and leaves the thread untouched -------------------
t.section('off: builds routed around the sidecar');
const offPut = await t.api('/build-runtime', {
  method: 'PUT',
  body: JSON.stringify({ mode: 'off' }),
});
t.assert(
  "PUT {mode:'off'} -> child null, target null",
  offPut.status === 200 &&
    offPut.body?.mode === 'off' &&
    offPut.body?.child === null &&
    offPut.body?.target === null,
  `HTTP ${offPut.status} ${JSON.stringify(offPut.body).slice(0, 300)}`
);
t.assert(
  'managed child pid is gone (kill(pid,0) throws ESRCH)',
  !pidAlive(pManaged),
  `pid ${pManaged} alive=${pidAlive(pManaged)}`
);
const rejected = await t.api(`/build/${flowId}/message`, {
  method: 'POST',
  body: JSON.stringify({ message: BUILD_PROMPT }),
});
t.assert(
  'build POST under off -> HTTP 503 {error:builder_disabled}',
  rejected.status === 503 && rejected.body?.error === 'builder_disabled',
  `HTTP ${rejected.status} ${JSON.stringify(rejected.body).slice(0, 300)}`
);
const offEvents = await t.telemetry({
  type: 'build_rejected_builder_off',
  sinceSeq: telemetrySince,
});
t.assert(
  'build_rejected_builder_off logged in the telemetry ring buffer for this flow',
  offEvents.some((e) => Number(e.event?.subjectId) === flowId),
  JSON.stringify(offEvents.slice(-3)).slice(0, 400)
);
// The API's /thread also 503s while off (one switch, one meaning), so the
// stored record is read via the stack's standalone sidecar, which shares the
// same Postgres — a logged-record read, not a routing path.
const offThread = await (
  await fetch(`${t.stack.sidecar}/build/${flowId}/thread`)
).json();
t.assert(
  'thread servedBy UNCHANGED under off (no new serve happened)',
  offThread.servedBy?.pid === pManaged && offThread.servedBy?.mode === 'managed',
  JSON.stringify(offThread.servedBy ?? null)
);

// --- 3. external serve asserted ----------------------------------------------
t.section('external: standalone sidecar serves the build');
const externalHealth = await (await fetch(`${t.stack.sidecar}/health`)).json();
const pExternal = externalHealth.pid;
t.assert(
  "standalone sidecar /health exposes pid + serveMode 'external'",
  typeof pExternal === 'number' && externalHealth.serveMode === 'external',
  JSON.stringify(externalHealth)
);
const externalPut = await t.api('/build-runtime', {
  method: 'PUT',
  body: JSON.stringify({ mode: 'external', url: t.stack.sidecar }),
});
t.assert(
  "PUT {mode:'external', url} routes to the standalone sidecar",
  externalPut.status === 200 &&
    externalPut.body?.mode === 'external' &&
    externalPut.body?.target === t.stack.sidecar,
  `HTTP ${externalPut.status} ${JSON.stringify(externalPut.body).slice(0, 300)}`
);
const externalTurn = await buildViaApi(flowId);
t.assert(
  "external build turn completed (done, status != 'error')",
  externalTurn.done !== undefined && externalTurn.done.data?.status !== 'error',
  JSON.stringify(externalTurn.done?.data ?? null)
);
const externalThread = await threadViaApi(flowId);
t.assert(
  "thread servedBy === {pid:P_external, mode:'external'}, pid != P_managed",
  externalThread.servedBy?.pid === pExternal &&
    externalThread.servedBy?.mode === 'external' &&
    externalThread.servedBy?.pid !== pManaged,
  JSON.stringify(externalThread.servedBy ?? null)
);

// --- 4. restart heal seam (S8) ----------------------------------------------
t.section('restart: managed child swapped for a fresh pid');
const remanagedPut = await t.api('/build-runtime', {
  method: 'PUT',
  body: JSON.stringify({ mode: 'managed' }),
});
const pRemanaged = remanagedPut.body?.child?.pid ?? -1;
t.assert(
  're-entering managed spawns a live child',
  remanagedPut.status === 200 && typeof remanagedPut.body?.child?.pid === 'number' && pidAlive(pRemanaged),
  `HTTP ${remanagedPut.status} pid=${pRemanaged}`
);
const restartRes = await t.api('/build-runtime/restart', { method: 'POST' });
const pRestarted = restartRes.body?.child?.pid ?? -1;
t.assert(
  'POST /build-runtime/restart yields a NEW live pid',
  restartRes.status === 200 &&
    typeof restartRes.body?.child?.pid === 'number' &&
    pRestarted !== pRemanaged &&
    pidAlive(pRestarted) &&
    !pidAlive(pRemanaged),
  `HTTP ${restartRes.status} old=${pRemanaged} new=${pRestarted}`
);
const restartTurn = await buildViaApi(flowId);
const restartThread = await threadViaApi(flowId);
t.assert(
  "post-restart build served by the new pid (thread servedBy.pid === restarted pid, mode 'managed')",
  restartTurn.done !== undefined &&
    restartThread.servedBy?.pid === pRestarted &&
    restartThread.servedBy?.mode === 'managed',
  JSON.stringify(restartThread.servedBy ?? null)
);

await t.finish();
