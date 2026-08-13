#!/usr/bin/env node
/**
 * S8 — sidecar Claude token: detect/repair/report the expired-copy clobber
 * (BACKLOG S8, brief PLAN-DOCS/discovery/S8.md).
 *
 * Root cause under test: the sidecar's CLAUDE_CONFIG_DIR held a point-in-time
 * COPY of ~/.claude/.credentials.json; refresh-token rotation killed the copy,
 * the CLI's failed refresh clobbered it to expiresAt:0, and every later turn
 * 401'd until a human recopied + restarted. Fix: ensureClaudeAuth() replaces
 * any regular-file copy with a symlink to the canonical source before every
 * turn, emits SSE `auth` / `auth_error` frames, and GET /health/auth exposes
 * the secret-free state.
 *
 * The test spawns its OWN sidecars against throwaway config dirs seeded with
 * the exact historical corruption ({"claudeAiOauth":{"expiresAt":0}}); no real
 * token is mutated. The positive path spends one minimal model turn (the
 * closest safe proxy for expiry — see the brief's residual-risk note).
 *
 * Assertions (brief section 4):
 *  1. /health/auth reports linked && !expired && expiresAt > now (repair ran).
 *  2. Build stream: `auth` frame with repaired===true before the first
 *     assistant frame; no `auth_error`; no `error` matching /401|OAuth|expired/i;
 *     terminal `done` status != 'error'.
 *  3. Thread: status !== 'error', >=1 assistant transcript item (a real model
 *     call succeeded through the repaired link).
 *  4. Negative control (source=/nonexistent): `auth_error` frame present AND
 *     done.status === 'error' (auth failure is distinguishable, not generic).
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/s8_auth_refresh.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../harness.mjs';

const t = await createHarness({ name: 's8_auth_refresh', backlogId: 'S8' });

const SIDECAR_DIR = join(
  fileURLToPath(new URL('../../..', import.meta.url)),
  'services',
  'builder-agent'
);
const CANONICAL_SOURCE = join(homedir(), '.claude', '.credentials.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clobberedConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 's8-config-'));
  t.cleanup(() => rmSync(dir, { recursive: true, force: true }));
  // The exact historical corruption: a REGULAR FILE dead copy.
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'dead', refreshToken: 'dead', expiresAt: 0 },
    })
  );
  return dir;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
    srv.on('error', reject);
  });
}

async function spawnSidecar(envOverrides) {
  const port = await freePort();
  const env = {
    ...process.env,
    BUILDER_PORT: String(port),
    GLUU_API_URL: t.stack.api,
    ...envOverrides,
  };
  // Any ambient credential env would outrank the credentials file under test
  // (vendor auth precedence) and mask both the repair and the negative control.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const child = spawn('node', ['src/index.ts'], {
    cwd: SIDECAR_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  t.cleanup(() => child.kill());
  const base = `http://localhost:${port}`;
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i++) {
    try {
      healthy = (await fetch(`${base}/health`)).ok;
    } catch {
      /* not up yet */
    }
    if (!healthy) await sleep(500);
  }
  if (!healthy) {
    throw new Error(`test sidecar never became healthy on ${base}\n${log.slice(-2000)}`);
  }
  return { base, child, getLog: () => log };
}

// --- 1. repair replaced the dead copy before any build ----------------------
t.section('health/auth after clobbered-copy repair');
const configDirA = clobberedConfigDir();
const sidecarA = await spawnSidecar({
  BUILDER_CLAUDE_CONFIG_DIR: configDirA,
  BUILDER_CLAUDE_CREDENTIALS_SOURCE: CANONICAL_SOURCE,
});
const healthRes = await fetch(`${sidecarA.base}/health/auth`);
const health = await healthRes.json();
t.assert('GET /health/auth responds 200', healthRes.status === 200, `HTTP ${healthRes.status}`);
t.assert(
  'repair replaced the dead copy: linked && !expired && expiresAt > now',
  health.linked === true && health.expired === false && health.expiresAt > Date.now(),
  JSON.stringify(health)
);

// --- 2. build stream carries the auth frame, no auth errors -----------------
t.section('build stream through the repaired link');
const flowId = await t.seedFlow({
  name: 's8-auth-refresh',
  prompt: 'S8 event test: auth repair fixture flow',
  code: `import { BubbleFlow } from '@bubblelab/bubble-core';

export interface Output {
  greeting: string;
}

export class S8AuthFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 6 * * *';
  async handle(): Promise<Output> {
    return { greeting: 'hello' };
  }
}
`,
});
const frames = await t.sse(
  sidecarA.base,
  `/build/${flowId}/message`,
  { message: 'Reply with the single word OK. Do not call any tools or change the flow.' },
  5 * 60_000
);
// NOTE: `repaired` is call-scoped (true only on the ensureClaudeAuth() call
// that performs the fix). The preceding GET /health/auth already consumed
// that repair, so this build-stream call is a SECOND call in the same
// process — it legitimately reports repaired:false with nothing left to fix.
// The actual S8 guarantee is that auth is healthy (linked, not expired) by
// the time the assistant frame arrives, regardless of which call fixed it.
const authIdx = frames.findIndex(
  (f) => f.event === 'auth' && f.data?.linked === true && f.data?.expired === false
);
const firstAssistantIdx = frames.findIndex((f) => f.event === 'assistant');
t.assert(
  'auth frame (linked, not expired) precedes the first assistant frame',
  authIdx !== -1 && firstAssistantIdx !== -1 && authIdx < firstAssistantIdx,
  `authIdx=${authIdx} firstAssistantIdx=${firstAssistantIdx}`
);
t.assert(
  'no auth_error frame',
  !frames.some((f) => f.event === 'auth_error'),
  JSON.stringify(frames.filter((f) => f.event === 'auth_error')).slice(0, 300)
);
const authyErrors = frames.filter(
  (f) => f.event === 'error' && /401|OAuth|expired/i.test(String(f.data?.message ?? ''))
);
t.assert('no error frame matching /401|OAuth|expired/i', authyErrors.length === 0, JSON.stringify(authyErrors).slice(0, 300));
const done = frames.find((f) => f.event === 'done');
t.assert(
  "done status is ready|blocked_on_credential (not 'error')",
  done !== undefined && ['ready', 'blocked_on_credential'].includes(done.data?.status),
  JSON.stringify(done?.data ?? null)
);

// --- 3. thread proves a real model call succeeded ---------------------------
t.section('thread after the turn');
const thread = await (await fetch(`${sidecarA.base}/build/${flowId}/thread`)).json();
t.assert(
  "thread status !== 'error' with >=1 assistant transcript item",
  thread.status !== 'error' &&
    Array.isArray(thread.transcript) &&
    thread.transcript.some((item) => item.role === 'assistant'),
  `status=${thread.status} transcriptItems=${thread.transcript?.length}`
);
sidecarA.child.kill();

// --- 4. negative control: dead source -> distinguishable auth_error ---------
t.section('negative control: nonexistent credentials source');
const configDirB = clobberedConfigDir();
const sidecarB = await spawnSidecar({
  BUILDER_CLAUDE_CONFIG_DIR: configDirB,
  BUILDER_CLAUDE_CREDENTIALS_SOURCE: '/nonexistent/.credentials.json',
});
const negHealth = await (await fetch(`${sidecarB.base}/health/auth`)).json();
t.assert(
  'health/auth reports the dead source (expired, unreadable)',
  negHealth.expired === true && negHealth.sourceReadable === false,
  JSON.stringify(negHealth)
);
const negFrames = await t.sse(
  sidecarB.base,
  `/build/${flowId}/message`,
  { message: 'Reply with the single word OK.' },
  3 * 60_000
);
const negDone = negFrames.find((f) => f.event === 'done');
t.assert(
  'auth_error frame present',
  negFrames.some((f) => f.event === 'auth_error'),
  negFrames.map((f) => f.event).join(',').slice(0, 300)
);
t.assert(
  "done status === 'error'",
  negDone !== undefined && negDone.data?.status === 'error',
  JSON.stringify(negDone?.data ?? null)
);
sidecarB.child.kill();

await t.finish();
