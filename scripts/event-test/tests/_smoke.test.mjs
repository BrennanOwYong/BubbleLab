#!/usr/bin/env node
/**
 * Harness self-acceptance (F0.1 smoke). Exercises every event-source collector
 * against the live branch stack, plus negative-path harness checks by invoking
 * itself as a child process:
 *   SMOKE_NEGATIVE=red      one deliberately failing assertion -> exit 1 + valid report
 *   SMOKE_NEGATIVE=badstack createHarness against a dead port  -> exit 3, no assertions
 *
 * Verified-by (BACKLOG F0.1):
 *   node scripts/event-test/run.mjs scripts/event-test/tests/_smoke.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../harness.mjs';

const SELF = fileURLToPath(import.meta.url);

// --- negative-path child modes ----------------------------------------------
if (process.env.SMOKE_NEGATIVE === 'red') {
  const t = await createHarness({ name: '_smoke.red-child' });
  t.assert('deliberately failing assertion', false, 'this red is intentional');
  await t.finish();
}
if (process.env.SMOKE_NEGATIVE === 'badstack') {
  await createHarness({ name: '_smoke.badstack-child', api: 'http://localhost:1' });
  // createHarness must have exited 3 before this line.
  console.error('UNREACHABLE: createHarness returned despite dead stack');
  process.exit(1);
}

// --- known-good fixture: cron flow, open-meteo HttpBubble, no credentials ----
const GOOD_CODE = `import {
  BubbleFlow,
  HttpBubble,
  safeParseJson,
} from '@bubblelab/bubble-core';
import { z } from 'zod';
import type { CronEvent } from '@bubblelab/shared-schemas';

export interface SmokeWeatherPayload extends CronEvent {
  /**
   * @header City latitude
   * @hint Latitude of the city to check
   */
  latitude?: number;
  /**
   * @header City longitude
   * @hint Longitude of the city to check
   */
  longitude?: number;
}

const currentWeatherSchema = z.object({
  current: z.object({
    temperature_2m: z.number(),
  }),
});

export class EventTestSmokeFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 * * * *';

  constructor() {
    super(
      'event-test-smoke',
      'Hourly: fetch the current temperature for a city'
    );
  }

  async handle(payload: SmokeWeatherPayload): Promise<{
    ok: boolean;
    temperature: number | null;
  }> {
    const { latitude = 1.3521, longitude = 103.8198 } = payload;

    const weatherResult = await new HttpBubble({
      url: \`https://api.open-meteo.com/v1/forecast?latitude=\${latitude}&longitude=\${longitude}&current=temperature_2m&timezone=UTC\`,
      method: 'GET',
    }).action();
    if (!weatherResult.success) return { ok: false, temperature: null };

    const parsed = safeParseJson(weatherResult.data.body, currentWeatherSchema);
    if (parsed === undefined) return { ok: false, temperature: null };

    return { ok: true, temperature: parsed.current.temperature_2m };
  }
}
`;

const t = await createHarness({ name: '_smoke', backlogId: 'F0.1' });

// 1. seed
t.section('seed');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST smoke fixture',
  prompt: 'Harness smoke fixture: hourly temperature check (no credentials)',
  eventType: 'schedule/cron',
  code: GOOD_CODE,
});
t.assert('seedFlow validated + saved the fixture', Boolean(flowId), `flowId=${flowId}`);

// 2. execute-stream
t.section('execute-stream');
const run = await t.executeStream(flowId, {});
const complete = run.events.find((e) => e.type === 'execution_complete');
t.assert(
  'execution_complete present with additionalData.success === true',
  complete?.additionalData?.success === true,
  complete?.message
);
t.assert('zero run-error signals', run.signals.length === 0, JSON.stringify(run.signals).slice(0, 300));

// 3. persisted run history
t.section('executions');
const items = await t.executions(flowId, 1);
t.assert("items[0].status === 'success'", items[0]?.status === 'success', items[0]?.status);
// Persisted `result` is the runtime wrapper { data, errors, warnings,
// totalCost, serviceUsage, totalDuration }; its `data` field is the flow's
// handle() return, which is what execution_complete.additionalData.result
// streams. Compare the unwrapped payloads.
const persistedRaw =
  typeof items[0]?.result === 'string' ? JSON.parse(items[0].result) : items[0]?.result;
const persisted =
  persistedRaw && typeof persistedRaw === 'object' && 'data' in persistedRaw
    ? persistedRaw.data
    : persistedRaw;
const ad = complete?.additionalData ?? {};
const candidates = [ad.result, ad.finalResult, ad.data].filter((c) => c !== undefined);
const persistedStr = JSON.stringify(persisted);
const matched = candidates.some((c) => JSON.stringify(c) === persistedStr);
t.assert(
  'persisted result matches the streamed final result',
  matched,
  matched ? persistedStr?.slice(0, 200) : `persisted=${persistedStr?.slice(0, 150)} streamed=${JSON.stringify(candidates).slice(0, 200)}`
);

// 4. telemetry round-trip
t.section('telemetry');
const baseline = await t.telemetryBaseline();
const synthetic = {
  event: 'event_test.smoke_probe',
  ts: new Date().toISOString(),
  flowId,
  nonce: `smoke-${Date.now()}`,
};
const posted = await t.api('/telemetry', { method: 'POST', body: JSON.stringify(synthetic) });
t.assert('POST /telemetry accepted the synthetic event', posted.body?.accepted === 1, JSON.stringify(posted.body).slice(0, 150));
const seen = await t.telemetry({ type: 'event_test.smoke_probe', sinceSeq: baseline });
t.assert(
  'telemetry({sinceSeq}) returns exactly the synthetic event',
  seen.length === 1 && seen[0].event?.nonce === synthetic.nonce,
  `returned=${seen.length}`
);

// 5. build thread (sidecar agent turn, 1-5 min)
t.section('build-thread');
const QUESTION = 'In one sentence, what does this flow do? Do not change anything and do not run it.';
const turn = await t.buildMessage(flowId, QUESTION);
t.assert('agent replied with assistant text', turn.assistantText.length > 0, turn.assistantText.slice(0, 150));
const thread = await t.buildThread(flowId);
t.assert('thread sessionId non-null', Boolean(thread?.sessionId), thread?.sessionId);
const hasUserTurn = (thread?.transcript ?? []).some(
  (it) =>
    it.role === 'user' &&
    (it.blocks ?? []).some((b) => b.type === 'text' && b.text?.includes(QUESTION))
);
t.assert('transcript contains the user turn', hasUserTurn);

// 6. negative-path harness checks (self-invocation)
t.section('negative-paths');
const red = spawnSync(process.execPath, [SELF], {
  encoding: 'utf8',
  env: { ...process.env, SMOKE_NEGATIVE: 'red' },
  stdio: ['ignore', 'pipe', 'ignore'],
});
let redReport = null;
try {
  redReport = JSON.parse(red.stdout.slice(red.stdout.indexOf('{')));
} catch {
  /* handled by the asserts below */
}
t.assert('red child exits 1', red.status === 1, `exit=${red.status}`);
t.assert(
  'red child emits valid report JSON with pass:false',
  redReport?.pass === false && Array.isArray(redReport?.assertions),
  JSON.stringify(redReport)?.slice(0, 150)
);

const bad = spawnSync(process.execPath, [SELF], {
  encoding: 'utf8',
  env: { ...process.env, SMOKE_NEGATIVE: 'badstack' },
  stdio: ['ignore', 'pipe', 'ignore'],
});
let badReport = null;
try {
  badReport = JSON.parse(bad.stdout.slice(bad.stdout.indexOf('{')));
} catch {
  /* handled by the asserts below */
}
t.assert('dead-stack child exits 3', bad.status === 3, `exit=${bad.status}`);
t.assert(
  'dead-stack child claims no assertions ran',
  badReport?.stackUnavailable === true && badReport?.assertions?.length === 0,
  JSON.stringify(badReport)?.slice(0, 150)
);

await t.finish();
