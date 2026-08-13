/**
 * S7 — stateless AES-256-GCM sealed OAuth CSRF state (PLAN-DOCS/discovery/S7.md).
 *
 * The cross-process property under test: a state sealed by one OAuthService
 * instance must validate on a DIFFERENT instance (fresh construction = the
 * simulated other process; nothing instance-held survives), and every failure
 * mode (tamper, wrong shape, provider mismatch, expiry) dies with the exact
 * error strings the studio and the BACKLOG S7 accept clause key on. No live
 * provider: the ONLY outbound call on the happy path (the token exchange) is
 * stubbed.
 *
 * Run via `pnpm test` (never bare `bun test` — it retargets the live dev DB).
 */
// @ts-expect-error - Bun test types
import { describe, it, expect, afterEach } from 'bun:test';
import '../config/env.js';
import { env } from '../config/env.js';
import { CredentialType } from '@bubblelab/shared-schemas';
import { CredentialEncryption } from './encryption.js';
import {
  sealOAuthState,
  openOAuthState,
  oauthStateHash,
  oauthStateTtlMs,
  DEFAULT_OAUTH_STATE_TTL_MS,
  OAUTH_STATE_INVALID_ERROR,
  OAUTH_STATE_EXPIRED_ERROR,
  type OAuthStatePayload,
} from './oauth-state.js';
import { oauthService, OAuthService } from '../services/oauth-service.js';
import { TEST_USER_ID } from '../test/setup.js';

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';

function payload(
  overrides: Partial<OAuthStatePayload> = {}
): OAuthStatePayload {
  return {
    v: 1,
    userId: TEST_USER_ID,
    provider: 'google',
    credentialType: CredentialType.GOOGLE_DRIVE_CRED,
    credentialName: 's7 unit test',
    scopes: [DRIVE_FILE, 'openid', 'email'],
    redirectUri: 'http://localhost:3101/oauth/google/callback',
    iat: Date.now(),
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Stub ONLY the Google token exchange; everything else passes through. */
function stubTokenExchange(handler: () => Response): void {
  const stub = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes('oauth2.googleapis.com') && url.includes('/token')) {
      return handler();
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = stub as typeof globalThis.fetch;
}

describe('sealOAuthState / openOAuthState', () => {
  it('round-trips the full payload through seal → open', async () => {
    const original = payload({ credentialId: 42 });
    const state = await sealOAuthState(original);
    // base64url: inert in query strings / form bodies / sessionStorage.
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    const opened = await openOAuthState(state);
    expect(opened).toEqual(original);
  });

  it('two seals of the same payload differ (fresh salt/iv) but both open', async () => {
    const original = payload();
    const a = await sealOAuthState(original);
    const b = await sealOAuthState(original);
    expect(a).not.toBe(b);
    expect(await openOAuthState(a)).toEqual(original);
    expect(await openOAuthState(b)).toEqual(original);
  });

  it('rejects a tampered state (GCM auth tag) with the exact invalid-state error', async () => {
    const state = await sealOAuthState(payload());
    const mid = Math.floor(state.length / 2);
    const flipped =
      state.slice(0, mid) +
      (state[mid] === 'A' ? 'B' : 'A') +
      state.slice(mid + 1);
    await expect(openOAuthState(flipped)).rejects.toThrow(
      OAUTH_STATE_INVALID_ERROR
    );
  });

  it('rejects garbage that is not sealed data at all', async () => {
    await expect(openOAuthState('not-a-sealed-state')).rejects.toThrow(
      OAUTH_STATE_INVALID_ERROR
    );
  });

  it('rejects well-encrypted data whose JSON fails the payload schema', async () => {
    const sealedWrongShape = (
      await CredentialEncryption.encrypt(JSON.stringify({ v: 999, nope: true }))
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await expect(openOAuthState(sealedWrongShape)).rejects.toThrow(
      OAUTH_STATE_INVALID_ERROR
    );
  });

  it('stateHash is 12 hex chars and deterministic', async () => {
    const state = await sealOAuthState(payload());
    expect(oauthStateHash(state)).toMatch(/^[0-9a-f]{12}$/);
    expect(oauthStateHash(state)).toBe(oauthStateHash(state));
  });

  it('TTL defaults to 10 minutes when OAUTH_STATE_TTL_MS is unset', () => {
    if (env.OAUTH_STATE_TTL_MS === undefined) {
      expect(oauthStateTtlMs()).toBe(DEFAULT_OAUTH_STATE_TTL_MS);
    } else {
      expect(oauthStateTtlMs()).toBe(Number(env.OAUTH_STATE_TTL_MS));
    }
  });
});

describe('cross-instance callback validation (simulated other process)', () => {
  const googleConfigured = Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
  );

  (googleConfigured ? it : it.skip)(
    'a state issued by the singleton validates on a FRESH OAuthService and reaches the token exchange',
    async () => {
      const { authUrl, state } = await oauthService.initiateOAuth(
        'google',
        TEST_USER_ID,
        CredentialType.GOOGLE_DRIVE_CRED,
        's7 cross-instance'
      );
      expect(new URL(authUrl).searchParams.get('state')).toBe(state);

      stubTokenExchange(
        () =>
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
      );

      // Fresh instance = another process: its construction holds NO state map.
      const otherProcess = new OAuthService();
      let thrown: Error | null = null;
      try {
        await otherProcess.handleOAuthCallback('google', 'bogus-code', state);
      } catch (e) {
        thrown = e as Error;
      }
      // State validation must SUCCEED across instances — the only remaining
      // failure is the intentionally bogus authorization code at the exchange.
      expect(thrown).not.toBeNull();
      expect(thrown!.message).toMatch(/token exchange failed/i);
      expect(thrown!.message).not.toMatch(
        /Invalid or expired state|State parameter expired/
      );
    }
  );

  it('an expired state dies with the exact expired error on a fresh instance', async () => {
    const state = await sealOAuthState(
      payload({ iat: Date.now() - oauthStateTtlMs() - 1 })
    );
    const otherProcess = new OAuthService();
    await expect(
      otherProcess.handleOAuthCallback('google', 'bogus-code', state)
    ).rejects.toThrow(OAUTH_STATE_EXPIRED_ERROR);
  });

  it('a provider-mismatched state dies with the invalid-state error', async () => {
    const state = await sealOAuthState(payload({ provider: 'google' }));
    const otherProcess = new OAuthService();
    await expect(
      otherProcess.handleOAuthCallback('notion', 'bogus-code', state)
    ).rejects.toThrow(OAUTH_STATE_INVALID_ERROR);
  });
});
