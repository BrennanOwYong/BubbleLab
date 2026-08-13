#!/usr/bin/env node
/**
 * EXPECTED-RED demonstration test (F0.1 acceptance, "deliberately-snagged
 * flow"). Seeds a flow with a runtime bug — the open-meteo request asks for
 * the nonexistent variable 'relative_humidity' (real name:
 * relative_humidity_2m), producing HTTP 400 inside the bubble result — then
 * asserts the run is CLEAN. The assertion fails, proving the harness turns a
 * snagged flow into exit 1 with a structured red report.
 *
 * Never include this file in a green gate; it exists to prove the fail path.
 */
import { createHarness } from '../harness.mjs';

const SNAGGED_CODE = `import {
  BubbleFlow,
  HttpBubble,
  safeParseJson,
} from '@bubblelab/bubble-core';
import { z } from 'zod';
import type { CronEvent } from '@bubblelab/shared-schemas';

export interface SnagWeatherPayload extends CronEvent {
  /**
   * @header City latitude
   * @hint Latitude of the city to check
   */
  latitude?: number;
}

const currentWeatherSchema = z.object({
  current: z.object({
    temperature_2m: z.number(),
    relative_humidity_2m: z.number(),
  }),
});

export class EventTestSnagFixtureFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 * * * *';

  constructor() {
    super(
      'event-test-snag-fixture',
      'Hourly: fetch temperature and humidity for a city (deliberate wrong-field bug)'
    );
  }

  async handle(payload: SnagWeatherPayload): Promise<{ ok: boolean }> {
    const { latitude = 1.3521 } = payload;

    const weatherResult = await new HttpBubble({
      url: \`https://api.open-meteo.com/v1/forecast?latitude=\${latitude}&longitude=103.8198&current=temperature_2m,relative_humidity&timezone=UTC\`,
      method: 'GET',
    }).action();
    if (!weatherResult.success) return { ok: false };

    const parsed = safeParseJson(weatherResult.data.body, currentWeatherSchema);
    return { ok: parsed !== undefined };
  }
}
`;

const t = await createHarness({ name: '_snag_red', backlogId: 'F0.1' });

t.section('seed');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST snag fixture (expected red)',
  prompt: 'Harness fail-path fixture: weather check with a deliberate wrong-field bug',
  eventType: 'schedule/cron',
  code: SNAGGED_CODE,
});
t.assert('snagged fixture validated + saved (bug is runtime-only)', Boolean(flowId), `flowId=${flowId}`);

t.section('run');
const run = await t.executeStream(flowId, {});
// Deliberately wrong expectation: the snagged flow DOES produce error signals,
// so this assertion fails and the harness must exit 1 with a red report.
t.assert(
  'snagged flow runs with zero error signals (EXPECTED TO FAIL)',
  run.signals.length === 0,
  JSON.stringify(run.signals.map((s) => `${s.label}: ${s.message}`)).slice(0, 300)
);

await t.finish();
