/**
 * Sidecar Claude auth management (BACKLOG S8).
 *
 * The spawned Claude CLI authenticates from `$CLAUDE_CONFIG_DIR/.credentials.json`.
 * Historical failure mode: that dir held a point-in-time COPY of
 * `~/.claude/.credentials.json`; Anthropic rotates the refresh token on every
 * refresh, so the copy's refresh token went stale, the CLI's failed refresh
 * clobbered the copy to `expiresAt: 0`, and every later turn 401'd until a
 * human recopied the file and restarted the sidecar.
 *
 * This module codifies the durable model instead of the copy:
 * - `.credentials.json` in the config dir is a SYMLINK to the canonical source
 *   (`config.claudeCredentialsSource`, default `~/.claude/.credentials.json`),
 *   so the CLI always refreshes against the one live token file.
 * - `ensureClaudeAuth()` self-heals: provisions the dir, replaces a stale copy
 *   or clobbered (`expiresAt: 0`) regular file with the symlink, retargets a
 *   wrong link, and — the clobber guard — restores the SOURCE from the
 *   last-known-good backup when the source itself reads `expiresAt: 0`.
 * - The sidecar never mints or mutates live token material; the only write to
 *   the source is the guarded restore of an already-dead (`expiresAt: 0`) file
 *   from an unexpired backup. Refreshing tokens stays the CLI's job.
 * - Alternative auth: when `CLAUDE_CODE_OAUTH_TOKEN` is set (a long-lived
 *   token minted via `claude setup-token`), the CLI uses it over the
 *   credentials file (precedence #5 in the vendor docs) and this module does
 *   no file management.
 *
 * Every ensure emits a `claude_auth.ensure` log line so repairs are
 * assertable from the sidecar log (DISPATCH-CONTRACT Pillar 2); the SSE
 * `auth` / `auth_error` frames in builder.ts are the per-turn events.
 *
 * ## Sources (vendor docs, read 2026-08-01)
 * - https://code.claude.com/docs/en/authentication#credential-management
 *   (Linux storage at ~/.claude/.credentials.json, mode 0600; CLAUDE_CONFIG_DIR
 *   relocates the file)
 * - https://code.claude.com/docs/en/authentication#authentication-precedence
 *   (CLAUDE_CODE_OAUTH_TOKEN env outranks the subscription credentials file)
 * - https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
 *   (`claude setup-token` mints a one-year OAuth token; not saved anywhere)
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { config } from './config.ts';

/** Shape of the CLI's credentials file we read (never returned to callers). */
const credentialsFileSchema = z.object({
  claudeAiOauth: z.object({
    expiresAt: z.number(),
    subscriptionType: z.string().optional(),
  }),
});

export type ClaudeAuthMode = 'oauth-token-env' | 'credentials-file';

/** Secret-free view of the sidecar's Claude auth. */
export interface ClaudeAuthState {
  mode: ClaudeAuthMode;
  /** config-dir .credentials.json is a symlink to the canonical source. */
  linked: boolean;
  /** the canonical source file exists and parses. */
  sourceReadable: boolean;
  expired: boolean;
  expiresAt: number | null;
  subscriptionType: string | null;
}

export interface ClaudeAuthRepair {
  /** true when ensure changed machine state to recover auth (link/restore). */
  repaired: boolean;
  /** ordered audit trail of what ensure did (empty = nothing to do). */
  actions: string[];
  state: ClaudeAuthState;
}

/** Path overrides for tests; production callers pass nothing. */
export interface ClaudeAuthPaths {
  configDir?: string;
  credentialsSource?: string;
  /** Test override for CLAUDE_CODE_OAUTH_TOKEN presence. */
  oauthToken?: string;
}

const BACKUP_BASENAME = '.credentials.backup.json';

function pathsFrom(opts?: ClaudeAuthPaths): {
  configDir: string;
  source: string;
  credPath: string;
  backupPath: string;
  oauthToken: string | undefined;
} {
  const configDir = opts?.configDir ?? config.claudeConfigDir;
  const source = resolve(
    opts?.credentialsSource ?? config.claudeCredentialsSource
  );
  return {
    configDir,
    source,
    credPath: join(configDir, '.credentials.json'),
    backupPath: join(configDir, BACKUP_BASENAME),
    oauthToken: opts?.oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
}

function readCredentials(path: string): {
  readable: boolean;
  expiresAt: number | null;
  subscriptionType: string | null;
} {
  try {
    const parsed = credentialsFileSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8'))
    );
    if (!parsed.success) {
      return { readable: false, expiresAt: null, subscriptionType: null };
    }
    return {
      readable: true,
      expiresAt: parsed.data.claudeAiOauth.expiresAt,
      subscriptionType: parsed.data.claudeAiOauth.subscriptionType ?? null,
    };
  } catch {
    return { readable: false, expiresAt: null, subscriptionType: null };
  }
}

function linkTargetsSource(credPath: string, source: string): boolean {
  try {
    if (!lstatSync(credPath).isSymbolicLink()) return false;
    const target = readlinkSync(credPath);
    const absolute = isAbsolute(target)
      ? target
      : resolve(dirname(credPath), target);
    return resolve(absolute) === source;
  } catch {
    return false;
  }
}

/**
 * Secret-free auth observation: what the next spawned CLI will authenticate
 * with, and whether that credential is live. Never returns token material.
 */
export function readAuthState(opts?: ClaudeAuthPaths): ClaudeAuthState {
  const { source, credPath, oauthToken } = pathsFrom(opts);
  if (oauthToken !== undefined && oauthToken !== '') {
    // Long-lived setup-token in the environment outranks the file (vendor
    // precedence #5); expiry is opaque to us, so it is never "expired" here.
    return {
      mode: 'oauth-token-env',
      linked: false,
      sourceReadable: false,
      expired: false,
      expiresAt: null,
      subscriptionType: null,
    };
  }
  const creds = readCredentials(source);
  return {
    mode: 'credentials-file',
    linked: linkTargetsSource(credPath, source),
    sourceReadable: creds.readable,
    expired:
      !creds.readable ||
      creds.expiresAt === null ||
      creds.expiresAt <= Date.now(),
    expiresAt: creds.expiresAt,
    subscriptionType: creds.subscriptionType,
  };
}

/**
 * Self-heal the sidecar's Claude auth machine state. Idempotent; safe to call
 * before every turn. Throws only on filesystem errors (permission etc.) —
 * callers surface those as auth_error.
 */
export function ensureClaudeAuth(opts?: ClaudeAuthPaths): ClaudeAuthRepair {
  const { configDir, source, credPath, backupPath, oauthToken } =
    pathsFrom(opts);
  const actions: string[] = [];
  let repaired = false;

  if (oauthToken !== undefined && oauthToken !== '') {
    const state = readAuthState(opts);
    logEnsure(repaired, ['oauth-token-env'], state);
    return { repaired, actions: ['oauth-token-env'], state };
  }

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
    actions.push('created-config-dir');
  }

  // Clobber guard on the SOURCE: a sidecar-side failed refresh through the
  // symlink writes expiresAt:0 into the real file. Restore only that dead
  // state, and only from an unexpired last-known-good backup — the sidecar
  // never overwrites a live token.
  const sourceCreds = readCredentials(source);
  if (sourceCreds.readable && sourceCreds.expiresAt === 0) {
    const backupCreds = readCredentials(backupPath);
    if (
      backupCreds.readable &&
      backupCreds.expiresAt !== null &&
      backupCreds.expiresAt > Date.now()
    ) {
      const tmp = join(
        dirname(source),
        `.credentials.restore.${process.pid}.tmp`
      );
      copyFileSync(backupPath, tmp);
      renameSync(tmp, source);
      actions.push('restored-source-from-backup');
      repaired = true;
    }
  } else if (
    sourceCreds.readable &&
    sourceCreds.expiresAt !== null &&
    sourceCreds.expiresAt > Date.now()
  ) {
    // Capture last-known-good so a future clobber has something to restore.
    copyFileSync(source, backupPath);
    actions.push('refreshed-backup');
  }

  // Link management: the config-dir credentials entry must be a symlink to
  // the source. A regular file there is the historical copy failure mode.
  let entry: 'missing' | 'symlink' | 'file' = 'missing';
  try {
    entry = lstatSync(credPath).isSymbolicLink() ? 'symlink' : 'file';
  } catch {
    entry = 'missing';
  }
  if (entry === 'file') {
    const copyCreds = readCredentials(credPath);
    actions.push(
      copyCreds.readable && copyCreds.expiresAt === 0
        ? 'replaced-clobbered-copy-expiresAt-0'
        : 'replaced-stale-copy'
    );
    unlinkSync(credPath);
    symlinkSync(source, credPath);
    repaired = true;
  } else if (entry === 'symlink' && !linkTargetsSource(credPath, source)) {
    unlinkSync(credPath);
    symlinkSync(source, credPath);
    actions.push('relinked-credentials');
    repaired = true;
  } else if (entry === 'missing') {
    symlinkSync(source, credPath);
    actions.push('linked-credentials');
    repaired = true;
  }

  // Minimal onboarding marker so a fresh dir never triggers first-run setup.
  const onboarding = join(configDir, '.claude.json');
  if (!existsSync(onboarding)) {
    writeFileSync(onboarding, JSON.stringify({ hasCompletedOnboarding: true }));
    actions.push('wrote-onboarding-config');
  }

  const state = readAuthState(opts);
  logEnsure(repaired, actions, state);
  return { repaired, actions, state };
}

/** Pillar-2 log event: every ensure is assertable from the sidecar log. */
function logEnsure(
  repaired: boolean,
  actions: string[],
  state: ClaudeAuthState
): void {
  console.log(
    `[claude-auth] ${JSON.stringify({
      event: 'claude_auth.ensure',
      repaired,
      actions,
      mode: state.mode,
      linked: state.linked,
      expired: state.expired,
      expiresAt: state.expiresAt,
    })}`
  );
}
