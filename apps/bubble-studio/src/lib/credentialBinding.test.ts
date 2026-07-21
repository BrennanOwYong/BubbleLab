import { describe, it, expect } from 'vitest';
import {
  CredentialType,
  computeScopeCoverage,
} from '@bubblelab/shared-schemas';
import type {
  CredentialResponse,
  DerivedCredentialRecord,
  ParsedBubbleWithInfo,
} from '@bubblelab/shared-schemas';
import {
  computeAutoBindings,
  computeSuiteBindingProposals,
  credentialCoversTypeByRecord,
  getStoredSuiteCoverage,
  getProviderSuiteCandidates,
  pickDefaultCredential,
  getBubbleKeysRequiringType,
  getBoundCredentialIdForType,
} from './credentialBinding';

function derivedRecord(
  parentCredentialId: number,
  derivedCredentialType: string,
  id = parentCredentialId * 100
): DerivedCredentialRecord {
  return {
    id,
    parentCredentialId,
    derivedCredentialType,
    provider: 'google',
    isDerived: true,
  };
}

function credential(
  overrides: Partial<CredentialResponse> & { id: number }
): CredentialResponse {
  return {
    credentialType: CredentialType.GMAIL_CRED,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as unknown as CredentialResponse;
}

function bubble(
  variableId: number,
  bubbleName = 'gmail'
): ParsedBubbleWithInfo {
  return {
    variableId,
    variableName: `${bubbleName}_${variableId}`,
    bubbleName,
    parameters: [],
  } as unknown as ParsedBubbleWithInfo;
}

const workGmail = credential({
  id: 1,
  name: 'Work Gmail',
  createdAt: '2026-07-01T00:00:00.000Z',
});
const personalGmail = credential({
  id: 2,
  name: 'Personal Gmail',
  createdAt: '2026-07-15T00:00:00.000Z',
});
const slackBot = credential({
  id: 3,
  name: 'Slack bot',
  credentialType: CredentialType.SLACK_API,
});

describe('computeAutoBindings', () => {
  it('binds the single connected credential of a required type per step', () => {
    const bindings = computeAutoBindings({
      bubbleParameters: { '5': bubble(5) },
      requiredCredentials: { '5': [CredentialType.GMAIL_CRED] },
      pendingCredentials: {},
      credentials: [workGmail],
    });
    expect(bindings).toEqual([
      {
        bubbleKey: '5',
        credentialType: CredentialType.GMAIL_CRED,
        credentialId: 1,
        credentialName: 'Work Gmail',
        reason: 'only_credential',
        candidateCount: 1,
      },
    ]);
  });

  it('defaults to the most recently created credential when several exist', () => {
    const bindings = computeAutoBindings({
      bubbleParameters: { '5': bubble(5) },
      requiredCredentials: { '5': [CredentialType.GMAIL_CRED] },
      pendingCredentials: {},
      credentials: [workGmail, personalGmail],
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0].credentialId).toBe(2);
    expect(bindings[0].reason).toBe('default_of_many');
    expect(bindings[0].candidateCount).toBe(2);
  });

  it('never overrides an existing per-step selection', () => {
    const bindings = computeAutoBindings({
      bubbleParameters: { '5': bubble(5) },
      requiredCredentials: { '5': [CredentialType.GMAIL_CRED] },
      pendingCredentials: { '5': { [CredentialType.GMAIL_CRED]: 1 } },
      credentials: [workGmail, personalGmail],
    });
    expect(bindings).toEqual([]);
  });

  it('binds nothing when no credential of the type is connected', () => {
    const bindings = computeAutoBindings({
      bubbleParameters: { '5': bubble(5) },
      requiredCredentials: { '5': [CredentialType.GMAIL_CRED] },
      pendingCredentials: {},
      credentials: [slackBot],
    });
    expect(bindings).toEqual([]);
  });

  it('matches the exact credential type only (no cross-method binding)', () => {
    const bindings = computeAutoBindings({
      bubbleParameters: { '7': bubble(7, 'slack') },
      requiredCredentials: {
        '7': [CredentialType.SLACK_CRED, CredentialType.SLACK_API],
      },
      pendingCredentials: {},
      credentials: [slackBot],
    });
    expect(bindings).toEqual([
      {
        bubbleKey: '7',
        credentialType: CredentialType.SLACK_API,
        credentialId: 3,
        credentialName: 'Slack bot',
        reason: 'only_credential',
        candidateCount: 1,
      },
    ]);
  });

  it('skips system credential types', () => {
    const openai = credential({
      id: 9,
      credentialType: CredentialType.OPENAI_CRED,
    });
    const bindings = computeAutoBindings({
      bubbleParameters: { '5': bubble(5, 'ai-agent') },
      requiredCredentials: { '5': [CredentialType.OPENAI_CRED] },
      pendingCredentials: {},
      credentials: [openai],
    });
    expect(bindings).toEqual([]);
  });

  it('binds each step independently (per-step, not flow-global)', () => {
    const bindings = computeAutoBindings({
      bubbleParameters: { '5': bubble(5), '6': bubble(6) },
      requiredCredentials: {
        '5': [CredentialType.GMAIL_CRED],
        '6': [CredentialType.GMAIL_CRED],
      },
      pendingCredentials: { '6': { [CredentialType.GMAIL_CRED]: 1 } },
      credentials: [workGmail, personalGmail],
    });
    expect(bindings.map((b) => b.bubbleKey)).toEqual(['5']);
  });

  it('falls back to a credential whose derived record covers the type (suite zero-click)', () => {
    const gmailCoveringSheets = credential({
      id: 4,
      name: 'Gmail (covers Sheets)',
      credentialType: CredentialType.GMAIL_CRED,
      isOauth: true,
      derivedCredentials: [derivedRecord(4, CredentialType.GOOGLE_SHEETS_CRED)],
    });
    const bindings = computeAutoBindings({
      bubbleParameters: { '5': bubble(5, 'google-sheets') },
      requiredCredentials: { '5': [CredentialType.GOOGLE_SHEETS_CRED] },
      pendingCredentials: {},
      credentials: [gmailCoveringSheets],
    });
    expect(bindings).toEqual([
      {
        bubbleKey: '5',
        credentialType: CredentialType.GOOGLE_SHEETS_CRED,
        credentialId: 4,
        credentialName: 'Gmail (covers Sheets)',
        reason: 'derived_record',
        candidateCount: 1,
      },
    ]);
  });

  it('prefers an exact-type credential over a derived-record sibling', () => {
    const exactSheets = credential({
      id: 5,
      name: 'Sheets',
      credentialType: CredentialType.GOOGLE_SHEETS_CRED,
      isOauth: true,
    });
    const gmailCoveringSheets = credential({
      id: 4,
      credentialType: CredentialType.GMAIL_CRED,
      isOauth: true,
      derivedCredentials: [derivedRecord(4, CredentialType.GOOGLE_SHEETS_CRED)],
    });
    const bindings = computeAutoBindings({
      bubbleParameters: { '5': bubble(5, 'google-sheets') },
      requiredCredentials: { '5': [CredentialType.GOOGLE_SHEETS_CRED] },
      pendingCredentials: {},
      credentials: [gmailCoveringSheets, exactSheets],
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0].credentialId).toBe(5);
    expect(bindings[0].reason).toBe('only_credential');
  });

  it('defaults among several record-covered siblings by recency', () => {
    const olderGmail = credential({
      id: 4,
      credentialType: CredentialType.GMAIL_CRED,
      isOauth: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      derivedCredentials: [derivedRecord(4, CredentialType.GOOGLE_SHEETS_CRED)],
    });
    const newerDrive = credential({
      id: 6,
      credentialType: CredentialType.GOOGLE_DRIVE_CRED,
      isOauth: true,
      createdAt: '2026-07-15T00:00:00.000Z',
      derivedCredentials: [
        derivedRecord(6, CredentialType.GOOGLE_SHEETS_CRED, 601),
      ],
    });
    const bindings = computeAutoBindings({
      bubbleParameters: { '5': bubble(5, 'google-sheets') },
      requiredCredentials: { '5': [CredentialType.GOOGLE_SHEETS_CRED] },
      pendingCredentials: {},
      credentials: [olderGmail, newerDrive],
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0].credentialId).toBe(6);
    expect(bindings[0].reason).toBe('derived_record');
    expect(bindings[0].candidateCount).toBe(2);
  });
});

describe('pickDefaultCredential', () => {
  it('prefers the most recent createdAt, falling back to highest id on ties', () => {
    expect(pickDefaultCredential([workGmail, personalGmail])?.id).toBe(2);
    const twinA = credential({ id: 10 });
    const twinB = credential({ id: 11 });
    expect(pickDefaultCredential([twinA, twinB])?.id).toBe(11);
    expect(pickDefaultCredential([])).toBeUndefined();
  });
});

describe('setup-panel binding helpers', () => {
  it('lists the steps requiring a type and reads the agreed bound id', () => {
    const bubbleParameters = { '5': bubble(5), '6': bubble(6) };
    const requiredCredentials = {
      '5': [CredentialType.GMAIL_CRED],
      '6': [CredentialType.GMAIL_CRED],
    };
    const keys = getBubbleKeysRequiringType(
      bubbleParameters,
      requiredCredentials,
      CredentialType.GMAIL_CRED
    );
    expect(keys).toEqual(['5', '6']);
    expect(
      getBoundCredentialIdForType({}, keys, CredentialType.GMAIL_CRED)
    ).toBeUndefined();
    expect(
      getBoundCredentialIdForType(
        {
          '5': { [CredentialType.GMAIL_CRED]: 2 },
          '6': { [CredentialType.GMAIL_CRED]: 2 },
        },
        keys,
        CredentialType.GMAIL_CRED
      )
    ).toBe(2);
    expect(
      getBoundCredentialIdForType(
        {
          '5': { [CredentialType.GMAIL_CRED]: 1 },
          '6': { [CredentialType.GMAIL_CRED]: 2 },
        },
        keys,
        CredentialType.GMAIL_CRED
      )
    ).toBeNull();
  });
});

describe('computeSuiteBindingProposals (same OAuth provider, sibling type)', () => {
  const oauthDrive = credential({
    id: 20,
    name: 'Drive (work)',
    credentialType: CredentialType.GOOGLE_DRIVE_CRED,
    isOauth: true,
    createdAt: '2026-07-10T00:00:00.000Z',
  });
  const oauthGmail = credential({
    id: 21,
    name: 'Gmail (work)',
    credentialType: CredentialType.GMAIL_CRED,
    isOauth: true,
    createdAt: '2026-07-12T00:00:00.000Z',
  });
  const sheetsFlow = {
    bubbleParameters: { '5': bubble(5, 'google-sheets') },
    requiredCredentials: { '5': [CredentialType.GOOGLE_SHEETS_CRED] },
  };

  it('proposes a sibling Google credential for a slot with no exact-type match', () => {
    const proposals = computeSuiteBindingProposals({
      ...sheetsFlow,
      pendingCredentials: {},
      credentials: [oauthDrive],
    });
    expect(proposals).toEqual([
      {
        bubbleKey: '5',
        requiredCredentialType: CredentialType.GOOGLE_SHEETS_CRED,
        provider: 'google',
        credentialId: 20,
        credentialName: 'Drive (work)',
        sourceCredentialType: CredentialType.GOOGLE_DRIVE_CRED,
        candidateCount: 1,
        hasDerivedRecord: false,
      },
    ]);
  });

  it('prefers the sibling holding a STORED derived record for the required type', () => {
    const driveWithRecord = credential({
      id: 20,
      name: 'Drive (work)',
      credentialType: CredentialType.GOOGLE_DRIVE_CRED,
      isOauth: true,
      createdAt: '2026-07-10T00:00:00.000Z',
      derivedCredentials: [
        derivedRecord(20, CredentialType.GOOGLE_SHEETS_CRED),
      ],
    });
    // Newer than the Drive credential — the recency default would pick it, but
    // the stored record on the Drive credential wins.
    const proposals = computeSuiteBindingProposals({
      ...sheetsFlow,
      pendingCredentials: {},
      credentials: [driveWithRecord, oauthGmail],
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].credentialId).toBe(20);
    expect(proposals[0].hasDerivedRecord).toBe(true);
    expect(proposals[0].candidateCount).toBe(2);
  });

  it('defers to the exact-type path when an exact-type credential exists', () => {
    const exactSheets = credential({
      id: 22,
      credentialType: CredentialType.GOOGLE_SHEETS_CRED,
      isOauth: true,
    });
    const proposals = computeSuiteBindingProposals({
      ...sheetsFlow,
      pendingCredentials: {},
      credentials: [oauthDrive, exactSheets],
    });
    expect(proposals).toEqual([]);
  });

  it('skips a slot bound to an exact-type credential', () => {
    const exactSheets = credential({
      id: 99,
      credentialType: CredentialType.GOOGLE_SHEETS_CRED,
      isOauth: true,
    });
    const proposals = computeSuiteBindingProposals({
      ...sheetsFlow,
      pendingCredentials: {
        '5': { [CredentialType.GOOGLE_SHEETS_CRED]: 99 },
      },
      credentials: [oauthDrive, exactSheets],
    });
    expect(proposals).toEqual([]);
  });

  it('skips a slot bound to a credential outside the provider group', () => {
    const proposals = computeSuiteBindingProposals({
      ...sheetsFlow,
      pendingCredentials: {
        '5': { [CredentialType.GOOGLE_SHEETS_CRED]: 99 },
      },
      credentials: [oauthDrive],
    });
    expect(proposals).toEqual([]);
  });

  it('proposes the ALREADY-BOUND sibling credential for scope-check confirmation', () => {
    // The derived-record auto-bind selected the Drive credential for the
    // Sheets slot; the proposal must name that same credential (not the
    // recency default) so the live probe confirms or rolls back the binding.
    const driveWithRecord = credential({
      id: 20,
      name: 'Drive (work)',
      credentialType: CredentialType.GOOGLE_DRIVE_CRED,
      isOauth: true,
      createdAt: '2026-07-10T00:00:00.000Z',
      derivedCredentials: [
        derivedRecord(20, CredentialType.GOOGLE_SHEETS_CRED),
      ],
    });
    const proposals = computeSuiteBindingProposals({
      ...sheetsFlow,
      pendingCredentials: {
        '5': { [CredentialType.GOOGLE_SHEETS_CRED]: 20 },
      },
      credentials: [driveWithRecord, oauthGmail],
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].credentialId).toBe(20);
    expect(proposals[0].hasDerivedRecord).toBe(true);
  });

  it('picks the most recently created sibling when several exist', () => {
    const proposals = computeSuiteBindingProposals({
      ...sheetsFlow,
      pendingCredentials: {},
      credentials: [oauthDrive, oauthGmail],
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].credentialId).toBe(21);
    expect(proposals[0].candidateCount).toBe(2);
  });

  it('ignores non-OAuth rows and non-provider-grouped types (exact-match only)', () => {
    const pastedSlackBot = credential({
      id: 23,
      credentialType: CredentialType.SLACK_API,
    });
    const nonOauthDrive = credential({
      id: 24,
      credentialType: CredentialType.GOOGLE_DRIVE_CRED,
    });
    expect(
      computeSuiteBindingProposals({
        ...sheetsFlow,
        pendingCredentials: {},
        credentials: [pastedSlackBot, nonOauthDrive],
      })
    ).toEqual([]);
    // A slot of a single-type provider group (slack) never gets suite proposals.
    expect(
      computeSuiteBindingProposals({
        bubbleParameters: { '7': bubble(7, 'slack') },
        requiredCredentials: { '7': [CredentialType.SLACK_CRED] },
        pendingCredentials: {},
        credentials: [oauthDrive, oauthGmail],
      })
    ).toEqual([]);
  });

  it('getProviderSuiteCandidates excludes the exact type itself', () => {
    const exactSheets = credential({
      id: 25,
      credentialType: CredentialType.GOOGLE_SHEETS_CRED,
      isOauth: true,
    });
    const candidates = getProviderSuiteCandidates(
      [oauthDrive, exactSheets],
      CredentialType.GOOGLE_SHEETS_CRED
    );
    expect(candidates.map((c) => c.id)).toEqual([20]);
  });
});

describe('getStoredSuiteCoverage (persisted derived-credential records)', () => {
  it('maps the stored records to labeled coverage entries', () => {
    const drive = credential({
      id: 30,
      credentialType: CredentialType.GOOGLE_DRIVE_CRED,
      isOauth: true,
      oauthProvider: 'google',
      derivedCredentials: [
        derivedRecord(30, CredentialType.GOOGLE_SHEETS_CRED, 1),
        derivedRecord(30, CredentialType.GOOGLE_CALENDAR_CRED, 2),
      ],
    });
    expect(getStoredSuiteCoverage(drive)).toEqual([
      {
        credentialType: CredentialType.GOOGLE_SHEETS_CRED,
        label: 'Google Sheets',
      },
      {
        credentialType: CredentialType.GOOGLE_CALENDAR_CRED,
        label: 'Google Calendar',
      },
    ]);
  });

  it('returns [] for credentials without records and never recomputes from scopes', () => {
    const drive = credential({
      id: 31,
      credentialType: CredentialType.GOOGLE_DRIVE_CRED,
      isOauth: true,
      oauthProvider: 'google',
      // Scopes that WOULD cover Sheets — but no stored record, so no coverage:
      // the persisted record is the source of truth, not a client recompute.
      oauthScopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    expect(getStoredSuiteCoverage(drive)).toEqual([]);
  });

  it('credentialCoversTypeByRecord matches only the recorded derived types', () => {
    const drive = credential({
      id: 32,
      credentialType: CredentialType.GOOGLE_DRIVE_CRED,
      isOauth: true,
      derivedCredentials: [
        derivedRecord(32, CredentialType.GOOGLE_SHEETS_CRED),
      ],
    });
    expect(
      credentialCoversTypeByRecord(drive, CredentialType.GOOGLE_SHEETS_CRED)
    ).toBe(true);
    expect(
      credentialCoversTypeByRecord(drive, CredentialType.GOOGLE_CALENDAR_CRED)
    ).toBe(false);
    expect(
      credentialCoversTypeByRecord(
        credential({ id: 33 }),
        CredentialType.GOOGLE_SHEETS_CRED
      )
    ).toBe(false);
  });
});

describe('computeScopeCoverage (shared-schemas — the API record derivation)', () => {
  const SHEETS = 'https://www.googleapis.com/auth/spreadsheets';
  const CALENDAR = 'https://www.googleapis.com/auth/calendar';
  const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
  const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

  it('reports the sibling types the grant fully covers, own type excluded', () => {
    const entries = computeScopeCoverage(CredentialType.GOOGLE_DRIVE_CRED, [
      SHEETS,
      CALENDAR,
      GMAIL_SEND,
    ]);
    expect(entries.map((entry) => entry.credentialType)).not.toContain(
      CredentialType.GOOGLE_DRIVE_CRED
    );
    const byType = new Map(
      entries.map((entry) => [entry.credentialType, entry])
    );
    expect(byType.get(CredentialType.GOOGLE_SHEETS_CRED)?.covered).toBe(true);
    expect(byType.get(CredentialType.GOOGLE_CALENDAR_CRED)?.covered).toBe(true);
    // Gmail needs send AND modify; only send is granted.
    expect(byType.get(CredentialType.GMAIL_CRED)?.covered).toBe(false);
    expect(byType.get(CredentialType.GMAIL_CRED)?.missingScopes).toEqual([
      GMAIL_MODIFY,
    ]);
  });

  it('is trailing-slash tolerant when comparing scopes', () => {
    const sheets = computeScopeCoverage(CredentialType.GOOGLE_DRIVE_CRED, [
      `${SHEETS}/`,
    ]).find(
      (entry) => entry.credentialType === CredentialType.GOOGLE_SHEETS_CRED
    );
    expect(sheets?.covered).toBe(true);
  });

  it('returns [] for empty grants and single-type provider groups', () => {
    expect(computeScopeCoverage(CredentialType.GOOGLE_DRIVE_CRED, [])).toEqual(
      []
    );
    expect(
      computeScopeCoverage(CredentialType.SLACK_CRED, ['chat:write'])
    ).toEqual([]);
  });
});
