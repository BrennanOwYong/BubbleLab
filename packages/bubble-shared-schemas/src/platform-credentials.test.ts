import { describe, it, expect } from 'vitest';
import { CredentialType } from './types.js';
import {
  SYSTEM_CREDENTIALS,
  getCredentialEnvValue,
  getPlatformProvidedCredentials,
} from './credential-schema.js';

describe('getCredentialEnvValue', () => {
  it('reads the mapped env name', () => {
    expect(
      getCredentialEnvValue(CredentialType.FIRECRAWL_API_KEY, {
        FIRE_CRAWL_API_KEY: 'fc-123',
      })
    ).toBe('fc-123');
  });

  it('accepts the credential-type spelling (env-name trap fix)', () => {
    expect(
      getCredentialEnvValue(CredentialType.FIRECRAWL_API_KEY, {
        FIRECRAWL_API_KEY: 'fc-456',
      })
    ).toBe('fc-456');
  });

  it('prefers the mapped name when both are set', () => {
    expect(
      getCredentialEnvValue(CredentialType.FIRECRAWL_API_KEY, {
        FIRE_CRAWL_API_KEY: 'mapped',
        FIRECRAWL_API_KEY: 'typed',
      })
    ).toBe('mapped');
  });

  it('returns undefined for empty values and unmapped types', () => {
    expect(
      getCredentialEnvValue(CredentialType.FIRECRAWL_API_KEY, {
        FIRE_CRAWL_API_KEY: '',
      })
    ).toBeUndefined();
    // OAuth type: no env representation, never env-provided.
    expect(
      getCredentialEnvValue(CredentialType.GOOGLE_DRIVE_CRED, {
        GOOGLE_DRIVE_CRED: 'should-be-ignored',
      })
    ).toBeUndefined();
  });
});

describe('getPlatformProvidedCredentials', () => {
  it('is SYSTEM_CREDENTIALS ∩ env-backed types', () => {
    const provided = getPlatformProvidedCredentials({
      OPENAI_API_KEY: 'sk-1',
      FIRE_CRAWL_API_KEY: 'fc-1',
    });
    expect(provided.has(CredentialType.OPENAI_CRED)).toBe(true);
    expect(provided.has(CredentialType.FIRECRAWL_API_KEY)).toBe(true);
    expect(provided.has(CredentialType.ANTHROPIC_CRED)).toBe(false);
    expect(provided.has(CredentialType.RESEND_CRED)).toBe(false);
    for (const type of provided) {
      expect(SYSTEM_CREDENTIALS.has(type)).toBe(true);
    }
  });

  it('excludes FIRECRAWL_API_KEY when its env is unset (the S1 case)', () => {
    const provided = getPlatformProvidedCredentials({ OPENAI_API_KEY: 'sk-1' });
    expect(provided.has(CredentialType.FIRECRAWL_API_KEY)).toBe(false);
  });

  it('never includes non-SYSTEM types even when env-backed', () => {
    const provided = getPlatformProvidedCredentials({
      SLACK_TOKEN: 'xoxb-1',
      GITHUB_TOKEN: 'ghp-1',
    });
    expect(provided.size).toBe(0);
  });
});
