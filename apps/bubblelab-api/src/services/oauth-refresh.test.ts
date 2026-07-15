/**
 * IR-5 acceptance tests: refresh-on-expiry + single-flight lock.
 *
 * The refresh counter is a real local HTTP token endpoint's own hit count.
 * Nothing under test is mocked: OAuthService runs against the test database
 * and a real @badgateway/oauth2-client pointed at the local endpoint.
 *
 * Acceptance criteria:
 * - a valid token resolves with ZERO refresh calls
 * - 10 concurrent resolutions of an expired token trigger EXACTLY ONE refresh
 * - a rotated refresh_token is persisted and presented on the next refresh
 * - a provider that omits refresh_token on refresh (Google-style) keeps the
 *   prior one
 */
// @ts-expect-error - Bun test types
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuth2Client } from '@badgateway/oauth2-client';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userCredentials } from '../db/schema.js';
import { CredentialEncryption } from '../utils/encryption.js';
import { oauthService, OAUTH_REFRESH_BUFFER_MS } from './oauth-service.js';
import { TEST_USER_ID } from '../test/setup.js';

interface FakeTokenEndpoint {
  url: string;
  calls: () => number;
  receivedRefreshTokens: () => string[];
  close: () => Promise<void>;
}

/**
 * RFC 6749 §6 refresh endpoint. `rotate: true` issues a new refresh_token on
 * every call (rotation); `rotate: false` mirrors Google, whose refresh
 * responses omit refresh_token so the prior one stays valid.
 */
async function startTokenEndpoint(rotate: boolean): Promise<FakeTokenEndpoint> {
  let calls = 0;
  const received: string[] = [];

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (
        req.method !== 'POST' ||
        params.get('grant_type') !== 'refresh_token'
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }
      calls += 1;
      received.push(params.get('refresh_token') ?? '');
      const payload: Record<string, unknown> = {
        access_token: `access-${calls}`,
        token_type: 'bearer',
        expires_in: 3600,
      };
      if (rotate) {
        payload.refresh_token = `refresh-${calls}`;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    receivedRefreshTokens: () => [...received],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Register a provider whose token endpoint is the local fake server. */
function registerFakeProvider(name: string, endpointUrl: string): void {
  oauthService.registerClient(
    name,
    new OAuth2Client({
      server: endpointUrl,
      clientId: 'client-1',
      clientSecret: 'secret-1',
      authorizationEndpoint: '/authorize',
      tokenEndpoint: '/token',
    })
  );
}

interface CredentialSeed {
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}

/** Insert an OAuth credential row exactly as the callback handler stores it. */
async function insertOAuthCredential(seed: CredentialSeed): Promise<number> {
  const [row] = await db
    .insert(userCredentials)
    .values({
      userId: TEST_USER_ID,
      credentialType: 'GMAIL_CRED',
      name: 'IR-5 test credential',
      isOauth: true,
      oauthAccessToken: await CredentialEncryption.encrypt(seed.accessToken),
      oauthRefreshToken: seed.refreshToken
        ? await CredentialEncryption.encrypt(seed.refreshToken)
        : null,
      oauthExpiresAt: seed.expiresAt,
      oauthScopes: ['test.scope'],
      oauthTokenType: 'Bearer',
      oauthProvider: seed.provider,
    })
    .returning({ id: userCredentials.id });
  return row.id;
}

async function readCredentialRow(credentialId: number) {
  const row = await db.query.userCredentials.findFirst({
    where: eq(userCredentials.id, credentialId),
  });
  if (!row) {
    throw new Error(`credential ${credentialId} vanished`);
  }
  return {
    accessToken: row.oauthAccessToken
      ? await CredentialEncryption.decrypt(row.oauthAccessToken)
      : null,
    refreshToken: row.oauthRefreshToken
      ? await CredentialEncryption.decrypt(row.oauthRefreshToken)
      : null,
    expiresAt: row.oauthExpiresAt,
  };
}

const endpoints: FakeTokenEndpoint[] = [];

async function trackedEndpoint(rotate: boolean): Promise<FakeTokenEndpoint> {
  const endpoint = await startTokenEndpoint(rotate);
  endpoints.push(endpoint);
  return endpoint;
}

beforeAll(() => {
  if (!process.env.CREDENTIAL_ENCRYPTION_KEY) {
    process.env.CREDENTIAL_ENCRYPTION_KEY =
      'test-encryption-key-that-is-32-chars-long-for-testing';
  }
});

afterAll(async () => {
  await Promise.all(endpoints.map((e) => e.close()));
});

describe('IR-5 refresh-on-expiry + single-flight lock', () => {
  it('a valid token resolves with zero refresh calls', async () => {
    const endpoint = await trackedEndpoint(true);
    registerFakeProvider('fake-valid', endpoint.url);
    const credentialId = await insertOAuthCredential({
      provider: 'fake-valid',
      accessToken: 'access-initial',
      refreshToken: 'refresh-0',
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const first = await oauthService.getValidToken(credentialId);
    const second = await oauthService.getValidToken(credentialId);

    expect(first).toBe('access-initial');
    expect(second).toBe('access-initial');
    expect(endpoint.calls()).toBe(0);
  });

  it('a token inside the expiry buffer refreshes, not only after hard expiry', async () => {
    const endpoint = await trackedEndpoint(true);
    registerFakeProvider('fake-buffer', endpoint.url);
    const credentialId = await insertOAuthCredential({
      provider: 'fake-buffer',
      accessToken: 'access-initial',
      refreshToken: 'refresh-0',
      // Still valid, but inside the buffer window
      expiresAt: new Date(Date.now() + OAUTH_REFRESH_BUFFER_MS / 2),
    });

    const token = await oauthService.getValidToken(credentialId);

    expect(token).toBe('access-1');
    expect(endpoint.calls()).toBe(1);
  });

  it('10 concurrent resolutions of an expired token trigger exactly one refresh; the rotated refresh token persists and is used next time', async () => {
    const endpoint = await trackedEndpoint(true);
    registerFakeProvider('fake-concurrent', endpoint.url);
    const credentialId = await insertOAuthCredential({
      provider: 'fake-concurrent',
      accessToken: 'access-stale',
      refreshToken: 'refresh-0',
      expiresAt: new Date(Date.now() - 1000),
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => oauthService.getValidToken(credentialId))
    );

    // Single-flight: one provider call for ten resolvers
    expect(endpoint.calls()).toBe(1);
    for (const token of results) {
      expect(token).toBe('access-1');
    }

    // Rotation persisted: the row now holds the rotated pair
    const stored = await readCredentialRow(credentialId);
    expect(stored.accessToken).toBe('access-1');
    expect(stored.refreshToken).toBe('refresh-1');

    // A later resolution reuses the fresh token without another refresh
    const later = await oauthService.getValidToken(credentialId);
    expect(later).toBe('access-1');
    expect(endpoint.calls()).toBe(1);

    // Force a second expiry: the next refresh must present the ROTATED token
    await db
      .update(userCredentials)
      .set({ oauthExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(userCredentials.id, credentialId));

    const afterRotation = await oauthService.getValidToken(credentialId);
    expect(afterRotation).toBe('access-2');
    expect(endpoint.receivedRefreshTokens()).toEqual([
      'refresh-0',
      'refresh-1',
    ]);
    expect(endpoint.calls()).toBe(2);
  });

  it('keeps the prior refresh token when the provider omits rotation (Google-style refresh response)', async () => {
    const endpoint = await trackedEndpoint(false);
    registerFakeProvider('fake-google', endpoint.url);
    const credentialId = await insertOAuthCredential({
      provider: 'fake-google',
      accessToken: 'access-stale',
      refreshToken: 'refresh-original',
      expiresAt: new Date(Date.now() - 1000),
    });

    const token = await oauthService.getValidToken(credentialId);
    expect(token).toBe('access-1');
    expect(endpoint.calls()).toBe(1);

    const stored = await readCredentialRow(credentialId);
    expect(stored.accessToken).toBe('access-1');
    expect(stored.refreshToken).toBe('refresh-original');

    // The kept token is presented on the next refresh
    await db
      .update(userCredentials)
      .set({ oauthExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(userCredentials.id, credentialId));
    await oauthService.getValidToken(credentialId);
    expect(endpoint.receivedRefreshTokens()).toEqual([
      'refresh-original',
      'refresh-original',
    ]);
  });

  it('an expired token without a refresh token falls back to the stored token and makes zero provider calls', async () => {
    const endpoint = await trackedEndpoint(true);
    registerFakeProvider('fake-norefresh', endpoint.url);
    const credentialId = await insertOAuthCredential({
      provider: 'fake-norefresh',
      accessToken: 'access-stale',
      refreshToken: null,
      expiresAt: new Date(Date.now() - 1000),
    });

    const token = await oauthService.getValidToken(credentialId);
    expect(token).toBe('access-stale');
    expect(endpoint.calls()).toBe(0);
  });

  it('explicit refreshToken() (the POST /oauth/:provider/refresh path) still refreshes a non-expiring token unconditionally', async () => {
    const endpoint = await trackedEndpoint(true);
    registerFakeProvider('fake-force', endpoint.url);
    const credentialId = await insertOAuthCredential({
      provider: 'fake-force',
      accessToken: 'access-initial',
      refreshToken: 'refresh-0',
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const token = await oauthService.refreshToken(credentialId);
    expect(token).toBe('access-1');
    expect(endpoint.calls()).toBe(1);
  });

  it('a failed refresh falls back to the stored access token', async () => {
    // No provider registered for this name: the refresh throws, and
    // getValidToken falls back to the stored (stale) token.
    const credentialId = await insertOAuthCredential({
      provider: 'fake-unregistered',
      accessToken: 'access-stale',
      refreshToken: 'refresh-0',
      expiresAt: new Date(Date.now() - 1000),
    });

    const token = await oauthService.getValidToken(credentialId);
    expect(token).toBe('access-stale');
  });
});
