#!/usr/bin/env node
/**
 * S4 — requirement-completeness (BACKLOG S4, brief PLAN-DOCS/discovery/S4.md).
 *
 * Three stacked defects under test:
 *  1. The sidecar self-test gate counted only error/fatal events, so a run
 *     with failed steps / HTTP >= 400 / run-level failure / failed nested
 *     tools reported success: true. New gate: success = streamCompleted &&
 *     signals.length === 0, where signals mirror the studio's
 *     collectRunErrorSignals plus a sidecar-only 'tool' class.
 *  2. Step outputs were discarded, so fulfillment was unverifiable. New
 *     summary carries stepOutcomes/toolCalls with outputDigest + emptyOutput.
 *  3. Early-return dependency chains masked downstream failures. Fixture code
 *     follows the new continue-past-failure authoring rule; one run must
 *     carry EVERY independent failure.
 *
 * Test A (deterministic, real path): fixture flows against a local stub
 * server; assertions on execute-stream events, the studio collector port,
 * the sidecar reducer (via services/builder-agent/src/self-test-summary.cli.ts),
 * the sidecar.self_test.run telemetry event, and persisted run history.
 * Test B (deterministic, unit parity): captured-event fixtures fed to BOTH
 * collectors; shared classes identical, 'tool' class sidecar-only.
 * Test C (agent-loop, nondeterministic) is intentionally NOT here — per the
 * brief, A and B are the deterministic gate.
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/s4_requirement_completeness.test.mjs
 */
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createHarness, runErrorSignals } from '../harness.mjs';
import { repoRoot } from '../lib/stack.mjs';

const t = await createHarness({ name: 's4_requirement_completeness', backlogId: 'S4' });

const CLI = join(
  repoRoot(),
  'services',
  'builder-agent',
  'src',
  'self-test-summary.cli.ts'
);

/** Project a signal (either collector) to the parity-comparable core. */
const core = (s) => ({
  source: s.source,
  label: s.label,
  message: s.message,
  variableId: s.variableId ?? null,
  url: s.url ?? null,
});

function sidecarCollect(events) {
  const out = execFileSync('node', [CLI, 'collect'], {
    input: JSON.stringify(events),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out);
}

// MUST be async: a sync spawn would block this process's event loop and the
// stub server with it, aborting the very HTTP steps under test.
const execFileAsync = promisify(execFile);
async function sidecarRun(apiUrl, flowId) {
  const { stdout } = await execFileAsync('node', [CLI, 'run', apiUrl, String(flowId)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });
  return JSON.parse(stdout);
}

// --- local stub: /broken -> 404, /gone -> 410, /ok -> 200 -------------------
t.section('stub server');
const stub = createServer((req, res) => {
  if (req.url?.startsWith('/ok')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, payload: 'healthy content' }));
    return;
  }
  const status = req.url?.startsWith('/gone') ? 410 : 404;
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(`stub ${status}`);
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = stub.address().port;
t.cleanup(() => new Promise((resolve) => stub.close(resolve)));
const urlBroken = `http://127.0.0.1:${stubPort}/broken`;
const urlGone = `http://127.0.0.1:${stubPort}/gone`;
const urlOk = `http://127.0.0.1:${stubPort}/ok`;
t.assert('stub server listening', Number.isInteger(stubPort), `port=${stubPort}`);

// Continue-past-failure fixture shape (the new authoring rule): each step's
// failure is RECORDED into the returned result and the next independent step
// still runs — no early return.
const mixedCode = `import { BubbleFlow, HttpBubble } from '@bubblelab/bubble-core';
import type { CronEvent } from '@bubblelab/shared-schemas';

export class S4MixedFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 * * * *';

  constructor() {
    super('s4-mixed', 'S4 fixture: failing step then healthy step, continue past failure');
  }

  async handle(_payload: CronEvent): Promise<{
    brokenStatus: number;
    healthyStatus: number;
    failures: string[];
  }> {
    const failures: string[] = [];

    const fetchBroken = await new HttpBubble({
      url: '${urlBroken}',
      method: 'GET',
    }).action();
    if (!fetchBroken.success || (fetchBroken.data?.status ?? 0) >= 400) {
      failures.push('fetchBroken failed: HTTP ' + String(fetchBroken.data?.status ?? 'unknown'));
    }

    const fetchHealthy = await new HttpBubble({
      url: '${urlOk}',
      method: 'GET',
    }).action();
    if (!fetchHealthy.success || (fetchHealthy.data?.status ?? 0) >= 400) {
      failures.push('fetchHealthy failed: HTTP ' + String(fetchHealthy.data?.status ?? 'unknown'));
    }

    return {
      brokenStatus: fetchBroken.data?.status ?? 0,
      healthyStatus: fetchHealthy.data?.status ?? 0,
      failures,
    };
  }
}
`;

const doubleFailCode = `import { BubbleFlow, HttpBubble } from '@bubblelab/bubble-core';
import type { CronEvent } from '@bubblelab/shared-schemas';

export class S4DoubleFailFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 * * * *';

  constructor() {
    super('s4-double-fail', 'S4 fixture: two independent failing steps, continue past failure');
  }

  async handle(_payload: CronEvent): Promise<{
    alphaStatus: number;
    betaStatus: number;
    failures: string[];
  }> {
    const failures: string[] = [];

    const fetchAlpha = await new HttpBubble({
      url: '${urlBroken}',
      method: 'GET',
    }).action();
    if (!fetchAlpha.success || (fetchAlpha.data?.status ?? 0) >= 400) {
      failures.push('fetchAlpha failed: HTTP ' + String(fetchAlpha.data?.status ?? 'unknown'));
    }

    const fetchBeta = await new HttpBubble({
      url: '${urlGone}',
      method: 'GET',
    }).action();
    if (!fetchBeta.success || (fetchBeta.data?.status ?? 0) >= 400) {
      failures.push('fetchBeta failed: HTTP ' + String(fetchBeta.data?.status ?? 'unknown'));
    }

    return {
      alphaStatus: fetchAlpha.data?.status ?? 0,
      betaStatus: fetchBeta.data?.status ?? 0,
      failures,
    };
  }
}
`;

// ---------------------------------------------------------------------------
// Test A1 — a failed step must not stop the next independent step, and the
// failure must be a signal even though no error/fatal event exists.
// ---------------------------------------------------------------------------
t.section('A1: mixed flow — step 2 exercised despite step 1 failing');
const mixedId = await t.seedFlow({
  name: 'EVENT-TEST S4 mixed fixture',
  prompt: 'S4 fixture: 404 step then 200 step, continue past failure',
  eventType: 'schedule/cron',
  code: mixedCode,
});
const runMixed = await t.executeStream(mixedId, {});

const completes = runMixed.events.filter(
  (e) => e.type === 'bubble_execution_complete'
);
const completeVarIds = [
  ...new Set(completes.map((e) => e.variableId ?? e.additionalData?.variableId)),
].filter((v) => v !== undefined);
t.assert(
  'BOTH steps emitted bubble_execution_complete (no masking by step 1)',
  completeVarIds.length === 2,
  `variableIds=${JSON.stringify(completeVarIds)}`
);
const healthyComplete = completes.find(
  (e) => e.additionalData?.result?.data?.status === 200
);
t.assert(
  'the healthy step completed with HTTP 200 (it really ran after the failure)',
  Boolean(healthyComplete),
  healthyComplete ? 'found' : 'no 200 completion'
);

t.assert(
  'exactly 1 studio-collector signal (the failing step only)',
  runMixed.signals.length === 1,
  JSON.stringify(runMixed.signals.map(core))
);
const mixedSignal = runMixed.signals[0];
t.assert(
  "the signal is a failed-step class ('http' or 'bubble'), NOT an error/fatal event",
  mixedSignal?.source === 'http' || mixedSignal?.source === 'bubble',
  `source=${mixedSignal?.source}`
);
t.assert(
  'no top-level error/fatal event exists (the class the old gate missed)',
  !runMixed.events.some((e) => e.type === 'error' || e.type === 'fatal'),
  'old error/fatal-only reducer would have said success'
);

// ---------------------------------------------------------------------------
// Test A2 — two independent failures surface as two signals in ONE run.
// ---------------------------------------------------------------------------
t.section('A2: double-fail flow — every independent failure in one run');
const doubleId = await t.seedFlow({
  name: 'EVENT-TEST S4 double-fail fixture',
  prompt: 'S4 fixture: two failing steps (404 + 410), continue past failure',
  eventType: 'schedule/cron',
  code: doubleFailCode,
});
const runDouble = await t.executeStream(doubleId, {});
t.assert(
  '>= 2 signals in one run',
  runDouble.signals.length >= 2,
  JSON.stringify(runDouble.signals.map((s) => s.message))
);
const doubleVarIds = new Set(
  runDouble.signals.map((s) => s.variableId).filter((v) => v !== undefined)
);
t.assert(
  'the signals name DISTINCT steps (no conflation, no masking)',
  doubleVarIds.size >= 2,
  `variableIds=${JSON.stringify([...doubleVarIds])}`
);

// ---------------------------------------------------------------------------
// Test A3 — sidecar reducer parity on the full real path + Pillar-2 event.
// ---------------------------------------------------------------------------
t.section('A3: sidecar executeFlowStream parity + telemetry event');
const sinceSeq = await t.telemetryBaseline();
const summary = await sidecarRun(t.stack.api, doubleId);
t.assert(
  'sidecar summary.success === false (old reducer said true: no error/fatal)',
  summary.success === false,
  `success=${summary.success} streamCompleted=${summary.streamCompleted}`
);
t.assert(
  'sidecar signals match the studio collector 1:1 (source/label/message/variableId/url)',
  JSON.stringify(summary.signals.map(core)) ===
    JSON.stringify(runDouble.signals.map(core)),
  JSON.stringify({ sidecar: summary.signals.map(core), studio: runDouble.signals.map(core) })
);
t.assert(
  'sidecar stepOutcomes recorded for both steps with output digests',
  Array.isArray(summary.stepOutcomes) &&
    summary.stepOutcomes.length >= 2 &&
    summary.stepOutcomes.every((s) => typeof s.outputDigest === 'string'),
  JSON.stringify(summary.stepOutcomes)
);

const telemetryEvents = await t.telemetry({
  type: 'sidecar.self_test.run',
  flowId: doubleId,
  sinceSeq,
});
const selfTestEvent = telemetryEvents.find(
  (e) => e.event?.flowId === doubleId
)?.event;
t.assert(
  'sidecar.self_test.run telemetry event emitted for the run',
  Boolean(selfTestEvent),
  JSON.stringify(selfTestEvent ?? telemetryEvents.slice(-3))
);
t.assert(
  'telemetry event carries success:false and signalCount >= 2',
  selfTestEvent?.success === false && (selfTestEvent?.signalCount ?? 0) >= 2,
  JSON.stringify({ success: selfTestEvent?.success, signalCount: selfTestEvent?.signalCount })
);

// ---------------------------------------------------------------------------
// Test A4 — run history persisted BOTH failures (continuation rule held).
// ---------------------------------------------------------------------------
t.section('A4: run history carries both failures');
const items = await t.executions(doubleId, 1);
const persisted = JSON.stringify(items[0]?.result ?? null);
t.assert(
  'latest execution result records BOTH step failures',
  persisted.includes('fetchAlpha') && persisted.includes('fetchBeta'),
  persisted.slice(0, 300)
);

// ---------------------------------------------------------------------------
// Test B — unit parity on captured-event fixtures + the nested-tool class.
// ---------------------------------------------------------------------------
t.section('B: collector parity fixtures');

const TS = '2026-08-01T00:00:00.000Z';
const sharedFixtures = [
  {
    name: 'masked sheets failure (failed step, run-level success)',
    events: [
      {
        type: 'bubble_execution',
        timestamp: TS,
        bubbleName: 'google-sheets',
        variableId: 7,
        additionalData: { variableId: 7, parameters: { operation: 'append_values' } },
      },
      {
        type: 'bubble_execution_complete',
        timestamp: TS,
        bubbleName: 'google-sheets',
        variableId: 7,
        additionalData: {
          variableId: 7,
          result: { success: false, error: 'Requested entity was not found.' },
        },
      },
      { type: 'warn', timestamp: TS, message: 'sheets append failed' },
      { type: 'execution_complete', timestamp: TS, message: 'done', additionalData: { success: true } },
    ],
    expectSignals: 1,
    expectSource: 'bubble',
  },
  {
    name: 'HTTP 404 inside a green result',
    events: [
      {
        type: 'bubble_execution',
        timestamp: TS,
        bubbleName: 'http',
        variableId: 11,
        additionalData: { variableId: 11, parameters: { url: 'https://api.example/x' } },
      },
      {
        type: 'bubble_execution_complete',
        timestamp: TS,
        bubbleName: 'http',
        variableId: 11,
        additionalData: {
          variableId: 11,
          result: { success: true, data: { status: 404, statusText: 'Not Found' } },
        },
      },
      { type: 'execution_complete', timestamp: TS, message: 'done', additionalData: { success: true } },
    ],
    expectSignals: 1,
    expectSource: 'http',
  },
  {
    name: 'run-level failure',
    events: [
      { type: 'execution_complete', timestamp: TS, message: 'run failed', additionalData: { success: false } },
    ],
    expectSignals: 1,
    expectSource: 'run',
  },
  {
    name: 'plain error event',
    events: [{ type: 'error', timestamp: TS, message: 'boom' }],
    expectSignals: 1,
    expectSource: 'event',
  },
];

for (const fixture of sharedFixtures) {
  const studio = runErrorSignals(fixture.events).map(core);
  const sidecar = sidecarCollect(fixture.events);
  const sidecarCore = sidecar.signals.map(core);
  t.assert(
    `parity: ${fixture.name}`,
    JSON.stringify(studio) === JSON.stringify(sidecarCore) &&
      studio.length === fixture.expectSignals &&
      studio[0]?.source === fixture.expectSource,
    JSON.stringify({ studio, sidecar: sidecarCore })
  );
  t.assert(
    `sidecar success=false: ${fixture.name}`,
    sidecar.success === false,
    `success=${sidecar.success}`
  );
}

// Old-gate regression: the masked-sheets fixture has NO error/fatal events, so
// the pre-S4 reducer (error/fatal-only) would have declared it a success.
const masked = sharedFixtures[0];
t.assert(
  'masked fixture would pass the OLD error/fatal-only gate (the S4 defect)',
  !masked.events.some((e) => e.type === 'error' || e.type === 'fatal'),
  'new gate turns this into a red'
);

// Nested-tool class (flow-81 shape): failed web-scrape inside a green
// ai-agent step. Sidecar-only signal; the studio stays unchanged (S4 brief
// open question 2 -> sidecar-only for now).
t.section('B: nested-tool blind spot');
const toolFixture = [
  {
    type: 'bubble_execution',
    timestamp: TS,
    bubbleName: 'ai-agent',
    variableId: 3,
    additionalData: { variableId: 3 },
  },
  {
    type: 'tool_call_start',
    timestamp: TS,
    bubbleName: 'ai-agent',
    additionalData: { toolCallId: 't1', toolName: 'web-scrape-tool', toolInput: { url: 'https://x.example' } },
  },
  {
    type: 'tool_call_complete',
    timestamp: TS,
    bubbleName: 'ai-agent',
    additionalData: {
      toolCallId: 't1',
      toolName: 'web-scrape-tool',
      toolInput: { url: 'https://x.example' },
      toolOutput: { success: false, error: 'scrape blocked', content: '' },
    },
  },
  {
    type: 'bubble_execution_complete',
    timestamp: TS,
    bubbleName: 'ai-agent',
    variableId: 3,
    additionalData: { variableId: 3, result: { success: true, data: { response: 'No content available' } } },
  },
  { type: 'execution_complete', timestamp: TS, message: 'done', additionalData: { success: true } },
];
const toolStudio = runErrorSignals(toolFixture);
const toolSidecar = sidecarCollect(toolFixture);
t.assert(
  'studio collector (unchanged) sees NO signal in the nested-tool fixture',
  toolStudio.length === 0,
  JSON.stringify(toolStudio.map(core))
);
t.assert(
  "sidecar emits exactly one {source:'tool'} signal and success=false",
  toolSidecar.signals.length === 1 &&
    toolSidecar.signals[0].source === 'tool' &&
    toolSidecar.signals[0].toolName === 'web-scrape-tool' &&
    toolSidecar.success === false,
  JSON.stringify(toolSidecar.signals)
);
t.assert(
  'sidecar toolCalls records the failed nested tool',
  toolSidecar.toolCalls.length === 1 &&
    toolSidecar.toolCalls[0].toolName === 'web-scrape-tool' &&
    toolSidecar.toolCalls[0].success === false,
  JSON.stringify(toolSidecar.toolCalls)
);

// emptyOutput heuristic: advisory data, never a signal.
t.section('B: emptyOutput advisory');
const emptyFixture = [
  {
    type: 'bubble_execution_complete',
    timestamp: TS,
    bubbleName: 'google-sheets',
    variableId: 5,
    additionalData: { variableId: 5, result: { success: true, data: { values: [] } } },
  },
  { type: 'execution_complete', timestamp: TS, message: 'done', additionalData: { success: true } },
];
const emptyReduced = sidecarCollect(emptyFixture);
t.assert(
  'successful-but-empty step: emptyOutput=true, zero signals, success=true',
  emptyReduced.signals.length === 0 &&
    emptyReduced.success === true &&
    emptyReduced.stepOutcomes[0]?.success === true &&
    emptyReduced.stepOutcomes[0]?.emptyOutput === true,
  JSON.stringify(emptyReduced.stepOutcomes)
);

await t.finish();
