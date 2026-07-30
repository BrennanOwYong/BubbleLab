/**
 * Page data plane: resolves a stored page spec against the user's real
 * integrations and performs its write action.
 *
 * Reads and writes ride the EXISTING bubble/flow rails — each one is a
 * minimal BubbleFlow (GoogleSheetsBubble read_values / append_values)
 * executed through POST /bubble-flow/generate/run-context-flow with the
 * user's connected credential, exactly like provision.ts. No new integration
 * layer.
 *
 * Gotcha (memory codegen-death-spiral-forensics / phase4): union-typed array
 * fields in a run-context-flow Output interface fail the build, so the read
 * flow returns its values as a JSON.stringify'd string.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { GluuClient } from './gluu-client.ts';
import { pickSheetsCredential } from './provision.ts';
import {
  pageSpecSchema,
  type FormWidget,
  type PageSpec,
  type SheetRangeSource,
  type Widget,
} from './page-spec.ts';
import { db, pages, type PageRow } from './db.ts';

// ---------------------------------------------------------------------------
// Sheet read / append over run-context-flow
// ---------------------------------------------------------------------------

function buildReadRangeFlowCode(spreadsheetId: string, range: string): string {
  return `import type { BubbleTriggerEventRegistry } from '@bubblelab/bubble-core';
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';

export interface Output {
  success: boolean;
  valuesJson: string;
  range: string;
  error: string;
}

export class ReadRangeFlow extends BubbleFlow<'webhook/http'> {
  constructor() {
    super('read-range-flow', 'Reads values from a spreadsheet range');
  }

  private async read(): Promise<Output> {
    const result = await new GoogleSheetsBubble({
      operation: 'read_values',
      spreadsheet_id: ${JSON.stringify(spreadsheetId)},
      range: ${JSON.stringify(range)},
    }).action();
    return {
      success: result.success === true,
      valuesJson: JSON.stringify(result.data?.values ?? []),
      range: result.data?.range ?? '',
      error: result.error ?? '',
    };
  }

  async handle(
    payload: BubbleTriggerEventRegistry['webhook/http']
  ): Promise<Output> {
    return this.read();
  }
}
`;
}

function buildAppendRowFlowCode(
  spreadsheetId: string,
  range: string,
  row: string[]
): string {
  return `import type { BubbleTriggerEventRegistry } from '@bubblelab/bubble-core';
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';

export interface Output {
  success: boolean;
  updatedRange: string;
  updatedRows: number;
  error: string;
}

export class AppendRowFlow extends BubbleFlow<'webhook/http'> {
  constructor() {
    super('append-row-flow', 'Appends one row to a spreadsheet table');
  }

  private async append(): Promise<Output> {
    const result = await new GoogleSheetsBubble({
      operation: 'append_values',
      spreadsheet_id: ${JSON.stringify(spreadsheetId)},
      range: ${JSON.stringify(range)},
      values: ${JSON.stringify([row])},
    }).action();
    return {
      success: result.success === true,
      updatedRange: result.data?.updated_range ?? '',
      updatedRows: result.data?.updated_rows ?? 0,
      error: result.error ?? '',
    };
  }

  async handle(
    payload: BubbleTriggerEventRegistry['webhook/http']
  ): Promise<Output> {
    return this.append();
  }
}
`;
}

const readOutputSchema = z.object({
  success: z.boolean(),
  valuesJson: z.string(),
  range: z.string(),
  error: z.string(),
});

const appendOutputSchema = z.object({
  success: z.boolean(),
  updatedRange: z.string(),
  updatedRows: z.number(),
  error: z.string(),
});

const cellSchema = z.union([z.string(), z.number(), z.boolean()]);
const valuesSchema = z.array(z.array(cellSchema));
export type SheetCell = z.infer<typeof cellSchema>;

async function requireSheetsCredentialId(client: GluuClient): Promise<number> {
  const credential = pickSheetsCredential(await client.listCredentials());
  if (!credential) {
    throw new Error(
      'No connected credential covers Google Sheets (need GOOGLE_SHEETS_CRED or a Google OAuth credential granting the spreadsheets scope). Connect one in the Gluu studio first.'
    );
  }
  return credential.id;
}

export async function readSheetRange(
  client: GluuClient,
  source: SheetRangeSource
): Promise<{ values: SheetCell[][]; range: string }> {
  const credentialId = await requireSheetsCredentialId(client);
  const execution = await client.runContextFlow(
    buildReadRangeFlowCode(source.spreadsheetId, source.range),
    { GOOGLE_SHEETS_CRED: credentialId }
  );
  if (!execution.success) {
    throw new Error(`Sheet read failed: ${execution.error ?? 'unknown error'}`);
  }
  const output = readOutputSchema.parse(execution.result);
  if (!output.success) {
    throw new Error(`read_values failed: ${output.error || 'unknown'}`);
  }
  return {
    values: valuesSchema.parse(JSON.parse(output.valuesJson)),
    range: output.range,
  };
}

export async function appendSheetRow(
  client: GluuClient,
  target: { spreadsheetId: string; range: string },
  row: string[]
): Promise<{ updatedRange: string; updatedRows: number }> {
  const credentialId = await requireSheetsCredentialId(client);
  const execution = await client.runContextFlow(
    buildAppendRowFlowCode(target.spreadsheetId, target.range, row),
    { GOOGLE_SHEETS_CRED: credentialId }
  );
  if (!execution.success) {
    throw new Error(
      `Sheet append failed: ${execution.error ?? 'unknown error'}`
    );
  }
  const output = appendOutputSchema.parse(execution.result);
  if (!output.success) {
    throw new Error(`append_values failed: ${output.error || 'unknown'}`);
  }
  return { updatedRange: output.updatedRange, updatedRows: output.updatedRows };
}

// ---------------------------------------------------------------------------
// Page row access + render / submit
// ---------------------------------------------------------------------------

export async function getPageRow(pageId: number): Promise<PageRow | null> {
  const rows = await db
    .select()
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  return rows[0] ?? null;
}

export function parseStoredSpec(row: PageRow): PageSpec | null {
  if (row.spec === null || row.spec === undefined) return null;
  const parsed = pageSpecSchema.safeParse(row.spec);
  return parsed.success ? parsed.data : null;
}

/** Per-widget resolved data; errors are contained per widget so one broken
 * binding never blanks the whole page. */
export type WidgetData =
  | { kind: 'table'; header: string[] | null; rows: SheetCell[][] }
  | { kind: 'metric'; value: number }
  | { kind: 'form' }
  | { kind: 'error'; message: string };

export interface RenderedWidget {
  widget: Widget;
  data: WidgetData;
}

export interface RenderedPage {
  pageId: number;
  title: string;
  status: string;
  spec: PageSpec;
  widgets: RenderedWidget[];
}

async function resolveWidget(
  client: GluuClient,
  widget: Widget
): Promise<WidgetData> {
  try {
    switch (widget.type) {
      case 'table': {
        const { values } = await readSheetRange(client, widget.source);
        const header = widget.headerRow ? (values[0] ?? []).map(String) : null;
        const dataRows = widget.headerRow ? values.slice(1) : values;
        return {
          kind: 'table',
          header,
          rows: dataRows.slice(-widget.maxRows),
        };
      }
      case 'metric': {
        const { values } = await readSheetRange(client, widget.source);
        const count = widget.excludeHeaderRow
          ? Math.max(0, values.length - 1)
          : values.length;
        return { kind: 'metric', value: count };
      }
      case 'form':
        return { kind: 'form' };
    }
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Load a page and resolve every read widget's live data server-side (the
 * GET /page/:pageId/render contract). Reads run sequentially — the Bun API's
 * run-context-flow path is the bottleneck and page specs are small.
 */
export async function renderPage(
  client: GluuClient,
  pageId: number
): Promise<RenderedPage> {
  const row = await getPageRow(pageId);
  if (row === null) throw new Error(`Page ${pageId} not found`);
  const spec = parseStoredSpec(row);
  if (spec === null) {
    throw new Error(
      `Page ${pageId} has no valid spec yet (status: ${row.status})`
    );
  }
  const widgets: RenderedWidget[] = [];
  for (const widget of spec.widgets) {
    widgets.push({ widget, data: await resolveWidget(client, widget) });
  }
  return { pageId, title: row.title, status: row.status, spec, widgets };
}

/**
 * Execute a form widget's write action: order the submitted values by the
 * widget's field order and append them as one row across the integration.
 */
export async function submitPageForm(
  client: GluuClient,
  pageId: number,
  widgetId: string,
  values: Record<string, string>
): Promise<{ updatedRange: string; updatedRows: number; row: string[] }> {
  const row = await getPageRow(pageId);
  if (row === null) throw new Error(`Page ${pageId} not found`);
  const spec = parseStoredSpec(row);
  if (spec === null) throw new Error(`Page ${pageId} has no valid spec`);
  const widget = spec.widgets.find(
    (w): w is FormWidget => w.type === 'form' && w.id === widgetId
  );
  if (widget === undefined) {
    throw new Error(`Page ${pageId} has no form widget '${widgetId}'`);
  }
  const rowValues = widget.fields.map((field) => values[field.name] ?? '');
  const result = await appendSheetRow(client, widget.target, rowValues);
  return { ...result, row: rowValues };
}
