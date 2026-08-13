#!/usr/bin/env node
/**
 * S5 — error-signal identity (BACKLOG S5). Two distinct failing HTTP steps
 * must produce two error signals whose messages differ, each carrying its own
 * call-site identity (variableId + failing URL, plus the real variable name
 * when bubbleParameters is supplied), so the fixer can never conflate two
 * identical-looking HTTP failures.
 *
 * Drives the real path: seeds a flow with two HttpBubble steps
 * (fetchAlpha -> 404, fetchBeta -> 410) against a LOCAL stub HTTP server
 * (no httpbin flake), runs POST /bubble-flow/:id/execute-stream, and asserts
 * on the logged StreamingLogEvents + the canonical collector port.
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/s5_error_identity.test.mjs
 */
import { createServer } from 'node:http';
import { createHarness, runErrorSignals } from '../harness.mjs';
import { composeFixRequestMessage } from '../lib/signals.mjs';

const t = await createHarness({ name: 's5_error_identity', backlogId: 'S5' });

// --- local stub: /alpha -> 404, /beta -> 410 --------------------------------
t.section('stub server');
const stub = createServer((req, res) => {
  const status = req.url?.startsWith('/beta') ? 410 : 404;
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(`stub ${status}`);
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = stub.address().port;
t.cleanup(() => new Promise((resolve) => stub.close(resolve)));
const urlAlpha = `http://127.0.0.1:${stubPort}/alpha`;
const urlBeta = `http://127.0.0.1:${stubPort}/beta`;
t.assert('stub server listening', Number.isInteger(stubPort), `port=${stubPort}`);

// --- fixture: two failing HTTP call sites, distinct URLs --------------------
const CODE = `import { BubbleFlow, HttpBubble } from '@bubblelab/bubble-core';
import type { CronEvent } from '@bubblelab/shared-schemas';

export class S5ErrorIdentityFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 * * * *';

  constructor() {
    super(
      's5-error-identity',
      'S5 fixture: two failing HTTP steps with distinct URLs'
    );
  }

  async handle(_payload: CronEvent): Promise<{
    alphaStatus: number;
    betaStatus: number;
  }> {
    const fetchAlpha = await new HttpBubble({
      url: '${urlAlpha}',
      method: 'GET',
    }).action();

    const fetchBeta = await new HttpBubble({
      url: '${urlBeta}',
      method: 'GET',
    }).action();

    return {
      alphaStatus: fetchAlpha.data?.status ?? 0,
      betaStatus: fetchBeta.data?.status ?? 0,
    };
  }
}
`;

t.section('seed');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST S5 error identity fixture',
  prompt: 'S5 fixture: two failing HTTP steps (404 + 410) on distinct URLs',
  eventType: 'schedule/cron',
  code: CODE,
});
t.assert('seedFlow validated + saved the fixture', Boolean(flowId), `flowId=${flowId}`);

// --- run: the wire must carry two distinct failing call sites ---------------
t.section('execute-stream events');
const run = await t.executeStream(flowId, {});

const failingCompletes = run.events.filter((e) => {
  if (e.type !== 'bubble_execution_complete') return false;
  const result = e.additionalData?.result;
  if (!result) return false;
  return result.success === false || (result.data?.status ?? 0) >= 400;
});
t.assert(
  'exactly 2 failing bubble_execution_complete events',
  failingCompletes.length === 2,
  `got ${failingCompletes.length}`
);

const varIds = failingCompletes.map(
  (e) => e.variableId ?? e.additionalData?.variableId
);
t.assert(
  'the two failures carry DISTINCT variableIds',
  varIds.length === 2 && varIds[0] !== undefined && varIds[0] !== varIds[1],
  `variableIds=${JSON.stringify(varIds)}`
);

for (const [i, expectedUrl] of [urlAlpha, urlBeta].entries()) {
  const start = run.events.find(
    (e) =>
      e.type === 'bubble_execution' &&
      (e.variableId ?? e.additionalData?.variableId) === varIds[i] &&
      e.additionalData?.parameters?.url === expectedUrl
  );
  t.assert(
    `failure ${i + 1} has a preceding bubble_execution start carrying url=${expectedUrl}`,
    Boolean(start),
    start ? 'found' : 'no matching start event'
  );
}

// --- signals: event-only identity (bubbleName#variableId + joined URL) ------
t.section('signals (event-only)');
t.assert('exactly 2 run-error signals', run.signals.length === 2, JSON.stringify(run.signals.map((s) => s.message)));
const [sigA, sigB] = run.signals;
t.assert(
  'the two signal messages DIFFER',
  Boolean(sigA && sigB) && sigA.message !== sigB.message,
  `A=${sigA?.message} B=${sigB?.message}`
);
t.assert('signal 1 message carries its URL', Boolean(sigA?.message.includes(urlAlpha)), sigA?.message);
t.assert('signal 2 message carries its URL', Boolean(sigB?.message.includes(urlBeta)), sigB?.message);
t.assert(
  'signals carry machine-readable identity (variableId + url)',
  sigA?.variableId === varIds[0] &&
    sigB?.variableId === varIds[1] &&
    sigA?.url === urlAlpha &&
    sigB?.url === urlBeta,
  JSON.stringify({ a: [sigA?.variableId, sigA?.url], b: [sigB?.variableId, sigB?.url] })
);

// --- signals with bubbleParameters: real variable names ---------------------
t.section('signals (with bubbleParameters)');
const flowRes = await t.api(`/bubble-flow/${flowId}`);
const bubbleParameters = flowRes.body?.bubbleParameters;
t.assert(
  'GET /bubble-flow/:id returns bubbleParameters',
  Boolean(bubbleParameters) && Object.keys(bubbleParameters).length > 0,
  `keys=${Object.keys(bubbleParameters ?? {}).join(',')}`
);
const namedSignals = runErrorSignals(run.events, bubbleParameters);
t.assert(
  'signal 1 names fetchAlpha',
  Boolean(namedSignals[0]?.message.includes('fetchAlpha')),
  namedSignals[0]?.message
);
t.assert(
  'signal 2 names fetchBeta',
  Boolean(namedSignals[1]?.message.includes('fetchBeta')),
  namedSignals[1]?.message
);

// --- composed fix request: two distinguishable numbered lines ---------------
t.section('composed fix request');
const fixMsg = composeFixRequestMessage(run.events, undefined, bubbleParameters);
t.assert("counts '2 error signals'", fixMsg.includes('2 error signals'));
t.assert('carries BOTH failing URLs', fixMsg.includes(urlAlpha) && fixMsg.includes(urlBeta));
const lines = fixMsg.split('\n');
const line1 = lines.find((l) => l.startsWith('1. '));
const line2 = lines.find((l) => l.startsWith('2. '));
t.assert(
  'two numbered signal lines exist and DIFFER',
  Boolean(line1) && Boolean(line2) && line1 !== line2,
  `1=${line1?.slice(0, 160)} 2=${line2?.slice(0, 160)}`
);

await t.finish();
