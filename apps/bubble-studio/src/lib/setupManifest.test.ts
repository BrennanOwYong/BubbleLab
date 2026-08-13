/**
 * U5 — Setup-tab completeness (BACKLOG U5, the UI half of S1(c)).
 *
 * The pure derivation the Setup panel renders from: every credential the
 * parser reported derives a card — a nested agent-tool credential
 * (FIRECRAWL_API_KEY under the agent's entry) exactly as a direct service
 * bubble's (GOOGLE_DRIVE_CRED) — filtered only by S1's effective
 * platform-provided classification and the wildcard sentinel. F0.5 lens:
 * every derived label is a human product name, never a machine constant.
 */
import { describe, it, expect } from 'vitest';
import { CredentialType } from '@bubblelab/shared-schemas';
import {
  deriveSetupRequirements,
  humanizeCredentialType,
  credentialTypeLabel,
  humanizeStepName,
  stepDisplayName,
} from './setupManifest';

/** F0.5 leakage predicate mirroring scripts/event-test/lib/studio.mjs. */
const SCREAMING_SNAKE = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/;
const isLeakedLabel = (value: string) =>
  /_CRED$/.test(value) || SCREAMING_SNAKE.test(value);

/** S1's flow-81 shape: agent whose nested web-search-tool needs Firecrawl,
 *  plus a direct Google Drive bubble as the control. */
const NESTED_PLUS_DIRECT: Record<string, CredentialType[]> = {
  researchAgent: [
    CredentialType.FIRECRAWL_API_KEY,
    CredentialType.GOOGLE_GEMINI_CRED,
  ],
  driveUpload: [CredentialType.GOOGLE_DRIVE_CRED],
};

describe('deriveSetupRequirements (U5 completeness)', () => {
  it('derives a card for a nested-tool credential exactly as for a direct bubble credential', () => {
    // Platform backs only the AI model key — Firecrawl is a user credential.
    const platformTypes = new Set([CredentialType.GOOGLE_GEMINI_CRED]);
    const entries = deriveSetupRequirements(NESTED_PLUS_DIRECT, platformTypes);
    const types = entries.map((entry) => entry.credentialType);
    expect(types).toContain(CredentialType.FIRECRAWL_API_KEY);
    expect(types).toContain(CredentialType.GOOGLE_DRIVE_CRED);
    expect(types).not.toContain(CredentialType.GOOGLE_GEMINI_CRED);

    const firecrawl = entries.find(
      (entry) => entry.credentialType === CredentialType.FIRECRAWL_API_KEY
    )!;
    const drive = entries.find(
      (entry) => entry.credentialType === CredentialType.GOOGLE_DRIVE_CRED
    )!;
    // Same shape: both carry a human label and the humanized step list.
    expect(Object.keys(firecrawl).sort()).toEqual(Object.keys(drive).sort());
    expect(firecrawl.label).toBe('Firecrawl');
    expect(firecrawl.steps).toEqual(['research agent']);
    expect(drive.steps).toEqual(['drive upload']);
  });

  it('excludes platform-provided types per the effective classification', () => {
    const allBacked = new Set([
      CredentialType.FIRECRAWL_API_KEY,
      CredentialType.GOOGLE_GEMINI_CRED,
    ]);
    const entries = deriveSetupRequirements(NESTED_PLUS_DIRECT, allBacked);
    expect(entries.map((entry) => entry.credentialType)).toEqual([
      CredentialType.GOOGLE_DRIVE_CRED,
    ]);
  });

  it('falls back to declared SYSTEM_CREDENTIALS while the server set is unloaded (null)', () => {
    // Conservative pre-load behavior: declared-SYSTEM Firecrawl stays hidden.
    const entries = deriveSetupRequirements(NESTED_PLUS_DIRECT, null);
    const types = entries.map((entry) => entry.credentialType);
    expect(types).not.toContain(CredentialType.FIRECRAWL_API_KEY);
    expect(types).toContain(CredentialType.GOOGLE_DRIVE_CRED);
  });

  it('skips the wildcard sentinel and merges steps sharing a type', () => {
    const entries = deriveSetupRequirements(
      {
        stepOne: [
          CredentialType.SLACK_CRED,
          CredentialType.CREDENTIAL_WILDCARD,
        ],
        stepTwo: [CredentialType.SLACK_CRED],
      },
      new Set<string>()
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].credentialType).toBe(CredentialType.SLACK_CRED);
    expect(entries[0].steps).toEqual(['step one', 'step two']);
  });

  it('derives nothing from an empty/undefined map', () => {
    expect(deriveSetupRequirements(undefined, new Set<string>())).toEqual([]);
    expect(deriveSetupRequirements({}, new Set<string>())).toEqual([]);
  });

  it('F0.5 lens: no derived label is a *_CRED / SCREAMING_SNAKE machine constant', () => {
    const entries = deriveSetupRequirements(
      NESTED_PLUS_DIRECT,
      new Set<string>()
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(isLeakedLabel(entry.label)).toBe(false);
      for (const step of entry.steps) {
        expect(isLeakedLabel(step)).toBe(false);
      }
    }
  });
});

describe('label fallback + step humanization', () => {
  it('humanizes a machine constant when no config label exists', () => {
    expect(humanizeCredentialType('GOOGLE_DRIVE_CRED')).toBe('Google Drive');
    expect(humanizeCredentialType('FIRECRAWL_API_KEY')).toBe('Firecrawl');
    expect(humanizeCredentialType('TELEGRAM_BOT_TOKEN')).toBe('Telegram Bot');
  });

  it('prefers the product name from CREDENTIAL_TYPE_CONFIG', () => {
    expect(credentialTypeLabel(CredentialType.FIRECRAWL_API_KEY)).toBe(
      'Firecrawl'
    );
    expect(
      isLeakedLabel(credentialTypeLabel(CredentialType.GOOGLE_DRIVE_CRED))
    ).toBe(false);
  });

  it('humanizes step keys', () => {
    expect(humanizeStepName('slack-notification')).toBe('slack notification');
    expect(humanizeStepName('gmailSender')).toBe('gmail sender');
  });

  it('resolves a numeric variable-id step key to the bubble name (never a bare id)', () => {
    const bubbleParameters = {
      '412': { variableName: 'researchAgent', bubbleName: 'ai-agent' },
      '414': { variableName: '', bubbleName: 'google-drive' },
    };
    expect(stepDisplayName('412', bubbleParameters)).toBe('research agent');
    expect(stepDisplayName('414', bubbleParameters)).toBe('google drive');
    // No bubble entry: humanize the key itself.
    expect(stepDisplayName('slack-notification', bubbleParameters)).toBe(
      'slack notification'
    );
  });

  it('derives human step names from numeric-keyed requiredCredentials', () => {
    const entries = deriveSetupRequirements(
      { '414': [CredentialType.GOOGLE_DRIVE_CRED] },
      new Set<string>(),
      { '414': { variableName: 'driveUpload', bubbleName: 'google-drive' } }
    );
    expect(entries[0].steps).toEqual(['drive upload']);
  });
});
