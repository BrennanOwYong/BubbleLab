/**
 * Doc-grounded per-operation side-effect metadata for the 'google-sheets' bubble (IR-8).
 *
 * HAND-AUTHORED mirroring google-drive.metadata.ts (the backfill script's curated
 * VENDOR_DOCS list does not cover google-sheets); every classification and scope set was
 * verified against the LIVE Google Sheets API method reference pages on 2026-07-23 — the
 * citation on each entry is the page checked. Regenerate via the backfill script only after
 * adding a google-sheets VENDOR_DOCS entry; review citations when the vendor API or the
 * bubble's operations change.
 *
 * Binding rule: 'write' iff the docs say the operation CREATES A NEW RECORD (even as a side
 * effect); 'read_with_side_effects' when the docs indicate mutation without record creation
 * (update/delete/clear — 'destructive' carries the delete signal); 'read' when the docs
 * indicate no mutation. The HTTP method is never the signal.
 *
 * ## References (Google Sheets API v4 method reference; verified 2026-07-23)
 * - values.get:        https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get
 * - values.update:     https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update
 * - values.append:     https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append
 * - values.clear:      https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/clear
 * - values.batchGet:   https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet
 * - values.batchUpdate: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate
 * - spreadsheets.get:  https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get
 * - spreadsheets.create: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create
 * - spreadsheets.batchUpdate: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate
 * - Add/DeleteSheetRequest: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request
 */
import type { BubbleOperationMetadata } from '@bubblelab/shared-schemas';

/** Read-method accepted scopes, exactly as the cited method pages list them. */
const SHEETS_READ_SCOPES = [
  'https://www.googleapis.com/auth/drive|https://www.googleapis.com/auth/drive.readonly|https://www.googleapis.com/auth/drive.file|https://www.googleapis.com/auth/spreadsheets|https://www.googleapis.com/auth/spreadsheets.readonly',
];

/** Mutating-method accepted scopes, exactly as the cited method pages list them. */
const SHEETS_WRITE_SCOPES = [
  'https://www.googleapis.com/auth/drive|https://www.googleapis.com/auth/drive.file|https://www.googleapis.com/auth/spreadsheets',
];

export const GOOGLE_SHEETS_OPERATION_METADATA: BubbleOperationMetadata = {
  read_values: {
    sideEffect: 'read',
    destructive: false,
    idempotent: true,
    confidence: 0.6,
    source: 'prose',
    citation:
      'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get — "Returns a range of values from a spreadsheet."',
    requiredScopes: SHEETS_READ_SCOPES,
  },
  write_values: {
    sideEffect: 'read_with_side_effects',
    destructive: false,
    idempotent: true,
    confidence: 0.6,
    source: 'prose',
    citation:
      'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update — "Sets values in a range of a spreadsheet."',
    requiredScopes: SHEETS_WRITE_SCOPES,
  },
  update_values: {
    sideEffect: 'read_with_side_effects',
    destructive: false,
    idempotent: true,
    confidence: 0.6,
    source: 'prose',
    citation:
      'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update — "Sets values in a range of a spreadsheet."',
    requiredScopes: SHEETS_WRITE_SCOPES,
  },
  append_values: {
    sideEffect: 'write',
    destructive: false,
    idempotent: false,
    confidence: 0.6,
    source: 'prose',
    citation:
      'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append — "Appends values to a spreadsheet." (new rows are created after the found table)',
    requiredScopes: SHEETS_WRITE_SCOPES,
  },
  clear_values: {
    sideEffect: 'read_with_side_effects',
    destructive: true,
    idempotent: true,
    confidence: 0.6,
    source: 'prose',
    citation:
      'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/clear — "Clears values from a spreadsheet. ... Only values are cleared -- all other properties of the cell (such as formatting, data validation, etc..) are kept."',
    requiredScopes: SHEETS_WRITE_SCOPES,
  },
  batch_read_values: {
    sideEffect: 'read',
    destructive: false,
    idempotent: true,
    confidence: 0.6,
    source: 'prose',
    citation:
      'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet — "Returns one or more ranges of values from a spreadsheet."',
    requiredScopes: SHEETS_READ_SCOPES,
  },
  batch_update_values: {
    sideEffect: 'read_with_side_effects',
    destructive: false,
    idempotent: true,
    confidence: 0.6,
    source: 'prose',
    citation:
      'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate — "Sets values in one or more ranges of a spreadsheet."',
    requiredScopes: SHEETS_WRITE_SCOPES,
  },
  get_spreadsheet_info: {
    sideEffect: 'read',
    destructive: false,
    idempotent: true,
    confidence: 0.6,
    source: 'prose',
    citation:
      'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get — "Returns the spreadsheet at the given ID."',
    requiredScopes: SHEETS_READ_SCOPES,
  },
  create_spreadsheet: {
    sideEffect: 'write',
    destructive: false,
    idempotent: false,
    confidence: 0.6,
    source: 'prose',
    citation:
      'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create — "Creates a spreadsheet, returning the newly created spreadsheet."',
    requiredScopes: SHEETS_WRITE_SCOPES,
  },
  add_sheet: {
    sideEffect: 'write',
    destructive: false,
    idempotent: false,
    confidence: 0.6,
    source: 'prose',
    citation:
      'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#AddSheetRequest — "Adds a new sheet." (issued via spreadsheets.batchUpdate — "Applies one or more updates to the spreadsheet.")',
    requiredScopes: SHEETS_WRITE_SCOPES,
  },
  delete_sheet: {
    sideEffect: 'read_with_side_effects',
    destructive: true,
    idempotent: true,
    confidence: 0.6,
    source: 'prose',
    citation:
      'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#DeleteSheetRequest — "Deletes the requested sheet." (issued via spreadsheets.batchUpdate — "Applies one or more updates to the spreadsheet.")',
    requiredScopes: SHEETS_WRITE_SCOPES,
  },
};
