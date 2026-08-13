#!/usr/bin/env node
/**
 * Event-test runner (F0.1). Executes N test files as child processes, captures
 * each child's stdout report JSON, aggregates, writes .reports/latest.json
 * (the fixed path F0.2's pr-on-green hook reads), prints the aggregate to
 * stdout, exits with the MAX child exit code (so one stack-unavailable=3
 * outranks reds, and any red outranks green).
 *
 * Usage:
 *   node scripts/event-test/run.mjs [--api URL --sidecar URL --studio URL] \
 *        [--report path] tests/a.test.mjs [tests/b.test.mjs ...]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const testFiles = [];
let reportPath = join(HERE, '.reports', 'latest.json');
const childEnv = { ...process.env };

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--api') childEnv.EVENT_TEST_API_URL = next();
  else if (a === '--sidecar') childEnv.EVENT_TEST_SIDECAR_URL = next();
  else if (a === '--studio') childEnv.EVENT_TEST_STUDIO_URL = next();
  else if (a === '--report') reportPath = resolve(next());
  else if (a.startsWith('--')) {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  } else testFiles.push(a);
}
if (testFiles.length === 0) {
  console.error('usage: run.mjs [--api URL --sidecar URL --studio URL] [--report path] <test files...>');
  process.exit(2);
}
for (const f of testFiles) {
  const p = resolve(f);
  if (!existsSync(p)) {
    console.error(`unknown test file: ${f}`);
    process.exit(2);
  }
}

/** Parse the last JSON document on a child's stdout (the report). */
function lastJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return null;
  }
}

const reports = [];
let maxExit = 0;
for (const f of testFiles) {
  const p = resolve(f);
  console.error(`=== ${f}`);
  const child = spawnSync(process.execPath, [p], {
    encoding: 'utf8',
    env: childEnv,
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const code = child.status ?? 1;
  maxExit = Math.max(maxExit, code);
  const report = lastJson(child.stdout ?? '') ?? {
    test: f,
    pass: false,
    exitCode: code,
    error: 'child produced no report JSON on stdout',
  };
  reports.push(report);
}

const aggregate = {
  pass: maxExit === 0,
  exitCode: maxExit,
  ranAt: new Date().toISOString(),
  tests: testFiles,
  reports,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(aggregate, null, 2));
console.log(JSON.stringify(aggregate, null, 2));
process.exit(maxExit);
