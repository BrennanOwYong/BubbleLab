/**
 * DELETE /credentials/:id must revoke the OAuth grant at the provider before
 * dropping the row — deleting the row alone leaves a live token on Google's
 * side. Revocation is best effort: an already-invalid token (Google answers
 * 400) or an unreachable provider never blocks the delete.
 *
 * Runs against the real Hono app and sqlite test DB; only the OUTBOUND revoke
 * fetch is stubbed (Google is not reachable from a unit test).
 *
 * ## References
 * - Google revocation (POST https://oauth2.googleapis.com/revoke,
 *   `Content-Type: application/x-www-form-urlencoded`, body `token=...`;
 *   200 on success, 400 for an already-invalid token):
 *   https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
 */
// @ts-expect-error - Bun test types
import { describe, it, expect, afterEach } from 'bun:test';
import '../config/env.js';
import { TestApp } from '../test/test-app.js';
import { TEST_USER_ID } from '../test/setup.js';
import { db } from '../db/index.js';
import { userCredentials } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { CredentialEncryption } from '../utils/encryption.js';

const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedRevokeCall {
  url: string;
  method: string;
  contentType: string | null;
  body: string;
}

/** Stub ONLY the Google revoke endpoint, capturing each call; everything else
 * passes through. */
function stubGoogleRevoke(
  captured: CapturedRevokeCall[],
  respond: () => Response
): void {
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
    if (url.startsWith(GOOGLE_REVOKE_URL)) {
      const request = new Request(input, init);
      captured.push({
        url,
        method: request.method,
        contentType: request.headers.get('Content-Type'),
        body: await request.text(),
      });
      return respond();
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = stub as typeof fetch;
}

async function seedGoogleOAuthCredential(options: {
  accessToken: string;
  refreshToken?: string;
}): Promise<number> {
  const [row] = await db
    .insert(userCredentials)
    .values({
      userId: TEST_USER_ID,
      credentialType: 'GOOGLE_DRIVE_CRED',
      name: 'delete-revoke test',
      isOauth: true,
      oauthProvider: 'google',
      oauthScopes: ['https://www.googleapis.com/auth/drive.file'],
      oauthAccessToken: await CredentialEncryption.encrypt(options.accessToken),
      oauthRefreshToken: options.refreshToken
        ? await CredentialEncryption.encrypt(options.refreshToken)
        : undefined,
    })
    .returning({ id: userCredentials.id });
  return row.id;
}

async function rowExists(credentialId: number): Promise<boolean> {
  const row = await db.query.userCredentials.findFirst({
    where: eq(userCredentials.id, credentialId),
  });
  return Boolean(row);
}

describe('DELETE /credentials/:id — OAuth revocation', () => {
  it('POSTs the refresh token to the Google revoke endpoint, then deletes the row', async () => {
    const credentialId = await seedGoogleOAuthCredential({
      accessToken: 'plain-access-token',
      refreshToken: 'plain-refresh-token',
    });
    const captured: CapturedRevokeCall[] = [];
    stubGoogleRevoke(captured, () => new Response('{}', { status: 200 }));

    const response = await TestApp.delete(`/credentials/${credentialId}`);

    expect(response.status).toBe(200);
    expect(captured.length).toBe(1);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].contentType).toContain(
      'application/x-www-form-urlencoded'
    );
    // The refresh token (revoking it invalidates the whole grant), decrypted.
    expect(captured[0].body).toBe(
      new URLSearchParams({ token: 'plain-refresh-token' }).toString()
    );
    expect(await rowExists(credentialId)).toBe(false);
  });

  it('falls back to the access token when no refresh token is stored', async () => {
    const credentialId = await seedGoogleOAuthCredential({
      accessToken: 'plain-access-token',
    });
    const captured: CapturedRevokeCall[] = [];
    stubGoogleRevoke(captured, () => new Response('{}', { status: 200 }));

    const response = await TestApp.delete(`/credentials/${credentialId}`);

    expect(response.status).toBe(200);
    expect(captured.length).toBe(1);
    expect(captured[0].body).toBe(
      new URLSearchParams({ token: 'plain-access-token' }).toString()
    );
    expect(await rowExists(credentialId)).toBe(false);
  });

  it('still deletes the row when Google answers 400 (token already invalid)', async () => {
    const credentialId = await seedGoogleOAuthCredential({
      accessToken: 'plain-access-token',
      refreshToken: 'already-revoked-token',
    });
    const captured: CapturedRevokeCall[] = [];
    stubGoogleRevoke(
      captured,
      () => new Response('{"error":"invalid_token"}', { status: 400 })
    );

    const response = await TestApp.delete(`/credentials/${credentialId}`);

    expect(response.status).toBe(200);
    expect(captured.length).toBe(1);
    expect(await rowExists(credentialId)).toBe(false);
  });

  it('still deletes the row when the revoke request itself fails (provider unreachable)', async () => {
    const credentialId = await seedGoogleOAuthCredential({
      accessToken: 'plain-access-token',
      refreshToken: 'plain-refresh-token',
    });
    const captured: CapturedRevokeCall[] = [];
    stubGoogleRevoke(captured, () => {
      throw new Error('network down');
    });

    const response = await TestApp.delete(`/credentials/${credentialId}`);

    expect(response.status).toBe(200);
    expect(captured.length).toBe(1);
    expect(await rowExists(credentialId)).toBe(false);
  });

  it('makes no revoke call for a non-OAuth credential', async () => {
    const [row] = await db
      .insert(userCredentials)
      .values({
        userId: TEST_USER_ID,
        credentialType: 'OPENAI_CRED',
        name: 'api key',
        encryptedValue: await CredentialEncryption.encrypt('sk-fake'),
      })
      .returning({ id: userCredentials.id });
    const captured: CapturedRevokeCall[] = [];
    stubGoogleRevoke(captured, () => new Response('{}', { status: 200 }));

    const response = await TestApp.delete(`/credentials/${row.id}`);

    expect(response.status).toBe(200);
    expect(captured.length).toBe(0);
    expect(await rowExists(row.id)).toBe(false);
  });
});
