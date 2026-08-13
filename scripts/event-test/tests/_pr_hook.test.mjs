#!/usr/bin/env node
/**
 * F0.2 acceptance: the pr-on-green hook exercised through the F0.1 harness
 * (FND.md F0.2 acceptance test), dry-run/guard only — NO real PR is ever
 * opened by this test (the F0.3 gate forbids branching; every invocation is
 * --dry-run or a refusal path, so no gh mutation can occur).
 *
 * Paths proven:
 *   red   — hook over _snag_red.test.mjs exits 1, action "dry-run", composed
 *           body contains `## Failing event tests` with the inverted assertion
 *   green — hook over _smoke.test.mjs exits 0, body contains all seven
 *           Pillar-4 headings, How-verified table row count == assertion count
 *   guard — dead API port -> hook exits 3, action "refused-stack-unavailable",
 *           no body composed (no draft may claim a code failure)
 *
 * Plus the Pillar-2 self-event: a hook run lands `pr_on_green.hook_run` in the
 * /telemetry ring buffer.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/event-test/tests
const ROOT = resolve(HERE, '..', '..', '..');
const HOOK = resolve(HERE, '..', 'pr-on-green.mjs');
const REPORTS = resolve(HERE, '..', '.reports');

const t = await createHarness({ name: '_pr_hook', backlogId: 'F0.2', timeoutMs: 6 * 60_000 });

/** Run the hook as a child; return { code, report } (last stdout JSON doc). */
function runHook(args, extraEnv = {}) {
  const child = spawnSync(
    process.execPath,
    [HOOK, '--id', 'F0.2', '--title', 'F0.2: auto-PR-on-green hook', '--skip-build', '--dry-run', ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  let hookReport = null;
  const out = (child.stdout ?? '').trim();
  const start = out.indexOf('{');
  if (start !== -1) {
    try {
      hookReport = JSON.parse(out.slice(start));
    } catch {
      hookReport = null;
    }
  }
  return { code: child.status ?? -1, report: hookReport };
}

const SEVEN_HEADINGS = [
  '## Problem',
  '## Root cause',
  '## What was built',
  '## How verified',
  '## Files touched',
  '## Surgical map',
  '## Backlog',
];

// ------------------------------------------------------------------ red path
t.section('red path (_snag_red, dry-run)');
const baseline = await t.telemetryBaseline();
const red = runHook([
  '--base', 'main',
  '--tests', 'scripts/event-test/tests/_snag_red.test.mjs',
  '--report', join(REPORTS, '_pr_hook-red.json'),
]);
t.assert('red dry-run exits 1', red.code === 1, `exit=${red.code}`);
t.assert('action is "dry-run"', red.report?.action === 'dry-run', red.report?.action);
t.assert(
  'intended action is draft-created',
  red.report?.intendedAction === 'draft-created',
  red.report?.intendedAction
);
t.assert('no PR url (no gh mutation)', (red.report?.prUrl ?? null) === null, red.report?.prUrl);
t.assert(
  'eventTests gate red with failed count',
  red.report?.gates?.eventTests?.pass === false && red.report?.gates?.eventTests?.failed > 0,
  JSON.stringify(red.report?.gates?.eventTests)
);
const redBody = red.report?.composedBodyPath ? readFileSync(red.report.composedBodyPath, 'utf8') : '';
t.assert('composed body has "## Failing event tests"', redBody.includes('\n## Failing event tests'));
t.assert(
  'failing section names the snagged assertion',
  redBody.includes('run is CLEAN') || /_snag_red/.test(redBody),
  'expected the inverted _snag_red assertion in the failing table'
);

// ---------------------------------------------------------------- green path
t.section('green path (_smoke, dry-run)');
// No --base here: exercises runtime base resolution via `gh repo view`.
const green = runHook([
  '--tests', 'scripts/event-test/tests/_smoke.test.mjs',
  '--report', join(REPORTS, '_pr_hook-green.json'),
]);
t.assert('green dry-run exits 0', green.code === 0, `exit=${green.code}`);
t.assert('action is "dry-run"', green.report?.action === 'dry-run', green.report?.action);
t.assert('intended action is created', green.report?.intendedAction === 'created', green.report?.intendedAction);
t.assert(
  'base resolved at runtime from gh',
  typeof green.report?.base === 'string' && green.report.base.length > 0,
  green.report?.base
);
const greenBody = green.report?.composedBodyPath
  ? readFileSync(green.report.composedBodyPath, 'utf8')
  : '';
const missing = SEVEN_HEADINGS.filter((h) => !greenBody.includes(h));
t.assert('body carries all seven Pillar-4 headings', missing.length === 0, missing.join(', ') || 'all present');
t.assert('green body has NO failing section', !greenBody.includes('\n## Failing event tests'));
// How-verified table rows == the smoke report's assertion count. Line-anchored
// LAST occurrence: authored prose may mention headings; injected ones are
// appended after the authored sections.
const hvStart = greenBody.lastIndexOf('\n## How verified');
const hvRest = hvStart === -1 ? '' : greenBody.slice(hvStart + 1).split('\n## Files touched')[0];
const hv = hvRest;
const tableRows = hv.split('\n').filter((l) => l.startsWith('| ')).length - 2; // minus header + divider
const smokeAssertions = green.report?.gates?.eventTests?.assertions ?? -1;
t.assert(
  'How-verified table row count equals assertion count',
  tableRows === smokeAssertions && smokeAssertions > 0,
  `rows=${tableRows} assertions=${smokeAssertions}`
);

// ---------------------------------------------------------------- guard path
t.section('guard path (dead API port)');
const guard = runHook(
  [
    '--base', 'main',
    '--tests', 'scripts/event-test/tests/_snag_red.test.mjs',
    '--report', join(REPORTS, '_pr_hook-guard.json'),
  ],
  { EVENT_TEST_API_URL: 'http://localhost:1' }
);
t.assert('guard exits 3', guard.code === 3, `exit=${guard.code}`);
t.assert(
  'action is "refused-stack-unavailable"',
  guard.report?.action === 'refused-stack-unavailable',
  guard.report?.action
);
t.assert(
  'refusal composed no body (no draft claims a code failure)',
  (guard.report?.composedBodyPath ?? null) === null,
  guard.report?.composedBodyPath
);
t.assert(
  'eventTests gate marked stackUnavailable',
  guard.report?.gates?.eventTests?.stackUnavailable === true,
  JSON.stringify(guard.report?.gates?.eventTests)
);
t.assert('no PR url (no gh mutation)', (guard.report?.prUrl ?? null) === null, guard.report?.prUrl);

// -------------------------------------------------- Pillar-2 self-event check
t.section('hook self-event');
t.assert(
  'hook report file written',
  existsSync(join(REPORTS, 'pr-hook-latest.json')),
  join(REPORTS, 'pr-hook-latest.json')
);
const hookEvents = (await t.telemetry({ sinceSeq: baseline })).filter(
  (e) => e.event?.event === 'pr_on_green.hook_run'
);
t.assert(
  'pr_on_green.hook_run telemetry events landed (red + green runs)',
  hookEvents.length >= 2,
  `found ${hookEvents.length}`
);
const actions = hookEvents.map((e) => e.event.action);
t.assert(
  'telemetry carries the dry-run action',
  actions.includes('dry-run'),
  actions.join(',')
);

await t.finish();
