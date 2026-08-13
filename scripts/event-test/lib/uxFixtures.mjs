/**
 * Fixture flow codes for the Phase-2 UX event tests. All are steps-style
 * (bubbles live in helper methods — in-handle instantiation is a lint error)
 * and run credential-less against open-meteo, so they execute clean on any
 * stack.
 */

/**
 * Guard clause + if/else with steps in both branches (U-3 / U-4 fixture).
 * The guard's implicit else yields an 'else if' chain edge (informative,
 * kept: "or if temperature more than 20") and the temperature-if's else
 * branch yields a bare 'else' edge (humanizes to 'otherwise', suppressed).
 */
export const STEPS_BRANCH_CODE = `import {
  BubbleFlow,
  HttpBubble,
  safeParseJson,
} from '@bubblelab/bubble-core';
import { z } from 'zod';
import type { CronEvent } from '@bubblelab/shared-schemas';

export interface StepsFixturePayload extends CronEvent {
  latitude?: number;
}

const weatherSchema = z.object({
  current: z.object({ temperature_2m: z.number() }),
});

export class EventTestStepsFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 * * * *';

  constructor() {
    super('event-test-steps', 'Hourly: check the weather and note warm or cool');
  }

  // Fetch the current temperature for the city
  private async fetchWeather(latitude: number): Promise<number | null> {
    const weather = await new HttpBubble({
      url: \`https://api.open-meteo.com/v1/forecast?latitude=\${latitude}&longitude=103.8198&current=temperature_2m&timezone=UTC\`,
      method: 'GET',
    }).action();
    if (!weather.success) return null;
    const parsed = safeParseJson(weather.data.body, weatherSchema);
    if (parsed === undefined) return null;
    return parsed.current.temperature_2m;
  }

  // Look up humidity for a warm day
  private async warmNote(): Promise<string> {
    const extra = await new HttpBubble({
      url: 'https://api.open-meteo.com/v1/forecast?latitude=1.35&longitude=103.82&current=relative_humidity_2m&timezone=UTC',
      method: 'GET',
    }).action();
    return extra.success ? 'warm and humid' : 'warm';
  }

  // Look up wind for a cool day
  private async coolNote(): Promise<string> {
    const extra = await new HttpBubble({
      url: 'https://api.open-meteo.com/v1/forecast?latitude=1.35&longitude=103.82&current=wind_speed_10m&timezone=UTC',
      method: 'GET',
    }).action();
    return extra.success ? 'cool and breezy' : 'cool';
  }

  async handle(payload: StepsFixturePayload): Promise<{ ok: boolean; note: string }> {
    const { latitude = 1.3521 } = payload;
    const temperature = await this.fetchWeather(latitude);
    if (temperature === null) {
      return { ok: false, note: 'weather unavailable' };
    }
    if (temperature > 20) {
      const note = await this.warmNote();
      return { ok: true, note };
    } else {
      const note = await this.coolNote();
      return { ok: true, note };
    }
  }
}
`;

/**
 * ai-agent + http tool fixture (U1 curated view / U3 overflow). Validates
 * statically; never executed by the tests that use it.
 */
export const AGENT_TOOL_CODE = `import { BubbleFlow, AIAgentBubble, HttpBubble } from '@bubblelab/bubble-core';
import type { CronEvent } from '@bubblelab/shared-schemas';

export class EventTestCuratedFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 * * * *';

  constructor() {
    super('event-test-curated', 'Hourly: summarize the weather in plain words');
  }

  // Fetch the raw weather reading
  private async fetchWeather(): Promise<string> {
    const weather = await new HttpBubble({
      url: 'https://api.open-meteo.com/v1/forecast?latitude=1.35&longitude=103.82&current=temperature_2m&timezone=UTC',
      method: 'GET',
    }).action();
    return weather.success ? weather.data.body : '';
  }

  // Turn the reading into a plain-language note
  private async summarize(reading: string): Promise<string> {
    const agent = await new AIAgentBubble({
      message: \`Summarize this weather reading in one plain sentence: \${reading}\`,
      systemPrompt: 'You write one-sentence plain-language weather notes for a non-technical reader.',
      model: { model: 'google/gemini-2.5-flash' },
      tools: [{ name: 'web-search-tool' }],
    }).action();
    return agent.success ? (agent.data?.response ?? '') : '';
  }

  async handle(_payload: CronEvent): Promise<{ ok: boolean; note: string }> {
    const reading = await this.fetchWeather();
    const note = await this.summarize(reading);
    return { ok: note !== '', note };
  }
}
`;

/**
 * ai-agent + http tool fixture with a genuinely long tool description (U3
 * overflow, F0.5-2 fix). Same shape as AGENT_TOOL_CODE, but the comment
 * directly above the HttpBubble instantiation (which BubbleParser attaches
 * to that bubble as its curated \`description\` field — the same non-editable
 * field BubbleNode renders via a clamped <p>) is a multi-sentence paragraph
 * well beyond the 6-line clamp boundary, so expanding the tool node actually
 * exercises the new useOverflowTripwire wiring instead of a one-liner that
 * could never approach the containment boundary. Validates statically;
 * never executed by the tests that use it.
 */
export const AGENT_TOOL_LONG_DESCRIPTION_CODE = `import { BubbleFlow, AIAgentBubble, HttpBubble } from '@bubblelab/bubble-core';
import type { CronEvent } from '@bubblelab/shared-schemas';

export class EventTestCuratedLongDescFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 * * * *';

  constructor() {
    super('event-test-curated-long-desc', 'Hourly: summarize the weather in plain words');
  }

  // Fetch the raw weather reading
  private async fetchWeather(): Promise<string> {
    // This bubble performs the outbound network call responsible for retrieving live meteorological
    // telemetry from the upstream open-meteo public forecast API for the fixed Singapore coordinates
    // configured below; it intentionally issues a plain unauthenticated GET request without any query
    // parameters beyond latitude, longitude, the requested current-weather field, and timezone, since
    // this fixture exists purely to stress-test how the canvas curated node view renders and contains
    // an unusually long, multi-sentence description string that a real integration author might write
    // when documenting a non-obvious API quirk, a rate-limit caveat, or a data-shape gotcha for a
    // future maintainer reading this flow's source code months from now.
    const weather = await new HttpBubble({
      url: 'https://api.open-meteo.com/v1/forecast?latitude=1.35&longitude=103.82&current=temperature_2m&timezone=UTC',
      method: 'GET',
    }).action();
    return weather.success ? weather.data.body : '';
  }

  // Turn the reading into a plain-language note
  private async summarize(reading: string): Promise<string> {
    const agent = await new AIAgentBubble({
      message: \`Summarize this weather reading in one plain sentence: \${reading}\`,
      systemPrompt: 'You write one-sentence plain-language weather notes for a non-technical reader.',
      model: { model: 'google/gemini-2.5-flash' },
      tools: [{ name: 'web-search-tool' }],
    }).action();
    return agent.success ? (agent.data?.response ?? '') : '';
  }

  async handle(_payload: CronEvent): Promise<{ ok: boolean; note: string }> {
    const reading = await this.fetchWeather();
    const note = await this.summarize(reading);
    return { ok: note !== '', note };
  }
}
`;

/**
 * Result fixture (U2): handle() returns top-level report_url + summary so a
 * primaryOutput of kind 'both' derives from finalResult on every clean run.
 */
export const RESULT_CODE = `import {
  BubbleFlow,
  HttpBubble,
  safeParseJson,
} from '@bubblelab/bubble-core';
import { z } from 'zod';
import type { CronEvent } from '@bubblelab/shared-schemas';

const weatherSchema = z.object({
  current: z.object({ temperature_2m: z.number() }),
});

export class EventTestResultFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 * * * *';

  constructor() {
    super('event-test-result', 'Hourly: publish a plain-language weather note');
  }

  // Fetch the current temperature
  private async fetchTemperature(): Promise<number | null> {
    const weather = await new HttpBubble({
      url: 'https://api.open-meteo.com/v1/forecast?latitude=1.35&longitude=103.82&current=temperature_2m&timezone=UTC',
      method: 'GET',
    }).action();
    if (!weather.success) return null;
    const parsed = safeParseJson(weather.data.body, weatherSchema);
    return parsed === undefined ? null : parsed.current.temperature_2m;
  }

  async handle(_payload: CronEvent): Promise<{ ok: boolean; report_url: string; summary: string }> {
    const temperature = await this.fetchTemperature();
    return {
      ok: temperature !== null,
      report_url: 'https://open-meteo.com/en/docs',
      summary:
        temperature === null
          ? 'The weather reading was unavailable this hour'
          : \`The temperature is \${temperature} degrees right now\`,
    };
  }
}
`;
