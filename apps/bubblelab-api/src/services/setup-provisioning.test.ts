/**
 * Setup provisioning + workflow-done message shaping
 * (setup-provisioning.ts). Provisioning runs against the real sqlite test DB
 * with an injected resource creator (no network, no live Sheets call); the
 * descriptor/message builders are pure.
 */
// @ts-expect-error - Bun test types
import { describe, it, expect, beforeEach } from 'bun:test';
import '../config/env.js';
import { TEST_USER_ID } from '../test/setup.js';
import { db } from '../db/index.js';
import { userCredentials, derivedCredentials } from '../db/schema.js';
import { CredentialEncryption } from '../utils/encryption.js';
import {
  CredentialType,
  type CoffeeMessage,
  type SetupResource,
} from '@bubblelab/shared-schemas';
import {
  extractSetupResources,
  provisionSetupResources,
  resolveSheetsCredentialId,
  buildSetupFieldDescriptors,
  buildWorkflowDoneMessage,
  humanizeInputKey,
  type ResourceCreator,
} from './setup-provisioning.js';

// The global test beforeEach wipes userCredentials but NOT
// derived_credentials (FK cascade is not enforced in libsql test runs) —
// clear it here so derived-record fallbacks never see stale rows.
beforeEach(async () => {
  await db.delete(derivedCredentials);
});

const SHEET_RESOURCE: SetupResource = {
  kind: 'google_spreadsheet',
  inputKey: 'spreadsheetId',
  title: 'Survey answers',
};

function planMessage(
  setupResources?: SetupResource[],
  id = 'plan-1'
): CoffeeMessage {
  return {
    id,
    timestamp: new Date().toISOString(),
    type: 'plan',
    plan: {
      summary: 'pipe answers into a sheet',
      steps: [],
      estimatedBubbles: ['google-sheets'],
      ...(setupResources ? { setupResources } : {}),
    },
  };
}

async function seedSheetsOauthCredential(
  token = 'live-token'
): Promise<number> {
  const [row] = await db
    .insert(userCredentials)
    .values({
      userId: TEST_USER_ID,
      credentialType: CredentialType.GOOGLE_SHEETS_CRED,
      name: 'sheets test credential',
      isOauth: true,
      oauthProvider: 'google',
      // No refresh token -> getValidToken decrypts the stored access token
      // without any network call.
      oauthAccessToken: await CredentialEncryption.encrypt(token),
    })
    .returning({ id: userCredentials.id });
  return row.id;
}

describe('extractSetupResources', () => {
  it('returns the latest plan message declaration', () => {
    const messages: CoffeeMessage[] = [
      planMessage([SHEET_RESOURCE], 'plan-old'),
      planMessage(
        [{ ...SHEET_RESOURCE, title: 'Survey answers v2' }],
        'plan-new'
      ),
    ];
    const resources = extractSetupResources(messages);
    expect(resources).toHaveLength(1);
    expect(resources[0].title).toBe('Survey answers v2');
  });

  it('returns empty for no messages / no plan / plan without resources', () => {
    expect(extractSetupResources(undefined)).toEqual([]);
    expect(extractSetupResources([])).toEqual([]);
    expect(extractSetupResources([planMessage(undefined)])).toEqual([]);
  });
});

describe('provisionSetupResources', () => {
  it('creates the declared resource and fills defaultInputs with its real id', async () => {
    await seedSheetsOauthCredential();
    const seenTokens: string[] = [];
    const creator: ResourceCreator = async (resource, accessToken) => {
      seenTokens.push(accessToken);
      return { resourceId: 'sheet-abc123', url: 'https://sheets/abc123' };
    };

    const outcome = await provisionSetupResources(
      TEST_USER_ID,
      [SHEET_RESOURCE],
      {},
      {},
      creator
    );

    expect(seenTokens).toEqual(['live-token']);
    expect(outcome.defaultInputs).toEqual({ spreadsheetId: 'sheet-abc123' });
    expect(outcome.provisioning.spreadsheetId.status).toBe('created');
    expect(outcome.provisioning.spreadsheetId.resourceId).toBe('sheet-abc123');
    expect(outcome.provisioning.spreadsheetId.url).toBe(
      'https://sheets/abc123'
    );
  });

  it('is idempotent: an existing defaultInputs value is never re-created', async () => {
    let calls = 0;
    const creator: ResourceCreator = async () => {
      calls += 1;
      return { resourceId: 'should-not-happen' };
    };

    const outcome = await provisionSetupResources(
      TEST_USER_ID,
      [SHEET_RESOURCE],
      { spreadsheetId: 'existing-id' },
      {},
      creator
    );

    expect(calls).toBe(0);
    expect(outcome.defaultInputs).toEqual({});
    expect(outcome.provisioning).toEqual({});
  });

  it('re-asserts a prior provisioning record without re-creating', async () => {
    let calls = 0;
    const creator: ResourceCreator = async () => {
      calls += 1;
      return { resourceId: 'should-not-happen' };
    };

    const outcome = await provisionSetupResources(
      TEST_USER_ID,
      [SHEET_RESOURCE],
      {},
      {
        spreadsheetId: {
          kind: 'google_spreadsheet',
          status: 'created',
          title: 'Survey answers',
          resourceId: 'sheet-prior',
          provisionedAt: new Date().toISOString(),
        },
      },
      creator
    );

    expect(calls).toBe(0);
    expect(outcome.defaultInputs).toEqual({ spreadsheetId: 'sheet-prior' });
  });

  it('degrades to skipped_no_credential with no connected credential', async () => {
    const creator: ResourceCreator = async () => ({ resourceId: 'x' });

    const outcome = await provisionSetupResources(
      TEST_USER_ID,
      [SHEET_RESOURCE],
      {},
      {},
      creator
    );

    expect(outcome.defaultInputs).toEqual({});
    expect(outcome.provisioning.spreadsheetId.status).toBe(
      'skipped_no_credential'
    );
  });

  it('degrades to failed (field left blank) when the creator throws', async () => {
    await seedSheetsOauthCredential();
    const creator: ResourceCreator = async () => {
      throw new Error('sheets api 403');
    };

    const outcome = await provisionSetupResources(
      TEST_USER_ID,
      [SHEET_RESOURCE],
      {},
      {},
      creator
    );

    expect(outcome.defaultInputs).toEqual({});
    expect(outcome.provisioning.spreadsheetId.status).toBe('failed');
    expect(outcome.provisioning.spreadsheetId.error).toContain(
      'sheets api 403'
    );
  });
});

describe('resolveSheetsCredentialId', () => {
  it('falls back to a derived-record parent covering GOOGLE_SHEETS_CRED', async () => {
    const [parent] = await db
      .insert(userCredentials)
      .values({
        userId: TEST_USER_ID,
        credentialType: 'GOOGLE_DRIVE_CRED',
        name: 'drive parent',
        isOauth: true,
        oauthProvider: 'google',
        oauthAccessToken: await CredentialEncryption.encrypt('drive-token'),
      })
      .returning({ id: userCredentials.id });
    await db.insert(derivedCredentials).values({
      userId: TEST_USER_ID,
      parentCredentialId: parent.id,
      derivedCredentialType: CredentialType.GOOGLE_SHEETS_CRED,
      provider: 'google',
    });

    const resolved = await resolveSheetsCredentialId(TEST_USER_ID);
    expect(resolved).toBe(parent.id);
  });
});

describe('buildSetupFieldDescriptors', () => {
  const INPUT_SCHEMA = {
    type: 'object',
    extendsEvent: 'webhook/http',
    properties: {
      spreadsheetId: {
        type: 'string',
        description: 'Google Sheets spreadsheet ID',
      },
      subreddit: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['spreadsheetId', 'subreddit'],
  };

  it('fills known values and lists unfilled required fields as missing', () => {
    const summary = buildSetupFieldDescriptors(INPUT_SCHEMA, {
      spreadsheetId: 'sheet-abc123',
    });

    expect(summary.fields).toEqual([
      {
        key: 'spreadsheetId',
        header: 'Spreadsheet Id',
        hint: 'Google Sheets spreadsheet ID',
        value: 'sheet-abc123',
      },
      { key: 'subreddit', header: 'Subreddit', hint: '' },
      { key: 'note', header: 'Note', hint: '' },
    ]);
    expect(summary.missingRequired.map((f) => f.key)).toEqual(['subreddit']);
  });

  it('handles an empty/absent schema', () => {
    expect(buildSetupFieldDescriptors({}, {})).toEqual({
      fields: [],
      missingRequired: [],
    });
    expect(buildSetupFieldDescriptors(null, {})).toEqual({
      fields: [],
      missingRequired: [],
    });
  });

  it('humanizes camelCase and snake_case keys', () => {
    expect(humanizeInputKey('spreadsheetId')).toBe('Spreadsheet Id');
    expect(humanizeInputKey('sheet_name')).toBe('Sheet Name');
    expect(humanizeInputKey('searchCriteria')).toBe('Search Criteria');
  });
});

describe('buildWorkflowDoneMessage', () => {
  const FILLED = {
    key: 'spreadsheetId',
    header: 'Spreadsheet Id',
    hint: 'Google Sheets spreadsheet ID',
    value: 'sheet-abc123',
  };
  const MISSING = { key: 'subreddit', header: 'Subreddit', hint: '' };

  it('emits the all-satisfied variant without fields', () => {
    const now = Date.now();
    const message = buildWorkflowDoneMessage(
      { fields: [FILLED], missingRequired: [] },
      now
    );

    expect(message.type).toBe('system');
    expect(message.role).toBe('system');
    expect(message.kind).toBe('workflow-done');
    expect(message.timestampMs).toBe(now);
    expect(message.text).toBe('Workflow done! Check it out now');
    expect(message.content).toBe(message.text!);
    expect(message.fields).toBeUndefined();
  });

  it('emits the needs-info variant with the FULL field list', () => {
    const now = Date.now();
    const message = buildWorkflowDoneMessage(
      { fields: [FILLED, MISSING], missingRequired: [MISSING] },
      now
    );

    expect(message.kind).toBe('workflow-done-needs-info');
    expect(message.timestampMs).toBe(now);
    expect(message.text).toBe(
      'Workflow done, but I still need some information'
    );
    expect(message.fields).toEqual([FILLED, MISSING]);
  });
});
