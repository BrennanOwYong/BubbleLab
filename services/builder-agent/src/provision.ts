/**
 * Spreadsheet provisioning over the Gluu API's real execution path.
 *
 * Gluu has no standalone provisioning endpoint: setup provisioning normally
 * runs inside POST /bubble-flow/generate (services/setup-provisioning.ts,
 * triggered by plan.setupResources). The closest standalone real path is
 * POST /bubble-flow/generate/run-context-flow, which validates and executes a
 * BubbleFlow immediately with explicit credential ids — the same
 * GoogleSheetsBubble create_spreadsheet operation setup provisioning reuses,
 * driven through the API instead of reimplemented here.
 */
import { z } from 'zod';
import type { Credential, GluuClient } from './gluu-client.ts';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * Mirror of the server's resolveSheetsCredentialId recency rule
 * (services/setup-provisioning.ts): exact GOOGLE_SHEETS_CRED first, else the
 * most recently connected Google OAuth credential whose granted scopes cover
 * Sheets (the client-side approximation of the derived-credentials table).
 */
export function pickSheetsCredential(
  credentials: Credential[]
): Credential | undefined {
  const byRecency = (a: Credential, b: Credential) =>
    b.createdAt.localeCompare(a.createdAt) || b.id - a.id;
  const exact = credentials
    .filter((c) => c.credentialType === 'GOOGLE_SHEETS_CRED')
    .sort(byRecency);
  if (exact[0]) return exact[0];
  return credentials
    .filter(
      (c) =>
        c.isOauth === true &&
        c.oauthProvider === 'google' &&
        (c.oauthScopes ?? []).includes(SHEETS_SCOPE)
    )
    .sort(byRecency)[0];
}

/**
 * Minimal BubbleFlow that runs GoogleSheetsBubble create_spreadsheet and
 * returns the created ids. Shape follows the repo's valid-flow fixtures
 * (apps/bubblelab-api/src/test/fixtures/bubble-flows.ts). The bubble is
 * instantiated in a helper step, not in handle — direct instantiation in
 * handle is a lint violation (no-direct-instantiation-in-handle rule).
 */
export function buildProvisionFlowCode(title: string, tabs?: string[]): string {
  const sheetTitlesLine =
    tabs && tabs.length > 0
      ? `      sheet_titles: ${JSON.stringify(tabs)},\n`
      : '';
  return `import type { BubbleTriggerEventRegistry } from '@bubblelab/bubble-core';
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';

export interface Output {
  success: boolean;
  spreadsheetId: string;
  spreadsheetUrl: string;
  error: string;
}

export class ProvisionSpreadsheetFlow extends BubbleFlow<'webhook/http'> {
  constructor() {
    super('provision-spreadsheet-flow', 'Creates a Google spreadsheet');
  }

  private async createSpreadsheet(): Promise<Output> {
    const result = await new GoogleSheetsBubble({
      operation: 'create_spreadsheet',
      title: ${JSON.stringify(title)},
${sheetTitlesLine}    }).action();
    const spreadsheet = result.data?.spreadsheet;
    return {
      success: result.success === true && Boolean(spreadsheet?.spreadsheetId),
      spreadsheetId: spreadsheet?.spreadsheetId ?? '',
      spreadsheetUrl: spreadsheet?.spreadsheetUrl ?? '',
      error: result.error ?? '',
    };
  }

  async handle(
    payload: BubbleTriggerEventRegistry['webhook/http']
  ): Promise<Output> {
    return this.createSpreadsheet();
  }
}
`;
}

const provisionOutputSchema = z.object({
  success: z.boolean(),
  spreadsheetId: z.string(),
  spreadsheetUrl: z.string(),
  error: z.string(),
});

/**
 * Minimal BubbleFlow that seeds reference rows into one tab of an existing
 * spreadsheet: clear_values on the whole tab, then write_values at
 * `${tabName}!A1`. Clear-then-write is the idempotency mechanism — re-running
 * the seed never duplicates rows. Operations and result fields follow
 * packages/bubble-core/.../google-sheets/google-sheets.schema.ts.
 */
export function buildSeedRowsFlowCode(
  spreadsheetId: string,
  tabName: string,
  rows: string[][]
): string {
  return `import type { BubbleTriggerEventRegistry } from '@bubblelab/bubble-core';
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';

export interface Output {
  success: boolean;
  clearedRange: string;
  updatedRange: string;
  updatedRows: number;
  error: string;
}

export class SeedRowsFlow extends BubbleFlow<'webhook/http'> {
  constructor() {
    super('seed-rows-flow', 'Seeds reference rows into a spreadsheet tab');
  }

  private async seed(): Promise<Output> {
    const cleared = await new GoogleSheetsBubble({
      operation: 'clear_values',
      spreadsheet_id: ${JSON.stringify(spreadsheetId)},
      range: ${JSON.stringify(tabName)},
    }).action();
    if (cleared.success !== true) {
      return {
        success: false,
        clearedRange: '',
        updatedRange: '',
        updatedRows: 0,
        error: 'clear_values failed: ' + (cleared.error ?? 'unknown'),
      };
    }
    const written = await new GoogleSheetsBubble({
      operation: 'write_values',
      spreadsheet_id: ${JSON.stringify(spreadsheetId)},
      range: ${JSON.stringify(`${tabName}!A1`)},
      values: ${JSON.stringify(rows)},
    }).action();
    return {
      success: written.success === true,
      clearedRange: cleared.data?.cleared_range ?? '',
      updatedRange: written.data?.updated_range ?? '',
      updatedRows: written.data?.updated_rows ?? 0,
      error: written.error ?? '',
    };
  }

  async handle(
    payload: BubbleTriggerEventRegistry['webhook/http']
  ): Promise<Output> {
    return this.seed();
  }
}
`;
}

const seedRowsOutputSchema = z.object({
  success: z.boolean(),
  clearedRange: z.string(),
  updatedRange: z.string(),
  updatedRows: z.number(),
  error: z.string(),
});

export interface SeededRows {
  spreadsheetId: string;
  tabName: string;
  rowCount: number;
  clearedRange: string;
  updatedRange: string;
  credentialId: number;
  credentialType: string;
}

export async function seedRows(
  client: GluuClient,
  spreadsheetId: string,
  tabName: string,
  rows: string[][]
): Promise<SeededRows> {
  const credentials = await client.listCredentials();
  const credential = pickSheetsCredential(credentials);
  if (!credential) {
    throw new Error(
      'No connected credential covers Google Sheets (need GOOGLE_SHEETS_CRED or a Google OAuth credential granting the spreadsheets scope). Connect one in the Gluu studio first.'
    );
  }
  const flowCode = buildSeedRowsFlowCode(spreadsheetId, tabName, rows);
  const execution = await client.runContextFlow(flowCode, {
    GOOGLE_SHEETS_CRED: credential.id,
  });
  if (!execution.success) {
    throw new Error(
      `Row-seeding flow failed: ${execution.error ?? 'unknown error'}`
    );
  }
  const output = seedRowsOutputSchema.parse(execution.result);
  if (!output.success) {
    throw new Error(`seed_rows did not complete: ${output.error || 'unknown'}`);
  }
  return {
    spreadsheetId,
    tabName,
    rowCount: rows.length,
    clearedRange: output.clearedRange,
    updatedRange: output.updatedRange,
    credentialId: credential.id,
    credentialType: credential.credentialType,
  };
}

export interface ProvisionedSpreadsheet {
  spreadsheetId: string;
  spreadsheetUrl: string;
  credentialId: number;
  credentialType: string;
}

export async function provisionSpreadsheet(
  client: GluuClient,
  title: string,
  tabs?: string[]
): Promise<ProvisionedSpreadsheet> {
  const credentials = await client.listCredentials();
  const credential = pickSheetsCredential(credentials);
  if (!credential) {
    throw new Error(
      'No connected credential covers Google Sheets (need GOOGLE_SHEETS_CRED or a Google OAuth credential granting the spreadsheets scope). Connect one in the Gluu studio first.'
    );
  }
  const flowCode = buildProvisionFlowCode(title, tabs);
  const execution = await client.runContextFlow(flowCode, {
    GOOGLE_SHEETS_CRED: credential.id,
  });
  if (!execution.success) {
    throw new Error(
      `Spreadsheet provisioning flow failed: ${execution.error ?? 'unknown error'}`
    );
  }
  const output = provisionOutputSchema.parse(execution.result);
  if (!output.success || output.spreadsheetId === '') {
    throw new Error(
      `create_spreadsheet did not return an id: ${output.error || 'unknown error'}`
    );
  }
  return {
    spreadsheetId: output.spreadsheetId,
    spreadsheetUrl: output.spreadsheetUrl,
    credentialId: credential.id,
    credentialType: credential.credentialType,
  };
}
