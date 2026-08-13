#!/usr/bin/env node
/**
 * U5 — Setup-tab completeness (BACKLOG U5, the UI half of S1(c); brief =
 * BACKLOG U5 row + PLAN-DOCS/discovery/S1.md §4(c)).
 *
 * The Setup panel must list EVERY credential the flow needs — nested agent
 * tools included — filtered only by S1's effective platform classification.
 * Asserted from the `setup.manifest_rendered` telemetry event, whose payload
 * IS the panel's render-feeding data (lib/setupManifest.ts derivation +
 * connect state), never pixels.
 *
 * Fixture: an ai-agent whose web-search-tool nests a Firecrawl credential
 * need, plus a direct GoogleDriveBubble step as the control. Completeness =
 * the manifest's type set EQUALS the API's own detection (requiredCredentials)
 * minus wildcard minus the stack's platform-provided set — deterministic for
 * either env state (firecrawl backed -> hidden negative control; unbacked ->
 * card matches the direct-bubble card's shape).
 *
 * F0.5 lens (PRODUCT-PRINCIPLES per-task table, U5 row): every rendered label
 * is a human name; no *_CRED / SCREAMING_SNAKE string in labels or steps.
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/u5_setup_completeness.test.mjs
 */
import { createHarness } from '../harness.mjs';
import {
  studioBrowser,
  openFlowPage,
  sleep,
  isLeakedLabel,
} from '../lib/studio.mjs';

const t = await createHarness({ name: 'u5_setup_completeness', backlogId: 'U5' });

// Steps-style fixture (bubbles in helper methods): nested-tool cred (agent ->
// web-search-tool -> FIRECRAWL_API_KEY) + direct service bubble cred
// (GOOGLE_DRIVE_CRED). Never executed by this test — rendered only.
const NESTED_PLUS_DIRECT_CODE = `import { BubbleFlow, AIAgentBubble, GoogleDriveBubble } from '@bubblelab/bubble-core';
import type { CronEvent } from '@bubblelab/shared-schemas';

export class EventTestSetupCompletenessFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 7 * * *';

  constructor() {
    super('event-test-u5-setup', 'Daily: research a topic and file the note in Drive');
  }

  // Research the topic on the web
  private async research(): Promise<string> {
    const agent = await new AIAgentBubble({
      message: 'Search the web for the BubbleLab product and summarize it in one line.',
      systemPrompt: 'You write one-line plain-language summaries.',
      tools: [{ name: 'web-search-tool' }],
    }).action();
    return agent.success ? (agent.data?.response ?? '') : '';
  }

  // List the Drive folder the note would be filed into
  private async listDrive(): Promise<boolean> {
    const drive = await new GoogleDriveBubble({
      operation: 'list_files',
      max_results: 5,
    }).action();
    return drive.success;
  }

  async handle(_payload: CronEvent): Promise<{ ok: boolean; note: string }> {
    const note = await this.research();
    const driveOk = await this.listDrive();
    return { ok: note !== '' && driveOk, note };
  }
}
`;

// --- 1. the stack's own classification answer (branch determinism) -----------
t.section('platform classification');
const platform = await t.api('/credentials/platform-types');
t.assert('GET /credentials/platform-types responds 200', platform.status === 200, `HTTP ${platform.status}`);
const platformTypes = new Set(platform.body?.platformCredentialTypes ?? []);
const firecrawlPlatformProvided = platformTypes.has('FIRECRAWL_API_KEY');

// --- 2. fixture + the API's own detection (the completeness reference) -------
t.section('seed nested-tool + direct-bubble fixture');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST U5 setup completeness',
  prompt: 'U5 fixture: agent with nested web search plus direct Drive step',
  code: NESTED_PLUS_DIRECT_CODE,
});
t.assert('fixture flow seeded', Boolean(flowId), `flowId=${flowId}`);

const details = await t.api(`/bubble-flow/${flowId}`);
const required = details.body?.requiredCredentials ?? {};
const detectedTypes = new Set(
  Object.values(required)
    .flat()
    .filter((type) => type !== 'CREDENTIAL_WILDCARD')
);
t.assert(
  'detection reports the nested-tool credential (FIRECRAWL_API_KEY)',
  detectedTypes.has('FIRECRAWL_API_KEY'),
  JSON.stringify(required).slice(0, 300)
);
t.assert(
  'detection reports the direct-bubble credential (GOOGLE_DRIVE_CRED)',
  detectedTypes.has('GOOGLE_DRIVE_CRED'),
  JSON.stringify(required).slice(0, 300)
);
const expectedTypes = [...detectedTypes]
  .filter((type) => !platformTypes.has(type))
  .sort();

// --- 3. render the real Setup tab, read the manifest event -------------------
t.section('setup.manifest_rendered event');
const baseline = await t.telemetryBaseline();
const b = studioBrowser(t, 'u5-setup-completeness');
await openFlowPage(b, t, flowId);
// Real tab switch: the same uiStore action the Setup tab's click handler calls.
b.evalJs(
  `(async () => { const m = await import('/src/stores/uiStore.ts'); m.useUIStore.getState().setConsolidatedPanelTab('setup'); return true; })()`
);
await sleep(4000); // panel render + telemetry server-sink flush

const rows = await t.telemetry({
  type: 'setup.manifest_rendered',
  flowId,
  sinceSeq: baseline,
});
const manifestEvents = rows.map((row) => row.event);
t.assert(
  'the Setup panel emitted its manifest event',
  manifestEvents.length >= 1,
  `events=${manifestEvents.length}`
);
// The LAST event per flow is the current panel truth (re-emits on state change).
const manifest = manifestEvents[manifestEvents.length - 1];
const entries = manifest?.entries ?? [];
const manifestTypes = entries.map((entry) => entry.credentialType).sort();

// --- 4. completeness: manifest == detection minus platform set ---------------
t.section('completeness (nested tools included, nothing extra)');
t.assert(
  'manifest lists EXACTLY the detected non-platform credential types',
  JSON.stringify(manifestTypes) === JSON.stringify(expectedTypes),
  JSON.stringify({ manifestTypes, expectedTypes, platform: [...platformTypes] })
);
const driveEntry = entries.find((entry) => entry.credentialType === 'GOOGLE_DRIVE_CRED');
t.assert(
  'direct-bubble control: Google Drive card present with its step',
  Boolean(driveEntry) && driveEntry.steps.length >= 1,
  JSON.stringify(driveEntry)
);
const firecrawlEntry = entries.find((entry) => entry.credentialType === 'FIRECRAWL_API_KEY');
if (firecrawlPlatformProvided) {
  t.assert(
    'NEGATIVE CONTROL (env-backed): the platform-provided Firecrawl type derives no card',
    firecrawlEntry === undefined,
    JSON.stringify({ firecrawlEntry, platform: [...platformTypes] })
  );
} else {
  t.assert(
    'nested-tool card present, matching the direct-bubble card shape',
    Boolean(firecrawlEntry) &&
      Boolean(driveEntry) &&
      firecrawlEntry.steps.length >= 1 &&
      JSON.stringify(Object.keys(firecrawlEntry).sort()) ===
        JSON.stringify(Object.keys(driveEntry).sort()),
    JSON.stringify({ firecrawlEntry, driveEntry })
  );
}
t.assert(
  'missingCount consistent with entries',
  typeof manifest?.missingCount === 'number' &&
    manifest.missingCount <= entries.length,
  JSON.stringify({ missingCount: manifest?.missingCount, total: entries.length })
);

// --- 5. F0.5 no-technical-leakage lens ---------------------------------------
t.section('F0.5 no-technical-leakage lens');
const renderedStrings = entries.flatMap((entry) => [entry.label, ...entry.steps]);
const leaked = renderedStrings.filter((value) => isLeakedLabel(value));
t.assert(
  'every card label and step name is a human name (no *_CRED / SCREAMING_SNAKE)',
  entries.length > 0 && leaked.length === 0,
  JSON.stringify({ leaked, renderedStrings }).slice(0, 300)
);
t.assert(
  'no label equals its machine credential type',
  entries.every((entry) => entry.label !== entry.credentialType),
  JSON.stringify(entries.map((entry) => [entry.credentialType, entry.label]))
);
t.assert(
  'step names are bubble names, never bare variable ids',
  entries.every((entry) => entry.steps.every((step) => !/^\d+$/.test(step))),
  JSON.stringify(entries.map((entry) => entry.steps))
);

await t.finish();
