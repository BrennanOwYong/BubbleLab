import { describe, it, expect } from 'vitest';
import { CredentialType } from '@bubblelab/shared-schemas';
import type { CredentialResponse } from '@bubblelab/shared-schemas';
import { computeAutoPopulatedFields } from './autoPopulate';

const gmailCredential = {
  id: 42,
  name: 'Work Gmail',
  credentialType: CredentialType.GMAIL_CRED,
  metadata: { email: 'brennan@example.com' },
  createdAt: '2026-07-17T00:00:00.000Z',
} as unknown as CredentialResponse;

const gmailCredentialWithoutEmail = {
  id: 43,
  name: 'Old Gmail',
  credentialType: CredentialType.GMAIL_CRED,
  metadata: undefined,
  createdAt: '2026-07-17T00:00:00.000Z',
} as unknown as CredentialResponse;

describe('setup-field auto-population from saved credentials', () => {
  it('pre-fills an account field from the connected credential email, attributed to the credential', () => {
    const populated = computeAutoPopulatedFields(
      [{ name: 'gmailAccountEmail', type: 'string' }],
      [gmailCredential],
      {}
    );
    expect(populated).toEqual([
      {
        field: 'gmailAccountEmail',
        value: 'brennan@example.com',
        credentialId: 42,
        credentialType: CredentialType.GMAIL_CRED,
        credentialName: 'Work Gmail',
        source: 'oauth_account_email',
      },
    ]);
  });

  it('never overwrites a field the user already filled', () => {
    const populated = computeAutoPopulatedFields(
      [{ name: 'gmailAccountEmail' }],
      [gmailCredential],
      { gmailAccountEmail: 'typed@example.com' }
    );
    expect(populated).toEqual([]);
  });

  it('references the credential by NAME when no account email is on record (never blank while bound)', () => {
    const populated = computeAutoPopulatedFields(
      [{ name: 'gmailAccountEmail' }],
      [gmailCredentialWithoutEmail],
      {}
    );
    expect(populated).toEqual([
      {
        field: 'gmailAccountEmail',
        value: 'Old Gmail',
        credentialId: 43,
        credentialType: CredentialType.GMAIL_CRED,
        credentialName: 'Old Gmail',
        source: 'credential_name',
      },
    ]);
  });

  it('prefers the step-bound credential over an unbound one with an email', () => {
    const populated = computeAutoPopulatedFields(
      [{ name: 'gmailAccountEmail' }],
      [gmailCredential, gmailCredentialWithoutEmail],
      {},
      new Set([43])
    );
    expect(populated).toHaveLength(1);
    expect(populated[0].credentialId).toBe(43);
    expect(populated[0].value).toBe('Old Gmail');
    expect(populated[0].source).toBe('credential_name');
  });

  it('prefers email-carrying rows when nothing is bound', () => {
    const populated = computeAutoPopulatedFields(
      [{ name: 'gmailAccountEmail' }],
      [gmailCredentialWithoutEmail, gmailCredential],
      {}
    );
    expect(populated).toHaveLength(1);
    expect(populated[0].credentialId).toBe(42);
    expect(populated[0].source).toBe('oauth_account_email');
  });

  it('populates nothing when the credential has neither email nor name', () => {
    const nameless = {
      id: 44,
      credentialType: CredentialType.GMAIL_CRED,
      metadata: undefined,
      createdAt: '2026-07-17T00:00:00.000Z',
    } as unknown as CredentialResponse;
    const populated = computeAutoPopulatedFields(
      [{ name: 'gmailAccountEmail' }],
      [nameless],
      {}
    );
    expect(populated).toEqual([]);
  });

  it('leaves non-account fields and non-string fields alone', () => {
    const populated = computeAutoPopulatedFields(
      [
        { name: 'subjectLine', type: 'string' },
        { name: 'gmailAccountEmails', type: 'array' },
      ],
      [gmailCredential],
      {}
    );
    expect(populated).toEqual([]);
  });
});
