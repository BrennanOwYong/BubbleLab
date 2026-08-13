#!/usr/bin/env node
/**
 * Auto-PR-on-green hook (DISPATCH-CONTRACT Pillar 4, backlog F0.2).
 *
 * One command a task branch runs when it believes it is done. Enforces the
 * Pillar-4 gate mechanically:
 *   - build (pnpm typecheck + pnpm lint:check) AND event tests green
 *     -> open/refresh a real PR with the surgical body, promote a draft;
 *   - any gate red
 *     -> open/refresh a DRAFT with the failing report attached under
 *        `## Failing event tests`;
 *   - event tests exit 3 (stack unavailable, infra problem, not a code failure)
 *     -> refuse: nothing opened, nothing edited, no body composed.
 *
 * Body = authored judgment sections (PLAN-DOCS/pr-bodies/<id>.md: ## Problem,
 * ## Root cause, ## What was built, ## Surgical map, ## Backlog) + two
 * machine-injected sections (## How verified from the event-test report JSON,
 * ## Files touched from git diff vs the merge-base). The hook refuses (exit 2)
 * if any authored heading is missing, so a PR can never open with a hollow
 * body.
 *
 * Usage:
 *   node scripts/event-test/pr-on-green.mjs \
 *     --id S6 --title "S6: fixer binary-triage robustness" \
 *     --tests "scripts/event-test/tests/S6.test.mjs [...]" \
 *     [--base <branch>]   # default: gh repo view --json defaultBranchRef
 *                         # (server truth; this clone's origin/HEAD symref is
 *                         #  stale and must never be trusted)
 *     [--repo owner/name] # default BrennanOwYong/BubbleLab
 *     [--report path]     # event-test aggregate path (default .reports/latest.json)
 *     [--skip-build]      # event tests only (build already proven this session)
 *     [--full-build]      # also run pnpm build (opt-in; minutes-long)
 *     [--dry-run]         # run all gates, compose the body, print intended
 *                         # action; no gh mutations, no push. Preconditions are
 *                         # recorded but not enforced (a dirty working tree
 *                         # still dry-runs).
 *
 * Exit codes (load-bearing, mirrors the harness):
 *   0 real PR open/ready (or green dry-run)
 *   1 gates red -> draft state (or red dry-run)
 *   2 usage error / preconditions refused / authored body sections missing
 *   3 propagated stack-unavailable (refused; nothing opened, nothing edited)
 *
 * Pillar-2 self-event: every hook run writes .reports/pr-hook-latest.json,
 * prints the same report JSON as the ONLY stdout document, and best-effort
 * POSTs `pr_on_green.hook_run` to the stack's /telemetry ring buffer — so the
 * hook's own behavior is assertable from logged events (see
 * tests/_pr_hook.test.mjs).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStack } from './lib/stack.mjs';
import { jsonFetch } from './lib/api.mjs';
import { REPORTS_DIR } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const RUNNER = join(HERE, 'run.mjs');
const HOOK_REPORT_PATH = join(REPORTS_DIR, 'pr-hook-latest.json');

const AUTHORED_HEADINGS = [
  '## Problem',
  '## Root cause',
  '## What was built',
  '## Surgical map',
  '## Backlog',
];

// ---------------------------------------------------------------- arg parsing

const opts = {
  id: null,
  title: null,
  tests: [],
  base: null,
  repo: 'BrennanOwYong/BubbleLab',
  report: join(REPORTS_DIR, 'latest.json'),
  skipBuild: false,
  fullBuild: false,
  dryRun: false,
};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--id') opts.id = next();
    else if (a === '--title') opts.title = next();
    else if (a === '--tests') opts.tests.push(...next().split(/\s+/).filter(Boolean));
    else if (a === '--base') opts.base = next();
    else if (a === '--repo') opts.repo = next();
    else if (a === '--report') opts.report = resolve(next());
    else if (a === '--skip-build') opts.skipBuild = true;
    else if (a === '--full-build') opts.fullBuild = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else usageExit(`unknown flag: ${a}`);
  }
  if (!opts.id) usageExit('--id <backlog row> is required');
  if (!opts.title) usageExit('--title is required');
  if (opts.tests.length === 0) usageExit('--tests <event test file(s)> is required');
}

function usageExit(msg) {
  console.error(`pr-on-green: ${msg}`);
  console.error(
    'usage: pr-on-green.mjs --id <backlogId> --title <title> --tests "<files>" ' +
      '[--base <branch>] [--repo owner/name] [--report path] [--skip-build] [--full-build] [--dry-run]'
  );
  process.exit(2);
}

// ------------------------------------------------------------------- helpers

function git(...args) {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function gh(...args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', cwd: ROOT });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function sh(cmd, args, label) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - t0;
  const pass = (r.status ?? 1) === 0;
  console.error(`gate ${label}: ${pass ? 'PASS' : 'FAIL'} (${durationMs}ms)`);
  return {
    pass,
    exitCode: r.status ?? 1,
    durationMs,
    // keep only the tail — enough to diagnose, never the full turbo firehose
    outputTail: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n'),
  };
}

const report = {
  hook: 'pr-on-green',
  id: opts.id,
  title: opts.title,
  branch: null,
  base: null,
  dryRun: opts.dryRun,
  gates: {},
  action: null,
  intendedAction: null,
  prUrl: null,
  composedBodyPath: null,
  reportPath: opts.report,
  exitCode: null,
};

/** The single exit path: stdout JSON + report file + best-effort telemetry. */
async function emit(action, exitCode, extra = {}) {
  Object.assign(report, extra, { action, exitCode });
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(HOOK_REPORT_PATH, JSON.stringify(report, null, 2));
  // Pillar-2 self-event: best-effort — the hook must work with no stack up
  // (e.g. refused-stack-unavailable is exactly the no-stack case).
  try {
    const stack = await resolveStack({});
    await jsonFetch(stack.api, '/telemetry', {
      method: 'POST',
      body: JSON.stringify({
        event: 'pr_on_green.hook_run',
        ts: new Date().toISOString(),
        id: report.id,
        branch: report.branch,
        base: report.base,
        dryRun: report.dryRun,
        action: report.action,
        exitCode: report.exitCode,
        prUrl: report.prUrl,
      }),
    });
  } catch {
    /* telemetry sink is best-effort */
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
}

// ------------------------------------------------- gate 0: authored body file

const authoredPath = join(ROOT, 'PLAN-DOCS', 'pr-bodies', `${opts.id}.md`);
if (!existsSync(authoredPath)) {
  console.error(`missing authored body file: ${authoredPath}`);
  await emit('refused-preconditions', 2, {
    gates: { authoredBody: { pass: false, missingFile: authoredPath } },
  });
}
const authored = readFileSync(authoredPath, 'utf8');
const missingHeadings = AUTHORED_HEADINGS.filter((h) => !authored.includes(h));
if (missingHeadings.length > 0) {
  console.error(`authored body ${authoredPath} missing heading(s): ${missingHeadings.join(', ')}`);
  await emit('refused-preconditions', 2, {
    gates: { authoredBody: { pass: false, missingHeadings } },
  });
}
report.gates.authoredBody = { pass: true, path: authoredPath };

// ------------------------------------------------------- base branch (via gh)

if (!opts.base) {
  // Server truth only. This clone's `git symbolic-ref refs/remotes/origin/HEAD`
  // points at a stale branch; never trust the local symref.
  const r = gh('repo', 'view', opts.repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
  if (r.code !== 0 || !r.out) {
    console.error(`cannot resolve base branch from gh: ${r.err || r.out}`);
    await emit('refused-preconditions', 2, {
      gates: { ...report.gates, baseResolution: { pass: false, detail: r.err || 'empty output' } },
    });
  }
  opts.base = r.out;
}
report.base = opts.base;

// ------------------------------------------------------ gate 1: preconditions

const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out;
report.branch = branch;
const onBaseBranch = branch === opts.base;
const porcelain = git('status', '--porcelain').out;
const clean = porcelain.length === 0;
const pushedRef = git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`);
let pushed = pushedRef.code === 0;

const preconditions = {
  pass: !onBaseBranch && clean,
  enforced: !opts.dryRun,
  branchIsBase: onBaseBranch,
  workingTreeClean: clean,
  ...(clean ? {} : { dirty: porcelain.split('\n').slice(0, 20) }),
  branchPushed: pushed,
};
report.gates.preconditions = preconditions;

if (!opts.dryRun) {
  if (!preconditions.pass) {
    console.error(
      onBaseBranch
        ? `refusing: current branch '${branch}' IS the base branch`
        : 'refusing: working tree not clean — commit everything first'
    );
    await emit('refused-preconditions', 2);
  }
  if (!pushed) {
    const p = git('push', '-u', 'origin', 'HEAD');
    if (p.code !== 0) {
      console.error(`git push failed: ${p.err}`);
      preconditions.pushFailed = true;
      await emit('refused-preconditions', 2);
    }
    pushed = true;
    preconditions.branchPushed = true;
  }
}

// ---------------------------------------------------------- gate 2: build

if (opts.skipBuild) {
  report.gates.typecheck = { pass: true, skipped: true };
  report.gates.lint = { pass: true, skipped: true };
} else {
  report.gates.typecheck = sh('pnpm', ['typecheck'], 'typecheck');
  report.gates.lint = sh('pnpm', ['lint:check'], 'lint');
  if (opts.fullBuild) report.gates.build = sh('pnpm', ['build'], 'build');
}
const buildGreen =
  report.gates.typecheck.pass && report.gates.lint.pass && (report.gates.build?.pass ?? true);

// ----------------------------------------------------- gate 3: event tests

const runnerArgs = [RUNNER, '--report', opts.report, ...opts.tests];
const runnerCmd = `node ${['scripts/event-test/run.mjs', '--report', opts.report, ...opts.tests].join(' ')}`;
console.error(`gate eventTests: ${runnerCmd}`);
const runner = spawnSync(process.execPath, runnerArgs, {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024,
});
const testsExit = runner.status ?? 1;

if (testsExit === 3) {
  // Infra problem, NOT a code failure. Refuse: no draft may claim a red.
  console.error('event tests report STACK UNAVAILABLE — refusing to open or edit anything');
  report.gates.eventTests = { pass: false, exitCode: 3, stackUnavailable: true };
  await emit('refused-stack-unavailable', 3);
}
if (testsExit === 2) {
  console.error('event-test runner usage/config error');
  report.gates.eventTests = { pass: false, exitCode: 2, usageError: true };
  await emit('refused-preconditions', 2);
}

let aggregate = null;
try {
  aggregate = JSON.parse(readFileSync(opts.report, 'utf8'));
} catch {
  console.error(`event tests ran but no aggregate report at ${opts.report}`);
  report.gates.eventTests = { pass: false, exitCode: testsExit, missingReport: opts.report };
  await emit('refused-preconditions', 2);
}
const allAssertions = aggregate.reports.flatMap((r) =>
  (r.assertions ?? []).map((a) => ({ test: r.test, ...a }))
);
report.gates.eventTests = {
  pass: testsExit === 0,
  exitCode: testsExit,
  reportPath: opts.report,
  assertions: allAssertions.length,
  failed: allAssertions.filter((a) => !a.pass).length,
};

const green = buildGreen && testsExit === 0;

// ---------------------------------------------------------- body composition

function mdCell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function howVerifiedSection() {
  const lines = [
    '## How verified',
    '',
    '```',
    runnerCmd,
    '```',
    '',
    `Aggregate: **${aggregate.pass ? 'PASS' : 'FAIL'}** (exit ${aggregate.exitCode}), ` +
      `${allAssertions.length} assertions, ${allAssertions.filter((a) => !a.pass).length} failed, ran ${aggregate.ranAt}.`,
    '',
    '| section | name | pass | detail |',
    '| --- | --- | --- | --- |',
    ...allAssertions.map(
      (a) => `| ${mdCell(a.section)} | ${mdCell(a.name)} | ${a.pass ? 'PASS' : 'FAIL'} | ${mdCell(a.detail)} |`
    ),
  ];
  const dumps = aggregate.reports.map((r) => r.eventDumpPath).filter(Boolean);
  if (dumps.length > 0) {
    lines.push('', 'Full event dumps (gitignored, on the CI/dev machine):');
    lines.push(...dumps.map((d) => `- \`${d}\``));
  }
  return lines.join('\n');
}

function filesTouchedSection() {
  const mergeBase =
    git('merge-base', 'HEAD', `origin/${opts.base}`).out || git('merge-base', 'HEAD', opts.base).out;
  if (!mergeBase) {
    return `## Files touched\n\n_merge-base with ${opts.base} unresolved in this clone._`;
  }
  const nameStatus = git('diff', '--name-status', `${mergeBase}..HEAD`).out;
  const numstat = git('diff', '--numstat', `${mergeBase}..HEAD`).out;
  const anchors = new Map(); // path -> "+a/-d"
  for (const line of numstat.split('\n')) {
    const [add, del, path] = line.split('\t');
    if (path) anchors.set(path, `+${add}/-${del}`);
  }
  const rows = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0];
      const path = parts[parts.length - 1];
      return `| \`${path}\` | ${status} | ${anchors.get(path) ?? ''} |`;
    });
  return [
    '## Files touched',
    '',
    `Diff base: merge-base of \`HEAD\` and \`origin/${opts.base}\` (\`${mergeBase.slice(0, 12)}\`).`,
    '',
    '| path | status | lines |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function failingSection() {
  const lines = ['## Failing event tests', ''];
  if (!buildGreen) {
    for (const [gate, g] of Object.entries(report.gates)) {
      if ((gate === 'typecheck' || gate === 'lint' || gate === 'build') && !g.pass) {
        lines.push(`**${gate} failed (exit ${g.exitCode}):**`, '', '```', g.outputTail ?? '', '```', '');
      }
    }
  }
  const failed = allAssertions.filter((a) => !a.pass);
  if (failed.length > 0) {
    lines.push(
      `${failed.length} failing assertion(s) from \`${runnerCmd}\`:`,
      '',
      '| test | section | name | detail |',
      '| --- | --- | --- | --- |',
      ...failed.map(
        (a) => `| ${mdCell(a.test)} | ${mdCell(a.section)} | ${mdCell(a.name)} | ${mdCell(a.detail)} |`
      )
    );
  }
  return lines.join('\n');
}

const bodyParts = [authored.trim(), howVerifiedSection(), filesTouchedSection()];
if (!green) bodyParts.push(failingSection());
const composedBody = bodyParts.join('\n\n');
const composedBodyPath = join(REPORTS_DIR, `pr-body-${opts.id.replace(/[^\w.-]/g, '_')}.md`);
mkdirSync(REPORTS_DIR, { recursive: true });
writeFileSync(composedBodyPath, composedBody);
report.composedBodyPath = composedBodyPath;

// ------------------------------------------------------------------- action

if (opts.dryRun) {
  // No gh mutations, no existing-PR probe: intendedAction assumes no open PR.
  console.error('--- composed PR body (dry-run) ---');
  console.error(composedBody);
  console.error('--- end composed body ---');
  await emit('dry-run', green ? 0 : 1, {
    intendedAction: green ? 'created' : 'draft-created',
  });
}

// Idempotency probe: is there already an open PR for this head?
const probe = gh(
  'pr', 'list', '--repo', opts.repo, '--head', branch, '--state', 'open',
  '--json', 'number,isDraft,url', '--jq', '.[0]'
);
if (probe.code !== 0) {
  console.error(`gh pr list failed: ${probe.err}`);
  await emit('refused-preconditions', 2);
}
const existing = probe.out ? JSON.parse(probe.out) : null;

if (green) {
  if (!existing) {
    const r = gh(
      'pr', 'create', '--repo', opts.repo, '--base', opts.base, '--head', branch,
      '--title', opts.title, '--body-file', composedBodyPath
    );
    if (r.code !== 0) {
      console.error(`gh pr create failed: ${r.err}`);
      await emit('refused-preconditions', 2);
    }
    await emit('created', 0, { prUrl: r.out });
  }
  const e = gh('pr', 'edit', String(existing.number), '--repo', opts.repo, '--body-file', composedBodyPath);
  if (e.code !== 0) {
    console.error(`gh pr edit failed: ${e.err}`);
    await emit('refused-preconditions', 2);
  }
  if (existing.isDraft) {
    const rdy = gh('pr', 'ready', String(existing.number), '--repo', opts.repo);
    if (rdy.code !== 0) {
      console.error(`gh pr ready failed: ${rdy.err}`);
      await emit('refused-preconditions', 2);
    }
    await emit('ready', 0, { prUrl: existing.url });
  }
  await emit('updated', 0, { prUrl: existing.url });
} else {
  if (!existing) {
    const r = gh(
      'pr', 'create', '--repo', opts.repo, '--base', opts.base, '--head', branch,
      '--title', `DRAFT: ${opts.title}`, '--draft', '--body-file', composedBodyPath
    );
    if (r.code !== 0) {
      console.error(`gh pr create --draft failed: ${r.err}`);
      await emit('refused-preconditions', 2);
    }
    await emit('draft-created', 1, { prUrl: r.out });
  }
  const e = gh('pr', 'edit', String(existing.number), '--repo', opts.repo, '--body-file', composedBodyPath);
  if (e.code !== 0) {
    console.error(`gh pr edit failed: ${e.err}`);
    await emit('refused-preconditions', 2);
  }
  await emit(existing.isDraft ? 'draft-updated' : 'updated', 1, { prUrl: existing.url });
}
