#!/usr/bin/env node
/**
 * S7 — stateless OAuth CSRF state survives the process boundary
 * (BACKLOG S7, brief PLAN-DOCS/discovery/S7.md).
 *
 * Root cause under test: the CSRF state lived in a per-process in-memory Map
 * (oauth-service.ts stateStore), so authorize on process A + callback on
 * process B (restart, replica, supervisor respawn) always died with
 * "Invalid or expired state parameter", burning the user's consent. Fix:
 * the state IS the sealed AES-256-GCM payload (CredentialEncryption), so any
 * process holding CREDENTIAL_ENCRYPTION_KEY validates it statelessly.
 *
 * This test boots TWO real API processes (A issues, B validates) from this
 * checkout — the dev-stack is NOT used because the cross-process property
 * needs two processes under the test's control (B carries a short
 * OAUTH_STATE_TTL_MS for the expiry assertion). Every assertion reads logged
 * events (per-process GET /telemetry ring buffers) or HTTP error payloads —
 * never a DOM. Each process's buffer is its own, which is what makes T2 a
 * cross-process proof: B has the state_validated event for a state it never
 * issued.
 *
 *  T1 issue on A            -> oauth.state_issued on A with sha256 stateHash
 *  T2 validate on B         -> callback fails ONLY at the token exchange
 *                              (bogus code), never at state validation;
 *                              oauth.state_validated on B, zero state_issued
 *  T3 tampered state on B   -> invalid-state error + state_rejected{decrypt_failed}
 *  T4 expired state on B    -> expired error + state_rejected{expired}
 *                              (B runs OAUTH_STATE_TTL_MS=5000; sleep 5.6s)
 *  T5 provider mismatch     -> invalid-state error + state_rejected{provider_mismatch}
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/s7_oauth_state.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createReporter, REPORTS_DIR } from '../lib/report.mjs';
import { repoRoot, currentBranch, EXIT_STACK_UNAVAILABLE } from '../lib/stack.mjs';

const ROOT = repoRoot();
const API_DIR = join(ROOT, 'apps', 'bubblelab-api');
const BUN = process.env.BUN ?? join(homedir(), '.bun', 'bin', 'bun');
const DATABASE_URL =
  process.env.EVENT_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://bubblelab:bubblelab@localhost:5432/bubblelab';
const TTL_B_MS = 5000;

const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitHttp(url, seconds) {
  for (let i = 0; i < seconds; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

/** Boot one API process on `port`; extraEnv layers on top of the .env bun loads. */
function bootApi(label, port, extraEnv, logPath) {
  const out = openSync(logPath, 'a');
  const child = spawn(BUN, ['run', 'src/index.ts'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      NODEX_API_URL: `http://localhost:${port}`,
      DATABASE_URL,
      DISABLE_AUTH: 'true',
      NODE_OPTIONS: '--dns-result-order=ipv4first',
      ...extraEnv,
    },
    stdio: ['ignore', out, out],
  });
  child.on('error', (e) => console.error(`${label} spawn error: ${e.message}`));
  return child;
}

async function api(base, path, init) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    ...init,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

/** Events of `type` on `base` whose stateHash matches (all if hash omitted). */
async function stateEvents(base, type, stateHash) {
  const res = await api(base, `/telemetry?type=${type}&limit=500`);
  const events = (res.body?.events ?? []).map((e) => e.event);
  return stateHash ? events.filter((e) => e.stateHash === stateHash) : events;
}

// --- boot the two processes (sequential: shared-DB migrations must not race)
mkdirSync(REPORTS_DIR, { recursive: true });
const portA = await freePort();
const portB = await freePort();
const A = `http://localhost:${portA}`;
const B = `http://localhost:${portB}`;
const logA = join(REPORTS_DIR, `s7-api-A-${portA}.log`);
const logB = join(REPORTS_DIR, `s7-api-B-${portB}.log`);

const children = [];
function killAll() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', killAll);

const childA = bootApi('A', portA, {}, logA);
children.push(childA);
if (!(await waitHttp(`${A}/`, 90))) {
  killAll();
  console.error(`STACK UNAVAILABLE  process A failed to boot (see ${logA})`);
  console.log(
    JSON.stringify({
      test: 's7_oauth_state',
      pass: false,
      exitCode: EXIT_STACK_UNAVAILABLE,
      stackUnavailable: true,
      error: `API process A failed to boot on :${portA}`,
      assertions: [],
    })
  );
  process.exit(EXIT_STACK_UNAVAILABLE);
}
const childB = bootApi('B', portB, { OAUTH_STATE_TTL_MS: String(TTL_B_MS) }, logB);
children.push(childB);
if (!(await waitHttp(`${B}/`, 90))) {
  killAll();
  console.error(`STACK UNAVAILABLE  process B failed to boot (see ${logB})`);
  console.log(
    JSON.stringify({
      test: 's7_oauth_state',
      pass: false,
      exitCode: EXIT_STACK_UNAVAILABLE,
      stackUnavailable: true,
      error: `API process B failed to boot on :${portB}`,
      assertions: [],
    })
  );
  process.exit(EXIT_STACK_UNAVAILABLE);
}

const reporter = createReporter({
  name: 's7_oauth_state',
  backlogId: 'S7',
  branch: currentBranch(),
  stack: { api: A, apiB: B, sidecar: null, studio: null, source: 'self-booted' },
});
const t = (name, pass, detail) => reporter.assert(name, pass, detail);

async function finish() {
  killAll();
  const report = reporter.build();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.exitCode);
}

const initiate = (base, provider = 'google') =>
  api(base, `/oauth/${provider}/initiate`, {
    method: 'POST',
    body: JSON.stringify({
      credentialType: 'GOOGLE_DRIVE_CRED',
      name: 's7 event test',
    }),
  });

// `name` is required by oauthCallbackRequestSchema (shared-schemas) — the
// studio's OAuthCallback.tsx always sends it on the POST completion path.
const callback = (base, provider, state, code = 'bogus-code-s7') =>
  api(base, `/oauth/${provider}/callback`, {
    method: 'POST',
    body: JSON.stringify({ code, state, name: 's7 event test' }),
  });

try {
  // --- T1: issue on A ---------------------------------------------------------
  reporter.section('T1 issue on process A');
  const t1 = await initiate(A);
  t('initiate on A responds 200 { authUrl, state }',
    t1.status === 200 && typeof t1.body?.authUrl === 'string' && typeof t1.body?.state === 'string',
    `HTTP ${t1.status}: ${JSON.stringify(t1.body).slice(0, 200)}`);
  const state = t1.body?.state ?? '';
  const hash = sha12(state);
  t('authUrl carries the sealed state verbatim',
    Boolean(state) && new URL(t1.body.authUrl).searchParams.get('state') === state,
    `state length=${state.length}`);
  const issuedA = await stateEvents(A, 'oauth.state_issued', hash);
  t('A logged oauth.state_issued with the sha256 stateHash',
    issuedA.length === 1,
    JSON.stringify(issuedA).slice(0, 200));

  // --- T2: cross-process validation on B -------------------------------------
  reporter.section('T2 validate on process B (the cross-process proof)');
  const t2 = await callback(B, 'google', state);
  const t2err = String(t2.body?.error ?? '');
  t('callback on B fails ONLY at the token exchange (bogus code)',
    t2.status === 400 && /token exchange failed/i.test(t2err),
    `HTTP ${t2.status}: ${t2err.slice(0, 200)}`);
  t('callback on B never hits the invalid/expired state path',
    !/Invalid or expired state|State parameter expired/.test(t2err),
    t2err.slice(0, 200));
  const validatedB = await stateEvents(B, 'oauth.state_validated', hash);
  t('B logged oauth.state_validated for the state A issued',
    validatedB.length === 1,
    JSON.stringify(validatedB).slice(0, 200));
  const issuedB = await stateEvents(B, 'oauth.state_issued', hash);
  t('B never logged state_issued for that hash (B did not issue it — A did)',
    issuedB.length === 0,
    JSON.stringify(issuedB).slice(0, 200));

  // --- T3: forgery ------------------------------------------------------------
  reporter.section('T3 tampered state rejected (GCM auth tag)');
  const mid = Math.floor(state.length / 2);
  const forged =
    state.slice(0, mid) + (state[mid] === 'A' ? 'B' : 'A') + state.slice(mid + 1);
  const t3 = await callback(B, 'google', forged);
  t('forged state dies with the exact invalid-state error',
    t3.status === 400 && /Invalid or expired state parameter/.test(String(t3.body?.error)),
    `HTTP ${t3.status}: ${String(t3.body?.error).slice(0, 200)}`);
  const rejectedForged = await stateEvents(B, 'oauth.state_rejected', sha12(forged));
  t('B logged state_rejected { reason: decrypt_failed }',
    rejectedForged.some((e) => e.reason === 'decrypt_failed'),
    JSON.stringify(rejectedForged).slice(0, 200));

  // --- T4: expiry (B enforces OAUTH_STATE_TTL_MS=5000 from the sealed iat) ----
  reporter.section('T4 expiry across processes');
  const t4init = await initiate(A);
  const stateT4 = t4init.body?.state ?? '';
  t('fresh initiate on A for the expiry probe', t4init.status === 200 && Boolean(stateT4),
    `HTTP ${t4init.status}`);
  // Margin is 2.5s, not a few hundred ms: WSL2 clock resync can step the
  // clock backward mid-sleep, shrinking the age B measures from the sealed
  // iat (observed: a 5.6s sleep measuring under 5s). The rejected event's
  // stateAgeMs/stateTtlMs fields make any future flake diagnosable.
  await sleep(TTL_B_MS + 2500);
  const t4 = await callback(B, 'google', stateT4);
  t('expired state dies with the exact expired error',
    t4.status === 400 && /State parameter expired/.test(String(t4.body?.error)),
    `HTTP ${t4.status}: ${String(t4.body?.error).slice(0, 200)}`);
  const rejectedExpired = await stateEvents(B, 'oauth.state_rejected', sha12(stateT4));
  t('B logged state_rejected { reason: expired }',
    rejectedExpired.some((e) => e.reason === 'expired'),
    JSON.stringify(rejectedExpired).slice(0, 200));

  // --- T5: provider mismatch --------------------------------------------------
  reporter.section('T5 provider mismatch');
  const t5init = await initiate(A);
  const stateT5 = t5init.body?.state ?? '';
  t('fresh initiate on A for the mismatch probe', t5init.status === 200 && Boolean(stateT5),
    `HTTP ${t5init.status}`);
  const t5 = await callback(B, 'notion', stateT5);
  t('google state on the notion callback dies with the invalid-state error',
    t5.status === 400 && /Invalid or expired state parameter/.test(String(t5.body?.error)),
    `HTTP ${t5.status}: ${String(t5.body?.error).slice(0, 200)}`);
  const rejectedMismatch = await stateEvents(B, 'oauth.state_rejected', sha12(stateT5));
  t('B logged state_rejected { reason: provider_mismatch }',
    rejectedMismatch.some((e) => e.reason === 'provider_mismatch'),
    JSON.stringify(rejectedMismatch).slice(0, 200));

  // Pillar-2 self-event: this harness run is itself a queryable logged event.
  try {
    const built = reporter.build();
    await api(A, '/telemetry', {
      method: 'POST',
      body: JSON.stringify({
        event: 'event_test.run',
        ts: new Date().toISOString(),
        test: 's7_oauth_state',
        backlogId: 'S7',
        branch: currentBranch(),
        pass: built.pass,
        exitCode: built.exitCode,
        assertions: built.assertions.length,
        failed: built.assertions.filter((a) => !a.pass).length,
      }),
    });
  } catch {
    /* best-effort sink */
  }
} catch (e) {
  t('unexpected test error', false, e?.stack ?? String(e));
}

await finish();
