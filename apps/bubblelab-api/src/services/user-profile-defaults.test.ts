/**
 * User-profile defaults (user-profile-defaults.ts): "for me" input prefill,
 * server-side. Per flow input field whose name aliases a profile field
 * (recipientEmail, chat_id, ...), a default exists ONLY when the user's
 * user_profiles row carries a value for it — no profile row, an unset value,
 * or no matching input field all yield no entry. Keys of the returned map are
 * the EXACT inputSchema property names. Runs against the real sqlite test DB.
 */
// @ts-expect-error - Bun test types
import { describe, it, expect, beforeEach } from 'bun:test';
import '../config/env.js';
import { TEST_USER_ID } from '../test/setup.js';
import { db } from '../db/index.js';
import { userProfiles } from '../db/schema.js';
import { resolveUserProfileDefaults } from './user-profile-defaults.js';

async function seedProfile(values: {
  recipientEmail?: string | null;
  telegramChatId?: string | null;
}): Promise<void> {
  await db.insert(userProfiles).values({
    userId: TEST_USER_ID,
    recipientEmail: values.recipientEmail ?? null,
    telegramChatId: values.telegramChatId ?? null,
  });
}

function inputSchema(...fieldKeys: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      fieldKeys.map((key) => [key, { type: 'string' }])
    ),
    required: fieldKeys,
  };
}

describe('resolveUserProfileDefaults', () => {
  beforeEach(async () => {
    // Global test setup does not wipe user_profiles (the users row survives
    // across tests, so the cascade never fires); clear our row here.
    await db.delete(userProfiles);
  });

  it('prefills matched fields keyed by the exact inputSchema property name', async () => {
    await seedProfile({
      recipientEmail: 'me@example.com',
      telegramChatId: '123456789',
    });

    const defaults = await resolveUserProfileDefaults(
      TEST_USER_ID,
      inputSchema('recipientEmail', 'chat_id', 'subject')
    );

    expect(defaults).toEqual({
      recipientEmail: 'me@example.com',
      chat_id: '123456789',
    });
  });

  it('matches alias spellings case- and separator-insensitively', async () => {
    await seedProfile({
      recipientEmail: 'me@example.com',
      telegramChatId: '123456789',
    });

    const defaults = await resolveUserProfileDefaults(
      TEST_USER_ID,
      inputSchema('to_email', 'telegram_chat_id')
    );

    expect(defaults).toEqual({
      to_email: 'me@example.com',
      telegram_chat_id: '123456789',
    });
  });

  it('yields no defaults when the user has no profile row', async () => {
    const defaults = await resolveUserProfileDefaults(
      TEST_USER_ID,
      inputSchema('recipientEmail', 'chat_id')
    );

    expect(defaults).toEqual({});
  });

  it('skips fields whose profile value is unset (partial profile)', async () => {
    await seedProfile({ telegramChatId: '123456789' });

    const defaults = await resolveUserProfileDefaults(
      TEST_USER_ID,
      inputSchema('recipientEmail', 'chat_id')
    );

    expect(defaults).toEqual({ chat_id: '123456789' });
  });

  it('yields no defaults when no input field matches an alias', async () => {
    await seedProfile({
      recipientEmail: 'me@example.com',
      telegramChatId: '123456789',
    });

    const defaults = await resolveUserProfileDefaults(
      TEST_USER_ID,
      inputSchema('subject', 'message', 'spreadsheetUrl')
    );

    expect(defaults).toEqual({});
  });

  it('tolerates a null or shapeless input schema', async () => {
    await seedProfile({ recipientEmail: 'me@example.com' });

    expect(await resolveUserProfileDefaults(TEST_USER_ID, null)).toEqual({});
    expect(await resolveUserProfileDefaults(TEST_USER_ID, {})).toEqual({});
    expect(
      await resolveUserProfileDefaults(TEST_USER_ID, { properties: null })
    ).toEqual({});
  });
});
