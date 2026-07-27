/**
 * Contract tests for the field-descriptor defaults (locked with the
 * user-profile lane): userProfileDefaults is keyed by INPUT FIELD KEY;
 * accountEmailDefaults stays keyed by CREDENTIAL TYPE.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProfileDefaults,
  isFieldDescriptor,
  matchAccountEmailDefault,
  matchProfileDefault,
  resolveFieldText,
} from './fieldDescriptor';

describe('matchProfileDefault (field-key keyed)', () => {
  const defaults = {
    recipientEmail: 'me@example.com',
    telegramChatId: '123456789',
  };

  it('matches the exact field key', () => {
    expect(matchProfileDefault('recipientEmail', defaults)).toBe(
      'me@example.com'
    );
    expect(matchProfileDefault('telegramChatId', defaults)).toBe('123456789');
  });

  it('tolerates case/separator variants of the SAME key only', () => {
    expect(matchProfileDefault('recipient_email', defaults)).toBe(
      'me@example.com'
    );
    expect(matchProfileDefault('telegram-chat-id', defaults)).toBe('123456789');
  });

  it('does NOT guess semantically different fields', () => {
    expect(matchProfileDefault('ccEmail', defaults)).toBeUndefined();
    expect(matchProfileDefault('slackChannelId', defaults)).toBeUndefined();
  });

  it('degrades to undefined when the map is absent', () => {
    expect(matchProfileDefault('recipientEmail', undefined)).toBeUndefined();
  });
});

describe('matchAccountEmailDefault (credential-type keyed)', () => {
  const defaults = { GMAIL_CRED: 'me@gmail.com' };

  it('fills account fields via the field->credential-type heuristic', () => {
    expect(matchAccountEmailDefault('gmailAccountEmail', defaults)).toBe(
      'me@gmail.com'
    );
  });

  it('ignores non-account fields and missing types', () => {
    expect(
      matchAccountEmailDefault('notionDatabaseId', defaults)
    ).toBeUndefined();
    expect(
      matchAccountEmailDefault('calendarAccountEmail', defaults)
    ).toBeUndefined();
    expect(
      matchAccountEmailDefault('gmailAccountEmail', undefined)
    ).toBeUndefined();
  });
});

describe('applyProfileDefaults', () => {
  const inputSchema = {
    properties: {
      recipientEmail: { type: 'string' },
      gmailAccountEmail: { type: 'string' },
      notionDatabaseId: { type: 'string' },
    },
  };

  it('seeds field-key profile defaults and credential-type account defaults; saved defaults win', () => {
    const seeded = applyProfileDefaults(
      inputSchema,
      { notionDatabaseId: 'saved-id', recipientEmail: 'saved@example.com' },
      { recipientEmail: 'profile@example.com' },
      { GMAIL_CRED: 'me@gmail.com' }
    );
    expect(seeded).toEqual({
      recipientEmail: 'saved@example.com', // saved beats profile
      gmailAccountEmail: 'me@gmail.com', // credential-type keyed
      notionDatabaseId: 'saved-id',
    });
  });

  it('is a no-op when both maps are absent', () => {
    const saved = { notionDatabaseId: 'saved-id' };
    expect(applyProfileDefaults(inputSchema, saved, undefined)).toBe(saved);
  });
});

describe('resolveFieldText (C1 rule)', () => {
  it('renders a known value as the real value, hint only as placeholder', () => {
    expect(
      resolveFieldText({
        storedValue: undefined,
        knownValue: '1234567890abcdef1234567890abcdef',
        hint: 'The long ID from your Notion link',
        name: 'notionDatabaseId',
      })
    ).toEqual({
      displayValue: '1234567890abcdef1234567890abcdef',
      placeholder: 'The long ID from your Notion link',
    });
  });

  it('a cleared field keeps the empty value so the hint shows again', () => {
    expect(
      resolveFieldText({
        storedValue: '',
        knownValue: 'known',
        hint: 'hint',
        name: 'field',
      }).displayValue
    ).toBe('');
  });
});

describe('isFieldDescriptor', () => {
  it('accepts the contract shape with optional value/fromUserProfile', () => {
    expect(isFieldDescriptor({ key: 'k', header: 'H', hint: 'h' })).toBe(true);
    expect(
      isFieldDescriptor({
        key: 'k',
        header: 'H',
        hint: 'h',
        value: 'v',
        fromUserProfile: 'email',
      })
    ).toBe(true);
    expect(isFieldDescriptor({ key: 'k', header: 'H' })).toBe(false);
  });
});
