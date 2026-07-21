/**
 * Derived-credential persistence: the hierarchical record materializing
 * "credential X's granted scopes also serve sibling type Y".
 *
 * Verifies:
 * - sync derives records from stored granted scopes (covered siblings only),
 * - sync keeps records in LOCKSTEP with the grant (a removed scope drops its
 *   record; a probe-synced scope shrink via POST /credentials/:id/scope-check
 *   drops it too),
 * - GET /credentials lazily backfills and returns the stored records
 *   (`derivedCredentials` on the parent row) — the studio's read path,
 * - deleting the parent credential cascades the records away.
 *
 * Runs against the real Hono app and sqlite test DB; only OUTBOUND Google
 * fetches (tokeninfo probe, OIDC userinfo backfill) are stubbed.
 */
// @ts-expect-error - Bun test types
import { describe, it, expect, afterEach } from 'bun:test';
import '../config/env.js';
import { TestApp } from '../test/test-app.js';
import { TEST_USER_ID } from '../test/setup.js';
import { db } from '../db/index.js';
import { userCredentials, derivedCredentials } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { CredentialEncryption } from '../utils/encryption.js';
import {
  syncDerivedCredentialsById,
  computeDesiredDerivedTypes,
} from './derived-credential-service.js';
import type { CredentialResponse } from '@bubblelab/shared-schemas';
import { CredentialType } from '@bubblelab/shared-schemas';

const SHEETS = 'https://www.googleapis.com/auth/spreadsheets';
const CALENDAR = 'https://www.googleapis.com/auth/calendar';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';

const originalFetch = globalThis.fetch;

/** Stub ALL outbound Google endpoints (tokeninfo + userinfo); rest passes through. */
function stubGoogle(handlers: {
  tokeninfo?: () => Response;
  userinfo?: () => Response;
}): void {
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
      return (
        handlers.tokeninfo?.() ?? new Response('unavailable', { status: 503 })
      );
    }
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
      return (
        handlers.userinfo?.() ?? new Response('unauthorized', { status: 401 })
      );
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = stub as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function seedGoogleCredential(options: {
  credentialType: string;
  storedScopes: string[];
}): Promise<number> {
  const [row] = await db
    .insert(userCredentials)
    .values({
      userId: TEST_USER_ID,
      credentialType: options.credentialType,
      name: `${options.credentialType} derived test`,
      isOauth: true,
      oauthProvider: 'google',
      oauthScopes: options.storedScopes,
      oauthAccessToken: await CredentialEncryption.encrypt('fake-access-token'),
      // No refresh token: getValidToken returns the stored token untouched.
      metadata: null,
    })
    .returning({ id: userCredentials.id });
  return row.id;
}

async function derivedRowsFor(parentId: number) {
  return db.query.derivedCredentials.findMany({
    where: eq(derivedCredentials.parentCredentialId, parentId),
  });
}

describe('computeDesiredDerivedTypes', () => {
  it('covers only siblings whose full default scope set is granted', () => {
    const desired = computeDesiredDerivedTypes({
      id: 1,
      userId: TEST_USER_ID,
      credentialType: 'GOOGLE_DRIVE_CRED',
      isOauth: true,
      oauthProvider: 'google',
      oauthScopes: [DRIVE_FILE, SHEETS, CALENDAR],
    });
    expect(desired.sort()).toEqual(
      [
        CredentialType.GOOGLE_SHEETS_CRED,
        CredentialType.GOOGLE_CALENDAR_CRED,
      ].sort()
    );
  });

  it('derives nothing for non-OAuth rows and single-type provider groups', () => {
    expect(
      computeDesiredDerivedTypes({
        id: 1,
        userId: TEST_USER_ID,
        credentialType: 'GOOGLE_DRIVE_CRED',
        isOauth: false,
        oauthProvider: null,
        oauthScopes: [SHEETS],
      })
    ).toEqual([]);
    expect(
      computeDesiredDerivedTypes({
        id: 1,
        userId: TEST_USER_ID,
        credentialType: 'SLACK_CRED',
        isOauth: true,
        oauthProvider: 'slack',
        oauthScopes: ['chat:write'],
      })
    ).toEqual([]);
  });
});

describe('syncDerivedCredentialsById', () => {
  it('materializes one record per covered sibling type, provider + isDerived set', async () => {
    const parentId = await seedGoogleCredential({
      credentialType: 'GOOGLE_DRIVE_CRED',
      storedScopes: [DRIVE_FILE, SHEETS, CALENDAR],
    });

    const records = await syncDerivedCredentialsById(parentId);
    expect(
      records.map((record) => record.derivedCredentialType).sort()
    ).toEqual(
      [
        CredentialType.GOOGLE_CALENDAR_CRED,
        CredentialType.GOOGLE_SHEETS_CRED,
      ].sort()
    );
    for (const record of records) {
      expect(record.parentCredentialId).toBe(parentId);
      expect(record.provider).toBe('google');
      expect(record.isDerived).toBe(true);
    }

    const rows = await derivedRowsFor(parentId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.userId === TEST_USER_ID)).toBe(true);
  });

  it('is idempotent: a second sync neither duplicates nor rewrites rows', async () => {
    const parentId = await seedGoogleCredential({
      credentialType: 'GOOGLE_DRIVE_CRED',
      storedScopes: [SHEETS],
    });
    const first = await syncDerivedCredentialsById(parentId);
    const second = await syncDerivedCredentialsById(parentId);
    expect(second).toEqual(first);
    expect(await derivedRowsFor(parentId)).toHaveLength(1);
  });

  it('lockstep: a scope removed from the grant drops its derived record', async () => {
    const parentId = await seedGoogleCredential({
      credentialType: 'GOOGLE_DRIVE_CRED',
      storedScopes: [SHEETS, CALENDAR],
    });
    await syncDerivedCredentialsById(parentId);
    expect(await derivedRowsFor(parentId)).toHaveLength(2);

    // The grant shrinks (e.g. the user revoked calendar access).
    await db
      .update(userCredentials)
      .set({ oauthScopes: [SHEETS] })
      .where(eq(userCredentials.id, parentId));
    const records = await syncDerivedCredentialsById(parentId);

    expect(records.map((record) => record.derivedCredentialType)).toEqual([
      CredentialType.GOOGLE_SHEETS_CRED,
    ]);
    expect(await derivedRowsFor(parentId)).toHaveLength(1);
  });

  it('returns [] for a missing credential id', async () => {
    expect(await syncDerivedCredentialsById(999999)).toEqual([]);
  });
});

describe('GET /credentials — stored coverage read path', () => {
  it('lazily backfills and returns derivedCredentials on the parent row', async () => {
    const parentId = await seedGoogleCredential({
      credentialType: 'GOOGLE_DRIVE_CRED',
      storedScopes: [DRIVE_FILE, SHEETS],
    });
    // No records exist yet (credential predates the table) — the list call
    // must create and return them. Email backfill probe is stubbed to fail
    // (credential without identity scopes).
    stubGoogle({});

    const response = await TestApp.get('/credentials');
    expect(response.status).toBe(200);
    const body = (await response.json()) as CredentialResponse[];
    const parent = body.find((cred) => cred.id === parentId);
    expect(parent?.derivedCredentials).toHaveLength(1);
    expect(parent?.derivedCredentials?.[0]).toMatchObject({
      parentCredentialId: parentId,
      derivedCredentialType: CredentialType.GOOGLE_SHEETS_CRED,
      provider: 'google',
      isDerived: true,
    });

    // And the records are persisted, not synthesized per response.
    expect(await derivedRowsFor(parentId)).toHaveLength(1);
  });

  it('omits derivedCredentials for credentials covering nothing', async () => {
    const parentId = await seedGoogleCredential({
      credentialType: 'GOOGLE_DRIVE_CRED',
      storedScopes: [DRIVE_FILE],
    });
    stubGoogle({});

    const response = await TestApp.get('/credentials');
    const body = (await response.json()) as CredentialResponse[];
    const parent = body.find((cred) => cred.id === parentId);
    expect(parent?.derivedCredentials).toBeUndefined();
  });
});

describe('scope-check probe keeps the records in lockstep', () => {
  it('a probe revealing a shrunken grant drops the stale derived record', async () => {
    const parentId = await seedGoogleCredential({
      credentialType: 'GOOGLE_DRIVE_CRED',
      storedScopes: [SHEETS],
    });
    await syncDerivedCredentialsById(parentId);
    expect(await derivedRowsFor(parentId)).toHaveLength(1);

    // Live probe says the token no longer carries the spreadsheets scope.
    stubGoogle({
      tokeninfo: () =>
        new Response(JSON.stringify({ scope: DRIVE_FILE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    const response = await TestApp.post(
      `/credentials/${parentId}/scope-check`,
      { requirements: [{ scope: SHEETS, alternatives: [SHEETS] }] }
    );
    expect(response.status).toBe(200);

    expect(await derivedRowsFor(parentId)).toHaveLength(0);
  });

  it('a probe revealing a grown grant adds the new derived record', async () => {
    const parentId = await seedGoogleCredential({
      credentialType: 'GOOGLE_DRIVE_CRED',
      storedScopes: [DRIVE_FILE],
    });
    await syncDerivedCredentialsById(parentId);
    expect(await derivedRowsFor(parentId)).toHaveLength(0);

    stubGoogle({
      tokeninfo: () =>
        new Response(JSON.stringify({ scope: `${DRIVE_FILE} ${SHEETS}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    const response = await TestApp.post(
      `/credentials/${parentId}/scope-check`,
      { requirements: [{ scope: SHEETS, alternatives: [SHEETS] }] }
    );
    expect(response.status).toBe(200);

    const rows = await derivedRowsFor(parentId);
    expect(rows.map((row) => row.derivedCredentialType)).toEqual([
      CredentialType.GOOGLE_SHEETS_CRED,
    ]);
  });
});

describe('parent deletion', () => {
  it('cascades the derived records away with the parent credential', async () => {
    const parentId = await seedGoogleCredential({
      credentialType: 'GOOGLE_DRIVE_CRED',
      storedScopes: [SHEETS],
    });
    await syncDerivedCredentialsById(parentId);
    expect(await derivedRowsFor(parentId)).toHaveLength(1);

    const response = await TestApp.delete(`/credentials/${parentId}`);
    expect(response.status).toBe(200);

    expect(await derivedRowsFor(parentId)).toHaveLength(0);
  });
});
