/**
 * Suite-aware binding backend: POST /credentials/:id/scope-check and incremental
 * OAuth initiation.
 *
 * The scope check must reflect the scopes ACTUALLY granted on the credential's
 * token — a live Google tokeninfo probe when reachable (and the probed set is
 * synced into user_credentials.oauth_scopes so the build-time scope audit reads
 * verified grants), the recorded grants otherwise. Never a fake pass.
 *
 * Runs against the real Hono app and sqlite test DB; only the OUTBOUND
 * tokeninfo fetch is stubbed (Google is not reachable from a unit test).
 *
 * ## References
 * - tokeninfo response shape (`scope` space-delimited):
 *   https://docs.cloud.google.com/docs/authentication/token-types
 * - incremental authorization (`include_granted_scopes=true`):
 *   https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth
 */
// @ts-expect-error - Bun test types
import { describe, it, expect, afterEach } from 'bun:test';
import '../config/env.js';
import { TestApp } from '../test/test-app.js';
import { TEST_USER_ID } from '../test/setup.js';
import { db } from '../db/index.js';
import { userCredentials, users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { CredentialEncryption } from '../utils/encryption.js';
import { env } from '../config/env.js';
import { oauthService } from '../services/oauth-service.js';
import type { CredentialScopeCheckResponse } from '@bubblelab/shared-schemas';
import { CredentialType } from '@bubblelab/shared-schemas';

const SHEETS = 'https://www.googleapis.com/auth/spreadsheets';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';

const originalFetch = globalThis.fetch;

/** user_credentials.user_id has a FK to users — seed the foreign owner first. */
async function seedForeignUser(): Promise<string> {
  await db
    .insert(users)
    .values({
      clerkId: 'someone-else',
      firstName: 'Other',
      lastName: 'User',
      email: 'other@example.com',
      appType: 'nodex',
    })
    .onConflictDoNothing();
  return 'someone-else';
}

/** Stub ONLY the tokeninfo probe; everything else passes through. */
function stubTokeninfo(handler: () => Response): void {
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
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      return handler();
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = stub as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function seedGoogleOAuthCredential(options: {
  credentialType: string;
  storedScopes: string[];
  email?: string;
}): Promise<number> {
  const [row] = await db
    .insert(userCredentials)
    .values({
      userId: TEST_USER_ID,
      credentialType: options.credentialType,
      name: `${options.credentialType} suite test`,
      isOauth: true,
      oauthProvider: 'google',
      oauthScopes: options.storedScopes,
      oauthAccessToken: await CredentialEncryption.encrypt('fake-access-token'),
      // No refresh token: getValidToken returns the stored token untouched.
      metadata: options.email
        ? { email: options.email, displayName: options.email }
        : null,
    })
    .returning({ id: userCredentials.id });
  return row.id;
}

async function scopeCheck(
  credentialId: number,
  requirements: Array<{ scope: string; alternatives: string[] }>
): Promise<{ status: number; body: CredentialScopeCheckResponse }> {
  const response = await TestApp.post(
    `/credentials/${credentialId}/scope-check`,
    {
      requirements,
    }
  );
  return {
    status: response.status,
    body: (await response.json()) as CredentialScopeCheckResponse,
  };
}

describe('POST /credentials/:id/scope-check', () => {
  it('probe path: verifies against live granted scopes and syncs them to storage', async () => {
    // Stored scopes LIE (only drive.file recorded) but the token actually
    // carries spreadsheets too — the probe must win and be persisted.
    const credentialId = await seedGoogleOAuthCredential({
      credentialType: 'GOOGLE_DRIVE_CRED',
      storedScopes: [DRIVE_FILE],
    });
    stubTokeninfo(
      () =>
        new Response(
          JSON.stringify({
            scope: `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE_FILE} ${SHEETS}`,
            expires_in: 3599,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const { status, body } = await scopeCheck(credentialId, [
      { scope: SHEETS, alternatives: [SHEETS] },
    ]);

    expect(status).toBe(200);
    expect(body.satisfied).toBe(true);
    expect(body.source).toBe('probe');
    expect(body.missing).toEqual([]);
    expect(body.grantedScopes).toContain(SHEETS);

    // Probed grants synced into storage — the build-time scope audit now reads
    // verified grants for this credential.
    const row = await db.query.userCredentials.findFirst({
      where: eq(userCredentials.id, credentialId),
    });
    expect(row?.oauthScopes).toContain(SHEETS);
    expect(row?.oauthScopes).toContain(DRIVE_FILE);
  });

  it('insufficient: names exactly the requirements the grant does not cover', async () => {
    const credentialId = await seedGoogleOAuthCredential({
      credentialType: 'GOOGLE_DRIVE_CRED',
      storedScopes: [DRIVE_FILE],
    });
    stubTokeninfo(
      () =>
        new Response(JSON.stringify({ scope: DRIVE_FILE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const { status, body } = await scopeCheck(credentialId, [
      { scope: SHEETS, alternatives: [SHEETS] },
      { scope: DRIVE_FILE, alternatives: [DRIVE_FILE] },
      { scope: GMAIL_SEND, alternatives: [GMAIL_SEND] },
    ]);

    expect(status).toBe(200);
    expect(body.satisfied).toBe(false);
    expect(body.source).toBe('probe');
    expect(body.missing.map((entry) => entry.scope).sort()).toEqual(
      [GMAIL_SEND, SHEETS].sort()
    );
  });

  it('any-of alternatives: one granted alternative satisfies the requirement', async () => {
    const credentialId = await seedGoogleOAuthCredential({
      credentialType: 'GMAIL_CRED',
      storedScopes: [],
    });
    stubTokeninfo(
      () =>
        new Response(JSON.stringify({ scope: 'https://mail.google.com/' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const { body } = await scopeCheck(credentialId, [
      {
        scope: `${GMAIL_SEND}|https://mail.google.com`,
        alternatives: [GMAIL_SEND, 'https://mail.google.com'],
      },
    ]);
    // Trailing-slash tolerant, any-of satisfied by the broad mail scope.
    expect(body.satisfied).toBe(true);
  });

  it('stored fallback: probe failure degrades to recorded grants, never a fake probe', async () => {
    const credentialId = await seedGoogleOAuthCredential({
      credentialType: 'GOOGLE_DRIVE_CRED',
      storedScopes: [DRIVE_FILE, SHEETS],
    });
    stubTokeninfo(
      () => new Response('{"error":"invalid_token"}', { status: 400 })
    );

    const { body } = await scopeCheck(credentialId, [
      { scope: SHEETS, alternatives: [SHEETS] },
    ]);
    expect(body.source).toBe('stored');
    expect(body.satisfied).toBe(true);
    expect(body.grantedScopes).toEqual([DRIVE_FILE, SHEETS]);
  });

  it("404 for a non-OAuth credential and for another user's credential", async () => {
    const [apiKeyRow] = await db
      .insert(userCredentials)
      .values({
        userId: TEST_USER_ID,
        credentialType: 'OPENAI_CRED',
        name: 'api key',
        encryptedValue: await CredentialEncryption.encrypt('sk-fake'),
      })
      .returning({ id: userCredentials.id });
    const own = await TestApp.post(`/credentials/${apiKeyRow.id}/scope-check`, {
      requirements: [],
    });
    expect(own.status).toBe(404);

    const foreignUserId = await seedForeignUser();
    const [foreignRow] = await db
      .insert(userCredentials)
      .values({
        userId: foreignUserId,
        credentialType: 'GOOGLE_DRIVE_CRED',
        name: 'not yours',
        isOauth: true,
        oauthProvider: 'google',
        oauthScopes: [DRIVE_FILE],
      })
      .returning({ id: userCredentials.id });
    const foreign = await TestApp.post(
      `/credentials/${foreignRow.id}/scope-check`,
      { requirements: [] }
    );
    expect(foreign.status).toBe(404);
  });
});

const googleConfigured = Boolean(
  env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
);

describe('incremental OAuth initiation (existing credential)', () => {
  (googleConfigured ? it : it.skip)(
    'authorization URL carries include_granted_scopes=true, login_hint, and the missing scopes',
    async () => {
      const credentialId = await seedGoogleOAuthCredential({
        credentialType: 'GOOGLE_DRIVE_CRED',
        storedScopes: [DRIVE_FILE],
        email: 'owner@example.com',
      });

      const { authUrl } = await oauthService.initiateOAuth(
        'google',
        TEST_USER_ID,
        CredentialType.GOOGLE_DRIVE_CRED,
        undefined,
        [SHEETS],
        credentialId
      );

      const url = new URL(authUrl);
      expect(url.origin + url.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth'
      );
      expect(url.searchParams.get('include_granted_scopes')).toBe('true');
      expect(url.searchParams.get('login_hint')).toBe('owner@example.com');
      const scope = url.searchParams.get('scope') ?? '';
      expect(scope).toContain(SHEETS);
      // OIDC identity scopes always ride along for google.
      expect(scope).toContain('openid');
      expect(scope).toContain('email');
    }
  );

  (googleConfigured ? it : it.skip)(
    'rejects an incremental initiate against a credential the user does not own',
    async () => {
      const foreignUserId = await seedForeignUser();
      const [foreignRow] = await db
        .insert(userCredentials)
        .values({
          userId: foreignUserId,
          credentialType: 'GOOGLE_DRIVE_CRED',
          name: 'not yours',
          isOauth: true,
          oauthProvider: 'google',
          oauthScopes: [DRIVE_FILE],
        })
        .returning({ id: userCredentials.id });

      await expect(
        oauthService.initiateOAuth(
          'google',
          TEST_USER_ID,
          CredentialType.GOOGLE_DRIVE_CRED,
          undefined,
          [SHEETS],
          foreignRow.id
        )
      ).rejects.toThrow(/not an OAuth credential/);
    }
  );
});
