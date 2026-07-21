/**
 * Lazy Google account-email backfill on GET /credentials.
 *
 * Google OAuth credentials connected BEFORE the callback started recording the
 * account identity have metadata = null, so the studio's account dropdowns and
 * setup-field auto-population (gmailAccountEmail) had nothing to fill from.
 * The list route now probes the OIDC UserInfo endpoint once per such
 * credential, persists the email, and serves it — failures degrade to the bare
 * row and are not retried within the process.
 *
 * Runs against the real Hono app and sqlite test DB; only the OUTBOUND
 * userinfo fetch is stubbed (Google is not reachable from a unit test).
 *
 * ## References
 * - UserInfo endpoint (bearer GET https://openidconnect.googleapis.com/v1/userinfo;
 *   response carries `email` when the email scope was granted):
 *   https://developers.google.com/identity/openid-connect/openid-connect
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
import type { CredentialResponse } from '@bubblelab/shared-schemas';

const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const originalFetch = globalThis.fetch;

/** Stub ONLY the userinfo probe; everything else passes through. Returns a call counter. */
function stubUserinfo(handler: () => Response): { calls: () => number } {
  let count = 0;
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
    if (url.startsWith(USERINFO_URL)) {
      count += 1;
      return handler();
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = stub as typeof fetch;
  return { calls: () => count };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A pre-identity-write credential: google OAuth row with metadata = null. */
async function seedLegacyGoogleCredential(
  credentialType: string
): Promise<number> {
  const [row] = await db
    .insert(userCredentials)
    .values({
      userId: TEST_USER_ID,
      credentialType,
      name: `${credentialType} legacy`,
      isOauth: true,
      oauthProvider: 'google',
      oauthScopes: ['https://www.googleapis.com/auth/gmail.send'],
      oauthAccessToken: await CredentialEncryption.encrypt('fake-access-token'),
      // No refresh token: getValidToken returns the stored token without any network.
      metadata: null,
    })
    .returning({ id: userCredentials.id });
  return row.id;
}

async function listCredentials(): Promise<CredentialResponse[]> {
  const response = await TestApp.get('/credentials');
  expect(response.status).toBe(200);
  return (await response.json()) as CredentialResponse[];
}

function metadataEmail(cred: CredentialResponse | undefined): unknown {
  return (cred?.metadata as { email?: string } | undefined)?.email;
}

describe('GET /credentials — Google account-email backfill', () => {
  it('probes userinfo once for a metadata-less google credential, persists and serves the email', async () => {
    const credentialId = await seedLegacyGoogleCredential('GMAIL_CRED');
    const stub = stubUserinfo(
      () =>
        new Response(
          JSON.stringify({
            sub: '1234567890',
            email: 'legacy-user@example.com',
            email_verified: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const credentials = await listCredentials();
    const served = credentials.find((cred) => cred.id === credentialId);
    expect(metadataEmail(served)).toBe('legacy-user@example.com');

    // Persisted: the row itself now carries the identity.
    const row = await db.query.userCredentials.findFirst({
      where: eq(userCredentials.id, credentialId),
    });
    expect((row?.metadata as { email?: string } | null)?.email).toBe(
      'legacy-user@example.com'
    );

    // Cached: a second list serves the persisted email without another probe.
    const second = await listCredentials();
    expect(metadataEmail(second.find((cred) => cred.id === credentialId))).toBe(
      'legacy-user@example.com'
    );
    expect(stub.calls()).toBe(1);
  });

  it('degrades gracefully on probe failure and does not re-probe within the process', async () => {
    const credentialId = await seedLegacyGoogleCredential('GOOGLE_DRIVE_CRED');
    const stub = stubUserinfo(
      () => new Response('{"error":"invalid_token"}', { status: 401 })
    );

    const credentials = await listCredentials();
    const served = credentials.find((cred) => cred.id === credentialId);
    // Listing succeeds; no email was fabricated.
    expect(metadataEmail(served)).toBeUndefined();
    const row = await db.query.userCredentials.findFirst({
      where: eq(userCredentials.id, credentialId),
    });
    expect(row?.metadata).toBeNull();
    expect(stub.calls()).toBe(1);

    // The failed attempt is remembered — the next list does not probe again.
    await listCredentials();
    expect(stub.calls()).toBe(1);
  });

  it('leaves non-google and already-identified credentials unprobed', async () => {
    const [identified] = await db
      .insert(userCredentials)
      .values({
        userId: TEST_USER_ID,
        credentialType: 'GOOGLE_SHEETS_CRED',
        name: 'already identified',
        isOauth: true,
        oauthProvider: 'google',
        oauthAccessToken: await CredentialEncryption.encrypt('fake-token'),
        metadata: { email: 'known@example.com', displayName: 'known@example.com' },
      })
      .returning({ id: userCredentials.id });
    const [apiKey] = await db
      .insert(userCredentials)
      .values({
        userId: TEST_USER_ID,
        credentialType: 'OPENAI_CRED',
        name: 'api key',
        encryptedValue: await CredentialEncryption.encrypt('sk-fake'),
      })
      .returning({ id: userCredentials.id });
    const stub = stubUserinfo(
      () => new Response('{}', { status: 200 })
    );

    const credentials = await listCredentials();
    expect(stub.calls()).toBe(0);
    expect(
      metadataEmail(credentials.find((cred) => cred.id === identified.id))
    ).toBe('known@example.com');
    expect(credentials.find((cred) => cred.id === apiKey.id)).toBeDefined();
  });
});
