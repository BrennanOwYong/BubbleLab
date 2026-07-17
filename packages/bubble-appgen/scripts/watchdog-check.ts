/**
 * Tool source-of-truth watchdog — one check cycle from the command line.
 *
 * Polls every registered source (registry/tool-sources.json), detects
 * drift, auto-regenerates on non-breaking changes, and holds breaking
 * changes for review. Prints every ToolWatchdogEvent as one JSON line on
 * stdout (JSONL) — the bubblelab-api scheduler spawns this same script and
 * relays the stream, so scheduled and manual runs are byte-identical.
 *
 * Usage:
 *   bun scripts/watchdog-check.ts [--tool <name>] [--events-out <file>]
 *     [--override <tool>/<sourceKey>=<url>] [--trigger schedule|manual|cli]
 *
 * `--override` points one source at a different URL (file:// supported) —
 * the seam used by tests and proof runs to simulate upstream drift without
 * waiting for a vendor to change their spec.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolWatchdogEvent } from '@bubblelab/shared-schemas';
import { runWatchdogCheck } from '../src/watchdog/check.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argValues(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) {
      values.push(process.argv[i + 1]);
    }
  }
  return values;
}

const eventsOut = argValue('--events-out');
if (eventsOut) mkdirSync(dirname(resolve(eventsOut)), { recursive: true });

const sourceOverrides: Record<string, string> = {};
for (const override of argValues('--override')) {
  const eq = override.indexOf('=');
  if (eq <= 0) {
    console.error(`bad --override (want <tool>/<sourceKey>=<url>): ${override}`);
    process.exit(1);
  }
  sourceOverrides[override.slice(0, eq)] = override.slice(eq + 1);
}

const trigger = argValue('--trigger');
if (trigger && !['schedule', 'manual', 'cli'].includes(trigger)) {
  console.error(`bad --trigger: ${trigger}`);
  process.exit(1);
}

const emit = (event: ToolWatchdogEvent): void => {
  const line = JSON.stringify(event);
  console.log(line);
  if (eventsOut) appendFileSync(resolve(eventsOut), `${line}\n`, 'utf8');
};

const summary = await runWatchdogCheck({
  packageRoot,
  repoRoot,
  emit,
  onlyTool: argValue('--tool'),
  sourceOverrides,
  trigger: (trigger as 'schedule' | 'manual' | 'cli' | undefined) ?? 'cli',
});

// Non-zero exit ONLY on check/regeneration failures — drift and breaking
// flags are the watchdog working as designed, not errors.
process.exit(summary.failed > 0 ? 1 : 0);
