/**
 * Unit tests for claude-auth.ts (BACKLOG S8): detect/repair/report of the
 * expired-copy clobber (expiresAt:0) with zero live tokens — every case runs
 * against throwaway temp dirs. Node's built-in runner; exit-coded.
 *
 * Run: node --test test/claude-auth.test.ts   (package script: npm test)
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureClaudeAuth, readAuthState } from '../src/claude-auth.ts';

const HOUR = 60 * 60 * 1000;

// The ambient env must not flip file-mode tests into token mode (vendor
// precedence: CLAUDE_CODE_OAUTH_TOKEN outranks the credentials file).
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's8-claude-auth-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeCreds(path: string, expiresAt: number): void {
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fake-access',
        refreshToken: 'fake-refresh',
        expiresAt,
        subscriptionType: 'max',
      },
    })
  );
}

function freshPaths(sourceExpiresAt: number | null = Date.now() + HOUR): {
  configDir: string;
  credentialsSource: string;
} {
  const root = tempRoot();
  const credentialsSource = join(root, 'home-claude', '.credentials.json');
  mkdirSync(join(root, 'home-claude'), { recursive: true });
  if (sourceExpiresAt !== null) writeCreds(credentialsSource, sourceExpiresAt);
  return { configDir: join(root, 'config-dir'), credentialsSource };
}

test('provisions a missing config dir with a symlink to the source', () => {
  const paths = freshPaths();
  const repair = ensureClaudeAuth(paths);
  assert.equal(repair.repaired, true);
  assert.ok(repair.actions.includes('created-config-dir'));
  assert.ok(repair.actions.includes('linked-credentials'));
  const credPath = join(paths.configDir, '.credentials.json');
  assert.ok(lstatSync(credPath).isSymbolicLink());
  assert.equal(readlinkSync(credPath), paths.credentialsSource);
  assert.equal(repair.state.linked, true);
  assert.equal(repair.state.expired, false);
  assert.ok(
    repair.state.expiresAt !== null && repair.state.expiresAt > Date.now()
  );
  assert.equal(repair.state.subscriptionType, 'max');
});

test('detects and replaces the historical expiresAt:0 clobbered copy', () => {
  const paths = freshPaths();
  mkdirSync(paths.configDir, { recursive: true });
  writeCreds(join(paths.configDir, '.credentials.json'), 0); // the clobber
  const repair = ensureClaudeAuth(paths);
  assert.equal(repair.repaired, true);
  assert.ok(repair.actions.includes('replaced-clobbered-copy-expiresAt-0'));
  assert.ok(
    lstatSync(join(paths.configDir, '.credentials.json')).isSymbolicLink()
  );
  assert.equal(repair.state.linked, true);
  assert.equal(repair.state.expired, false);
});

test('replaces a stale (non-clobbered) regular-file copy', () => {
  const paths = freshPaths();
  mkdirSync(paths.configDir, { recursive: true });
  writeCreds(join(paths.configDir, '.credentials.json'), Date.now() - HOUR);
  const repair = ensureClaudeAuth(paths);
  assert.equal(repair.repaired, true);
  assert.ok(repair.actions.includes('replaced-stale-copy'));
  assert.equal(repair.state.linked, true);
});

test('retargets a symlink pointing at the wrong file', () => {
  const paths = freshPaths();
  mkdirSync(paths.configDir, { recursive: true });
  const wrong = join(paths.configDir, 'wrong.json');
  writeCreds(wrong, Date.now() + HOUR);
  symlinkSync(wrong, join(paths.configDir, '.credentials.json'));
  const repair = ensureClaudeAuth(paths);
  assert.equal(repair.repaired, true);
  assert.ok(repair.actions.includes('relinked-credentials'));
  assert.equal(
    readlinkSync(join(paths.configDir, '.credentials.json')),
    paths.credentialsSource
  );
});

test('is idempotent: a healthy state repairs nothing', () => {
  const paths = freshPaths();
  ensureClaudeAuth(paths);
  const second = ensureClaudeAuth(paths);
  assert.equal(second.repaired, false);
  assert.ok(!second.actions.includes('linked-credentials'));
  assert.ok(!second.actions.includes('replaced-stale-copy'));
  assert.equal(second.state.linked, true);
});

test('captures a last-known-good backup while the source is healthy', () => {
  const paths = freshPaths();
  const repair = ensureClaudeAuth(paths);
  assert.ok(repair.actions.includes('refreshed-backup'));
  const backup = JSON.parse(
    readFileSync(join(paths.configDir, '.credentials.backup.json'), 'utf8')
  );
  assert.ok(backup.claudeAiOauth.expiresAt > Date.now());
});

test('restores a clobbered SOURCE (expiresAt:0) from an unexpired backup', () => {
  const paths = freshPaths();
  ensureClaudeAuth(paths); // captures the backup
  writeCreds(paths.credentialsSource, 0); // sidecar-side refresh failure clobbers the source
  const repair = ensureClaudeAuth(paths);
  assert.equal(repair.repaired, true);
  assert.ok(repair.actions.includes('restored-source-from-backup'));
  const restored = JSON.parse(readFileSync(paths.credentialsSource, 'utf8'));
  assert.ok(restored.claudeAiOauth.expiresAt > Date.now());
  assert.equal(repair.state.expired, false);
});

test('never overwrites a live source: expired-but-nonzero source is left alone', () => {
  const paths = freshPaths(Date.now() - HOUR);
  const before = readFileSync(paths.credentialsSource, 'utf8');
  const repair = ensureClaudeAuth(paths);
  assert.ok(!repair.actions.includes('restored-source-from-backup'));
  assert.ok(!repair.actions.includes('refreshed-backup'));
  assert.equal(readFileSync(paths.credentialsSource, 'utf8'), before);
  assert.equal(repair.state.expired, true);
});

test('missing source: still links (dangling), reports unreadable + expired', () => {
  const paths = freshPaths(null);
  const repair = ensureClaudeAuth(paths);
  assert.ok(repair.actions.includes('linked-credentials'));
  assert.equal(repair.state.sourceReadable, false);
  assert.equal(repair.state.expired, true);
  assert.equal(repair.state.expiresAt, null);
});

test('CLAUDE_CODE_OAUTH_TOKEN mode: no file management, never expired', () => {
  const paths = freshPaths();
  const repair = ensureClaudeAuth({ ...paths, oauthToken: 'sk-oauth-fake' });
  assert.equal(repair.repaired, false);
  assert.deepEqual(repair.actions, ['oauth-token-env']);
  assert.equal(repair.state.mode, 'oauth-token-env');
  assert.equal(repair.state.expired, false);
  // No config dir was created.
  assert.throws(() => lstatSync(join(paths.configDir, '.credentials.json')));
});

test('readAuthState returns no token material', () => {
  const paths = freshPaths();
  ensureClaudeAuth(paths);
  const state = readAuthState(paths) as unknown as Record<string, unknown>;
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('fake-access'));
  assert.ok(!serialized.includes('fake-refresh'));
});

test('writes the onboarding marker once', () => {
  const paths = freshPaths();
  const first = ensureClaudeAuth(paths);
  assert.ok(first.actions.includes('wrote-onboarding-config'));
  const marker = JSON.parse(
    readFileSync(join(paths.configDir, '.claude.json'), 'utf8')
  );
  assert.equal(marker.hasCompletedOnboarding, true);
  const second = ensureClaudeAuth(paths);
  assert.ok(!second.actions.includes('wrote-onboarding-config'));
});
