/**
 * Server-side deterministic credential auto-bind (credential-auto-bind.ts):
 * the backstop that fills unbound required-credential slots with the single
 * BEST credential — one credential per tool type, never a refusal when a
 * covering credential exists. Exact-type credentials beat derived coverage;
 * within a tier the most recently connected credential wins (createdAt desc,
 * id desc tiebreak). Only zero candidates leaves a slot unbound. Runs against
 * the real sqlite test DB.
 */
// @ts-expect-error - Bun test types
import { describe, it, expect, beforeEach } from 'bun:test';
import '../config/env.js';
import { TEST_USER_ID } from '../test/setup.js';
import { db } from '../db/index.js';
import { userCredentials, derivedCredentials, users } from '../db/schema.js';
import type { ParsedBubbleWithInfo } from '@bubblelab/shared-schemas';
import { autoBindMissingCredentials } from './credential-auto-bind.js';

const OTHER_USER_ID = 'other-user';

function bubble(
  variableId: number,
  bubbleName: string,
  credentials?: Record<string, number>
): ParsedBubbleWithInfo {
  return {
    variableId,
    variableName: `${bubbleName}_${variableId}`,
    bubbleName,
    parameters: credentials
      ? [{ name: 'credentials', value: credentials, type: 'object' }]
      : [],
  } as unknown as ParsedBubbleWithInfo;
}

async function seedCredential(
  credentialType: string,
  userId: string = TEST_USER_ID,
  createdAt?: Date
): Promise<number> {
  const [row] = await db
    .insert(userCredentials)
    .values({
      userId,
      credentialType,
      name: `${credentialType} test credential`,
      ...(createdAt ? { createdAt } : {}),
    })
    .returning({ id: userCredentials.id });
  return row.id;
}

async function seedDerivedRecord(
  parentCredentialId: number,
  derivedCredentialType: string,
  userId: string = TEST_USER_ID
): Promise<void> {
  await db.insert(derivedCredentials).values({
    parentCredentialId,
    userId,
    derivedCredentialType,
    provider: 'google',
    isDerived: true,
  });
}

function boundCredentials(
  bubbleParameters: Record<string, ParsedBubbleWithInfo>,
  bubbleKey: string
): Record<string, number> | undefined {
  const credentialsParam = bubbleParameters[bubbleKey].parameters.find(
    (p) => p.name === 'credentials'
  );
  return credentialsParam?.value as Record<string, number> | undefined;
}

describe('autoBindMissingCredentials', () => {
  beforeEach(async () => {
    // The global beforeEach wipes userCredentials; the derived rows must go
    // too (sqlite FK cascade is not guaranteed on in libsql test runs).
    await db.delete(derivedCredentials);
    await db
      .insert(users)
      .values({
        clerkId: OTHER_USER_ID,
        firstName: 'Other',
        lastName: 'User',
        email: 'other@example.com',
        appType: 'nodex',
      })
      .onConflictDoNothing();
  });

  it('binds the single exact-type credential and reports the slot', async () => {
    const telegramId = await seedCredential('TELEGRAM_BOT_TOKEN');
    const params = { '1': bubble(1, 'telegram') };

    const result = await autoBindMissingCredentials(TEST_USER_ID, params);

    expect(result.bound).toEqual([
      {
        bubbleKey: '1',
        credentialType: 'TELEGRAM_BOT_TOKEN',
        credentialId: telegramId,
        match: 'exact_type',
      },
    ]);
    expect(boundCredentials(result.bubbleParameters, '1')).toEqual({
      TELEGRAM_BOT_TOKEN: telegramId,
    });
  });

  it('binds the most recently connected credential when several exact-type credentials exist', async () => {
    const newerId = await seedCredential(
      'TELEGRAM_BOT_TOKEN',
      TEST_USER_ID,
      new Date('2026-02-01T00:00:00Z')
    );
    await seedCredential(
      'TELEGRAM_BOT_TOKEN',
      TEST_USER_ID,
      new Date('2026-01-01T00:00:00Z')
    );
    const params = { '1': bubble(1, 'telegram') };

    const result = await autoBindMissingCredentials(TEST_USER_ID, params);

    expect(result.bound).toEqual([
      {
        bubbleKey: '1',
        credentialType: 'TELEGRAM_BOT_TOKEN',
        credentialId: newerId,
        match: 'exact_type',
      },
    ]);
    expect(boundCredentials(result.bubbleParameters, '1')).toEqual({
      TELEGRAM_BOT_TOKEN: newerId,
    });
  });

  it('breaks a created-at tie between exact-type credentials by highest id (deterministic)', async () => {
    const sameInstant = new Date('2026-03-01T00:00:00Z');
    const firstId = await seedCredential(
      'TELEGRAM_BOT_TOKEN',
      TEST_USER_ID,
      sameInstant
    );
    const secondId = await seedCredential(
      'TELEGRAM_BOT_TOKEN',
      TEST_USER_ID,
      sameInstant
    );
    const params = { '1': bubble(1, 'telegram') };

    const result = await autoBindMissingCredentials(TEST_USER_ID, params);

    expect(secondId).toBeGreaterThan(firstId);
    expect(boundCredentials(result.bubbleParameters, '1')).toEqual({
      TELEGRAM_BOT_TOKEN: secondId,
    });
  });

  it('binds the single derived-record parent when no exact-type credential exists', async () => {
    const gmailId = await seedCredential('GMAIL_CRED');
    await seedDerivedRecord(gmailId, 'GOOGLE_SHEETS_CRED');
    const params = { '2': bubble(2, 'google-sheets') };

    const result = await autoBindMissingCredentials(TEST_USER_ID, params);

    expect(result.bound).toEqual([
      {
        bubbleKey: '2',
        credentialType: 'GOOGLE_SHEETS_CRED',
        credentialId: gmailId,
        match: 'derived_record',
      },
    ]);
    expect(boundCredentials(result.bubbleParameters, '2')).toEqual({
      GOOGLE_SHEETS_CRED: gmailId,
    });
  });

  it('prefers the single exact-type credential over derived-record parents', async () => {
    const sheetsId = await seedCredential('GOOGLE_SHEETS_CRED');
    const gmailId = await seedCredential('GMAIL_CRED');
    await seedDerivedRecord(gmailId, 'GOOGLE_SHEETS_CRED');
    const params = { '2': bubble(2, 'google-sheets') };

    const result = await autoBindMissingCredentials(TEST_USER_ID, params);

    expect(result.bound).toEqual([
      {
        bubbleKey: '2',
        credentialType: 'GOOGLE_SHEETS_CRED',
        credentialId: sheetsId,
        match: 'exact_type',
      },
    ]);
  });

  it('multi-cover: binds the most recently connected covering parent (Gmail + Drive both cover Sheets)', async () => {
    const gmailId = await seedCredential(
      'GMAIL_CRED',
      TEST_USER_ID,
      new Date('2026-01-01T00:00:00Z')
    );
    const driveId = await seedCredential(
      'GOOGLE_DRIVE_CRED',
      TEST_USER_ID,
      new Date('2026-02-01T00:00:00Z')
    );
    await seedDerivedRecord(gmailId, 'GOOGLE_SHEETS_CRED');
    await seedDerivedRecord(driveId, 'GOOGLE_SHEETS_CRED');
    const params = { '2': bubble(2, 'google-sheets') };

    const result = await autoBindMissingCredentials(TEST_USER_ID, params);

    expect(result.bound).toEqual([
      {
        bubbleKey: '2',
        credentialType: 'GOOGLE_SHEETS_CRED',
        credentialId: driveId,
        match: 'derived_record',
      },
    ]);
    // The bound id is the token-holding PARENT credential, never a derived row.
    expect(boundCredentials(result.bubbleParameters, '2')).toEqual({
      GOOGLE_SHEETS_CRED: driveId,
    });
  });

  it('multi-cover recency follows the parent connect time regardless of insert order', async () => {
    // Insert the NEWER parent first so row order cannot masquerade as recency.
    const driveId = await seedCredential(
      'GOOGLE_DRIVE_CRED',
      TEST_USER_ID,
      new Date('2026-02-01T00:00:00Z')
    );
    const gmailId = await seedCredential(
      'GMAIL_CRED',
      TEST_USER_ID,
      new Date('2026-01-01T00:00:00Z')
    );
    await seedDerivedRecord(gmailId, 'GOOGLE_SHEETS_CRED');
    await seedDerivedRecord(driveId, 'GOOGLE_SHEETS_CRED');
    const params = { '2': bubble(2, 'google-sheets') };

    const result = await autoBindMissingCredentials(TEST_USER_ID, params);

    expect(boundCredentials(result.bubbleParameters, '2')).toEqual({
      GOOGLE_SHEETS_CRED: driveId,
    });
  });

  it('leaves already-bound slots untouched', async () => {
    const telegramId = await seedCredential('TELEGRAM_BOT_TOKEN');
    const params = {
      '1': bubble(1, 'telegram', { TELEGRAM_BOT_TOKEN: 999 }),
    };

    const result = await autoBindMissingCredentials(TEST_USER_ID, params);

    expect(result.bound).toEqual([]);
    expect(boundCredentials(result.bubbleParameters, '1')).toEqual({
      TELEGRAM_BOT_TOKEN: 999,
    });
    expect(telegramId).toBeGreaterThan(0);
  });

  it('skips system credential slots (ai-agent model credentials)', async () => {
    await seedCredential('OPENAI_CRED');
    const params = { '3': bubble(3, 'ai-agent') };

    const result = await autoBindMissingCredentials(TEST_USER_ID, params);

    expect(result.bound).toEqual([]);
  });

  it("never binds another user's credential", async () => {
    await seedCredential('TELEGRAM_BOT_TOKEN', OTHER_USER_ID);
    const params = { '1': bubble(1, 'telegram') };

    const result = await autoBindMissingCredentials(TEST_USER_ID, params);

    expect(result.bound).toEqual([]);
  });

  it('binds several independent slots in one pass', async () => {
    const telegramId = await seedCredential('TELEGRAM_BOT_TOKEN');
    const gmailId = await seedCredential('GMAIL_CRED');
    await seedDerivedRecord(gmailId, 'GOOGLE_SHEETS_CRED');
    const params = {
      '1': bubble(1, 'telegram'),
      '2': bubble(2, 'google-sheets'),
    };

    const result = await autoBindMissingCredentials(TEST_USER_ID, params);

    expect(result.bound).toHaveLength(2);
    expect(boundCredentials(result.bubbleParameters, '1')).toEqual({
      TELEGRAM_BOT_TOKEN: telegramId,
    });
    expect(boundCredentials(result.bubbleParameters, '2')).toEqual({
      GOOGLE_SHEETS_CRED: gmailId,
    });
  });
});
