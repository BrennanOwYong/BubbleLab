/**
 * The page spec: the single structured shape a "page" is persisted as
 * (pages.spec jsonb). A page is NEVER free-form generated code — it is this
 * spec, interpreted server-side (render/submit in page-data.ts) and by the
 * studio's PageView. That keeps pages clean DB items and keeps the data plane
 * on the existing bubble/flow rails.
 *
 * Widget kinds (MVP):
 * - table  — READ: rows from a bound source, rendered as a table.
 * - metric — READ: one number derived from a bound source (count_rows).
 * - form   — WRITE: named fields submitted as one appended row to a target.
 *
 * Sources/targets are discriminated unions on `kind`, so future bindings
 * (gmail_query, notion_db, ...) slot in without reshaping stored specs.
 */
import { z } from 'zod';

export const sheetRangeSourceSchema = z.object({
  kind: z.literal('google_sheet_range'),
  spreadsheetId: z.string().min(1),
  range: z
    .string()
    .min(1)
    .describe(
      'A1-notation range or bare tab name, e.g. "Feedback" or "Feedback!A1:C50"'
    ),
});
export type SheetRangeSource = z.infer<typeof sheetRangeSourceSchema>;

export const sheetAppendTargetSchema = z.object({
  kind: z.literal('google_sheet_append'),
  spreadsheetId: z.string().min(1),
  range: z
    .string()
    .min(1)
    .describe(
      'Tab name (or A1 range) whose table the submitted row is appended to'
    ),
});
export type SheetAppendTarget = z.infer<typeof sheetAppendTargetSchema>;

// One source union / one target union today; extend both here when new
// integrations join the render path.
export const widgetSourceSchema = z.discriminatedUnion('kind', [
  sheetRangeSourceSchema,
]);
export type WidgetSource = z.infer<typeof widgetSourceSchema>;

export const widgetTargetSchema = z.discriminatedUnion('kind', [
  sheetAppendTargetSchema,
]);
export type WidgetTarget = z.infer<typeof widgetTargetSchema>;

export const tableWidgetSchema = z.object({
  id: z.string().min(1),
  type: z.literal('table'),
  title: z.string().min(1),
  source: widgetSourceSchema,
  headerRow: z
    .boolean()
    .default(true)
    .describe('Row 0 of the source is a header row, rendered as column names'),
  maxRows: z
    .number()
    .int()
    .positive()
    .max(200)
    .default(50)
    .describe('Cap on data rows returned to the client, newest last'),
});
export type TableWidget = z.infer<typeof tableWidgetSchema>;

export const metricWidgetSchema = z.object({
  id: z.string().min(1),
  type: z.literal('metric'),
  title: z.string().min(1),
  source: widgetSourceSchema,
  aggregate: z.literal('count_rows'),
  excludeHeaderRow: z
    .boolean()
    .default(true)
    .describe('Subtract the header row from the count'),
});
export type MetricWidget = z.infer<typeof metricWidgetSchema>;

export const formFieldSchema = z.object({
  name: z.string().min(1).describe('Column this field maps to, in row order'),
  label: z.string().min(1),
  placeholder: z.string().optional(),
});

export const formWidgetSchema = z.object({
  id: z.string().min(1),
  type: z.literal('form'),
  title: z.string().min(1),
  target: widgetTargetSchema,
  fields: z
    .array(formFieldSchema)
    .min(1)
    .describe(
      'Ordered fields; a submit appends one row with the field values in this order'
    ),
  submitLabel: z.string().default('Submit'),
});
export type FormWidget = z.infer<typeof formWidgetSchema>;

export const widgetSchema = z.discriminatedUnion('type', [
  tableWidgetSchema,
  metricWidgetSchema,
  formWidgetSchema,
]);
export type Widget = z.infer<typeof widgetSchema>;

export const pageSpecSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  description: z.string().optional(),
  widgets: z
    .array(widgetSchema)
    .min(1)
    .superRefine((widgets, ctx) => {
      const seen = new Set<string>();
      for (const widget of widgets) {
        if (seen.has(widget.id)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate widget id '${widget.id}'`,
          });
        }
        seen.add(widget.id);
      }
    }),
});
export type PageSpec = z.infer<typeof pageSpecSchema>;
