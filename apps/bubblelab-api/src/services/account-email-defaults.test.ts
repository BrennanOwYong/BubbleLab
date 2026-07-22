/**
 * Account-email defaults (account-email-defaults.ts): the gmailAccountEmail
 * 0/1/many rule, server-side. Per required credential type, a default email
 * exists ONLY when the user has exactly one credential of that type and it
 * carries metadata.email — zero credentials, several credentials, or a sole
 * credential without a recorded email all yield no entry. Runs against the
 * real sqlite test DB.
 */
// @ts-expect-error - Bun test types
import { describe, it, expect } from 'bun:test';
import '../config/env.js';
import { TEST_USER_ID } from '../test/setup.js';
import { db } from '../db/index.js';
import { userCredentials } from '../db/schema.js';
import { CredentialType } from '@bubblelab/shared-schemas';
import { resolveAccountEmailDefaults } from './account-email-defaults.js';

async function seedGmailCredential(email?: string): Promise<number> {
  const [row] = await db
    .insert(userCredentials)
    .values({
      userId: TEST_USER_ID,
      credentialType: 'GMAIL_CRED',
      name: 'gmail test credential',
      isOauth: true,
      oauthProvider: 'google',
      metadata: email ? { email } : null,
    })
    .returning({ id: userCredentials.id });
  return row.id;
}

const GMAIL_REQUIRED = { '1': [CredentialType.GMAIL_CRED] };

describe('resolveAccountEmailDefaults', () => {
  it('defaults to the sole gmail credential email (exactly-one rule)', async () => {
    await seedGmailCredential('solo@example.com');

    const defaults = await resolveAccountEmailDefaults(
      TEST_USER_ID,
      GMAIL_REQUIRED
    );

    expect(defaults).toEqual({ GMAIL_CRED: 'solo@example.com' });
  });

  it('yields no default with zero credentials of the type', async () => {
    const defaults = await resolveAccountEmailDefaults(
      TEST_USER_ID,
      GMAIL_REQUIRED
    );

    expect(defaults).toEqual({});
  });

  it('yields no default with several credentials of the type (many = blank)', async () => {
    await seedGmailCredential('one@example.com');
    await seedGmailCredential('two@example.com');

    const defaults = await resolveAccountEmailDefaults(
      TEST_USER_ID,
      GMAIL_REQUIRED
    );

    expect(defaults).toEqual({});
  });

  it('yields no default when the sole credential has no recorded email', async () => {
    await seedGmailCredential(undefined);

    const defaults = await resolveAccountEmailDefaults(
      TEST_USER_ID,
      GMAIL_REQUIRED
    );

    expect(defaults).toEqual({});
  });

  it('resolves per type independently and skips system credential types', async () => {
    await seedGmailCredential('solo@example.com');
    // Two sheets credentials: ambiguous, no sheets entry.
    await db.insert(userCredentials).values([
      {
        userId: TEST_USER_ID,
        credentialType: 'GOOGLE_SHEETS_CRED',
        name: 'sheets a',
        metadata: { email: 'a@example.com' },
      },
      {
        userId: TEST_USER_ID,
        credentialType: 'GOOGLE_SHEETS_CRED',
        name: 'sheets b',
        metadata: { email: 'b@example.com' },
      },
    ]);

    const defaults = await resolveAccountEmailDefaults(TEST_USER_ID, {
      '1': [CredentialType.GMAIL_CRED, CredentialType.OPENAI_CRED],
      '2': [CredentialType.GOOGLE_SHEETS_CRED],
    });

    expect(defaults).toEqual({ GMAIL_CRED: 'solo@example.com' });
  });
});
