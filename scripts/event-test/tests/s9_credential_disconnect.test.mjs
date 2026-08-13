#!/usr/bin/env node
/**
 * S9 — true credential disconnect (BACKLOG S9).
 *
 * Root cause under test: deleting a credential already revokes at the
 * provider (routes/credentials.ts -> oauthService.revokeCredential), but
 * three gaps made a delete+re-add cycle LOOK like "reconnecting" instead of a
 * clean disconnect:
 *  (a) an expired token's revoke is a no-op at the provider — the call must
 *      still run and log the outcome, never silently assume success.
 *  (b) re-adding with no credentialId must NOT carry incremental-consent
 *      hints (login_hint/include_granted_scopes) from a prior connection —
 *      Google gets prompt=consent+select_account and a truly fresh screen.
 *  (c) providers with no programmatic revoke endpoint (jira/Atlassian) must
 *      tell the user to remove BubbleLab from the provider's own
 *      connected-apps page, with a working link.
 *
 * There is no HTTP path to create an isOauth:true credential row without a
 * real browser consent round-trip (createCredentialRoute only ever stores
 * non-OAuth encryptedValue rows), so this test seeds OAuth credential rows
 * directly in Postgres (via psql) with garbage tokens encrypted the same way
 * CredentialEncryption does (AES-256-GCM, scrypt-derived key from
 * CREDENTIAL_ENCRYPTION_KEY) — safe to send to the real Google revoke
 * endpoint (a public, idempotent, non-destructive endpoint; the token is
 * fake so no real user grant is touched) and to the real Atlassian
 * manage-apps URL (a plain GET to prove the link is live).
 *
 * T1 incremental initiate (credentialId given) — unchanged behavior: login_hint
 *    + include_granted_scopes still present (contrast baseline for T2).
 * T2 new-add initiate (no credentialId)        — prompt=consent+select_account,
 *    NO login_hint, NO include_granted_scopes (S9b).
 * T3 delete a connected google credential      — provider revoke actually
 *    called (asserted via the oauth.revoke_attempted telemetry event, S9a),
 *    row is gone, no manageAppsUrl (google has a real revoke endpoint).
 * T4 delete a connected jira credential        — providerRevocation.status
 *    'unsupported' + a manageAppsUrl that is actually reachable (S9c).
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/s9_credential_disconnect.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createCipheriv,
  randomBytes,
  scrypt as scryptCb,
} from 'node:crypto';
import { promisify } from 'node:util';
import { parse as parseEnv } from 'dotenv';
import { createHarness } from '../harness.mjs';
import { repoRoot } from '../lib/stack.mjs';

const scrypt = promisify(scryptCb);

const ROOT = repoRoot();
const API_ENV_PATH = join(ROOT, 'apps', 'bubblelab-api', '.env');
const DATABASE_URL =
  process.env.EVENT_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://bubblelab:bubblelab@localhost:5432/bubblelab';
const DEV_USER_ID = 'mock-user-id';

// --- replicate apps/bubblelab-api/src/utils/encryption.ts CredentialEncryption.encrypt
// exactly (same algorithm/lengths), so the running API's decrypt() succeeds on rows
// this test seeds directly. The master key must match the API process's own env.
const ALG = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 16;
const TAG_LEN = 16;
const SALT_LEN = 32;

function loadEncryptionKey() {
  const parsed = parseEnv(readFileSync(API_ENV_PATH));
  const key = parsed.CREDENTIAL_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY missing/too short in ${API_ENV_PATH}`
    );
  }
  return key;
}

async function encryptToken(plaintext, masterKey) {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(masterKey, salt, KEY_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, ciphertext]).toString('base64');
}

/** psql values below are all our own base64/literal strings (no quotes possible) — safe to inline. */
/**
 * `-t -A` still prints a trailing "INSERT 0 1" command tag after a RETURNING
 * row (psql only suppresses that tag with -q/--quiet, which would also
 * swallow real errors) — take the first line, which is always the value.
 */
function psql(sql) {
  const out = execFileSync('psql', [DATABASE_URL, '-t', '-A', '-c', sql], {
    encoding: 'utf8',
  }).trim();
  return out.split('\n')[0].trim();
}

const t = await createHarness({ name: 's9_credential_disconnect', backlogId: 'S9' });

const seededIds = [];
function cleanupSeeds() {
  if (seededIds.length === 0) return;
  try {
    psql(
      `DELETE FROM user_credentials WHERE id IN (${seededIds.join(',')});`
    );
  } catch {
    /* best-effort — the delete-endpoint assertions already remove these rows */
  }
}
t.cleanup(async () => cleanupSeeds());

try {
  const masterKey = loadEncryptionKey();

  t.section('Seed: two connected OAuth credentials (google, jira) via direct DB insert');
  const googleAccessCipher = await encryptToken('s9-fake-google-access-token', masterKey);
  const googleRefreshCipher = await encryptToken('s9-fake-google-refresh-token', masterKey);
  const jiraAccessCipher = await encryptToken('s9-fake-jira-access-token', masterKey);

  const googleCredId = Number(
    psql(`
      INSERT INTO user_credentials
        (user_id, credential_type, name, is_oauth, oauth_provider, oauth_access_token, oauth_refresh_token, metadata, created_at, updated_at)
      VALUES
        ('${DEV_USER_ID}', 'GOOGLE_DRIVE_CRED', 's9 test google', true, 'google',
         '${googleAccessCipher}', '${googleRefreshCipher}', '{"email":"s9-test@example.com"}'::jsonb, now(), now())
      RETURNING id;
    `)
  );
  seededIds.push(googleCredId);
  t.assert('seeded a connected google credential row', Number.isFinite(googleCredId), `id=${googleCredId}`);

  const jiraCredId = Number(
    psql(`
      INSERT INTO user_credentials
        (user_id, credential_type, name, is_oauth, oauth_provider, oauth_access_token, created_at, updated_at)
      VALUES
        ('${DEV_USER_ID}', 'JIRA_CRED', 's9 test jira', true, 'jira', '${jiraAccessCipher}', now(), now())
      RETURNING id;
    `)
  );
  seededIds.push(jiraCredId);
  t.assert('seeded a connected jira credential row', Number.isFinite(jiraCredId), `id=${jiraCredId}`);

  // --- T1: incremental initiate (baseline contrast for T2) -----------------
  t.section('T1 incremental initiate (credentialId given) — unchanged carry-over behavior');
  const t1 = await t.api('/oauth/google/initiate', {
    method: 'POST',
    body: JSON.stringify({ credentialType: 'GOOGLE_DRIVE_CRED', credentialId: googleCredId }),
  });
  t.assert('incremental initiate responds 200 with authUrl', t1.status === 200 && typeof t1.body?.authUrl === 'string',
    `HTTP ${t1.status}: ${JSON.stringify(t1.body).slice(0, 200)}`);
  const t1Url = t1.status === 200 ? new URL(t1.body.authUrl) : null;
  t.assert('incremental initiate carries login_hint from the row\'s metadata email',
    t1Url?.searchParams.get('login_hint') === 's9-test@example.com',
    `login_hint=${t1Url?.searchParams.get('login_hint')}`);
  t.assert('incremental initiate carries include_granted_scopes=true',
    t1Url?.searchParams.get('include_granted_scopes') === 'true',
    `include_granted_scopes=${t1Url?.searchParams.get('include_granted_scopes')}`);

  // --- T2: brand-new add (no credentialId) — S9(b) --------------------------
  t.section('T2 new-add initiate (no credentialId) — forced fresh consent, S9(b)');
  const t2 = await t.api('/oauth/google/initiate', {
    method: 'POST',
    body: JSON.stringify({ credentialType: 'GOOGLE_DRIVE_CRED', name: 's9 fresh add' }),
  });
  t.assert('new-add initiate responds 200 with authUrl', t2.status === 200 && typeof t2.body?.authUrl === 'string',
    `HTTP ${t2.status}: ${JSON.stringify(t2.body).slice(0, 200)}`);
  const t2Url = t2.status === 200 ? new URL(t2.body.authUrl) : null;
  t.assert('new-add initiate forces prompt=consent select_account',
    t2Url?.searchParams.get('prompt') === 'consent select_account',
    `prompt=${JSON.stringify(t2Url?.searchParams.get('prompt'))}`);
  t.assert('new-add initiate carries NO login_hint (no stale account hint)',
    t2Url?.searchParams.get('login_hint') === null,
    `login_hint=${JSON.stringify(t2Url?.searchParams.get('login_hint'))}`);
  t.assert('new-add initiate carries NO include_granted_scopes (no incremental re-grant)',
    t2Url?.searchParams.get('include_granted_scopes') === null,
    `include_granted_scopes=${JSON.stringify(t2Url?.searchParams.get('include_granted_scopes'))}`);

  // --- T3: delete the connected google credential — provider revoke fires (S9a) ---
  t.section('T3 delete connected google credential — provider revoke is actually called (S9a)');
  const baseline = await t.telemetryBaseline();
  const t3 = await t.api(`/credentials/${googleCredId}`, { method: 'DELETE' });
  t.assert('delete google credential responds 200', t3.status === 200, `HTTP ${t3.status}: ${JSON.stringify(t3.body).slice(0, 200)}`);
  const t3Status = t3.body?.providerRevocation?.status;
  t.assert('google delete response carries a providerRevocation status other than unsupported (google DOES have a revoke endpoint)',
    ['revoked', 'already_invalid', 'error'].includes(t3Status), `status=${t3Status}`);
  t.assert('google delete response carries NO manageAppsUrl (revoke is programmatic for google)',
    t3.body?.providerRevocation?.manageAppsUrl === undefined,
    JSON.stringify(t3.body?.providerRevocation));

  // GET /telemetry wraps the studio's client-event shape as { seq, receivedAt, userId, event: {...} };
  // the actual payload this test posted (provider/status/credentialId) lives under .event.
  const revokeEvents = await t.telemetry({ type: 'oauth.revoke_attempted', sinceSeq: baseline });
  const googleRevokeEvent = revokeEvents.find((e) => e.event?.credentialId === googleCredId)?.event;
  t.assert('oauth.revoke_attempted telemetry event logged for the google delete (provider endpoint was actually hit, not silently skipped)',
    Boolean(googleRevokeEvent) && googleRevokeEvent.provider === 'google',
    JSON.stringify(googleRevokeEvent));
  t.assert('telemetry event status matches the HTTP response status (S9a: outcome logged, not silently swallowed)',
    googleRevokeEvent?.status === t3Status,
    `telemetry=${googleRevokeEvent?.status} response=${t3Status}`);

  const googleRowGone = psql(`SELECT count(*) FROM user_credentials WHERE id = ${googleCredId};`);
  t.assert('google credential row is actually gone from the database', googleRowGone === '0', `count=${googleRowGone}`);

  // --- T4: delete the connected jira credential — no-revoke provider (S9c) ---
  t.section('T4 delete connected jira credential — no-revoke provider gets a working manage-apps link (S9c)');
  const t4 = await t.api(`/credentials/${jiraCredId}`, { method: 'DELETE' });
  t.assert('delete jira credential responds 200', t4.status === 200, `HTTP ${t4.status}: ${JSON.stringify(t4.body).slice(0, 200)}`);
  const jiraRevocation = t4.body?.providerRevocation;
  t.assert('jira delete response status is unsupported (Atlassian documents no programmatic revoke)',
    jiraRevocation?.status === 'unsupported', JSON.stringify(jiraRevocation));
  t.assert('jira delete response carries the Atlassian manage-apps URL',
    jiraRevocation?.manageAppsUrl === 'https://id.atlassian.com/manage-profile/apps',
    JSON.stringify(jiraRevocation));
  t.assert('jira delete response instructions mention removing the app at the provider',
    typeof jiraRevocation?.manageAppsInstructions === 'string' &&
      /atlassian/i.test(jiraRevocation.manageAppsInstructions) &&
      /remove/i.test(jiraRevocation.manageAppsInstructions),
    jiraRevocation?.manageAppsInstructions);

  let manageAppsReachable = false;
  let manageAppsDetail = '';
  try {
    const res = await fetch(jiraRevocation.manageAppsUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    manageAppsReachable = res.status < 500;
    manageAppsDetail = `HTTP ${res.status}`;
  } catch (e) {
    manageAppsDetail = e?.message ?? String(e);
  }
  t.assert('the manageAppsUrl is a working link (reachable, not a dead/broken URL)', manageAppsReachable, manageAppsDetail);

  const jiraRevokeEvents = await t.telemetry({ type: 'oauth.revoke_attempted', sinceSeq: baseline });
  const jiraRevokeEvent = jiraRevokeEvents.find((e) => e.event?.credentialId === jiraCredId)?.event;
  t.assert('oauth.revoke_attempted telemetry event logged for the jira delete with status unsupported',
    jiraRevokeEvent?.status === 'unsupported' && jiraRevokeEvent?.provider === 'jira',
    JSON.stringify(jiraRevokeEvent));

  const jiraRowGone = psql(`SELECT count(*) FROM user_credentials WHERE id = ${jiraCredId};`);
  t.assert('jira credential row is actually gone from the database (deleted regardless of provider revoke support)',
    jiraRowGone === '0', `count=${jiraRowGone}`);
} catch (e) {
  t.assert('unexpected test error', false, e?.stack ?? String(e));
} finally {
  cleanupSeeds();
}

await t.finish();
