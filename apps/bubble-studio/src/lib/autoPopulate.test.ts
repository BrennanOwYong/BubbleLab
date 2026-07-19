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

  it('never guesses: a credential without a recorded account email populates nothing', () => {
    const populated = computeAutoPopulatedFields(
      [{ name: 'gmailAccountEmail' }],
      [gmailCredentialWithoutEmail],
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
