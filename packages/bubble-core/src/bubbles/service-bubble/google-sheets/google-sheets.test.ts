import { describe, it, expect, vi, afterEach } from 'vitest';
import { CredentialType } from '@bubblelab/shared-schemas';
import { GoogleSheetsBubble } from './google-sheets';
import {
  GoogleSheetsParamsSchema,
  GoogleSheetsResultSchema,
  ValueRangeSchema,
} from './google-sheets.schema';
import {
  normalizeRange,
  validateAndNormalizeRange,
} from './google-sheets.utils';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('GoogleSheetsBubble', () => {
  it('should be defined', () => {
    new GoogleSheetsBubble({
      operation: 'batch_read_values',
      spreadsheet_id: '1234567890',
      ranges: ['Sheet1!A1:B10', 'Sheet2!A1:B10'],
    });
    expect(GoogleSheetsBubble).toBeDefined();
  });

  it('should not produce errors when using the bubble', async () => {
    // No compiler errors should be thrown
    await new GoogleSheetsBubble({
      operation: 'append_values',
      spreadsheet_id: '1234567890',
      range: 'Sheet1!A1:B10',
      values: [
        ['Value1', 'Value2'],
        ['Value3', 'Value4'],
      ],
    }).action();
  });

  describe('Range Normalization', () => {
    it('should automatically quote sheet names with spaces', () => {
      const params = {
        operation: 'read_values' as const,
        spreadsheet_id: '1234567890',
        range: 'Kaus Mode Landing zone!A:G', // No quotes, has spaces
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'read_values') {
        expect(result.range).toBe("'Kaus Mode Landing zone'!A:G");
      }
    });

    it('should not modify already quoted sheet names', () => {
      const params = {
        operation: 'read_values' as const,
        spreadsheet_id: '1234567890',
        range: "'Sheet Name'!A1:B10", // Already quoted
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'read_values') {
        expect(result.range).toBe("'Sheet Name'!A1:B10");
      }
    });

    it('should not modify sheet names without spaces', () => {
      const params = {
        operation: 'read_values' as const,
        spreadsheet_id: '1234567890',
        range: 'Sheet1!A1:B10', // No spaces, no quotes needed
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'read_values') {
        expect(result.range).toBe('Sheet1!A1:B10');
      }
    });

    it('should normalize ranges in batch operations', () => {
      const params = {
        operation: 'batch_read_values' as const,
        spreadsheet_id: '1234567890',
        ranges: [
          'Sheet1!A1:B10', // No spaces
          'My Data Sheet!A:G', // Has spaces - should be quoted
          "'Already Quoted'!C1:D5", // Already quoted
        ],
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'batch_read_values') {
        expect(result.ranges[0]).toBe('Sheet1!A1:B10');
        expect(result.ranges[1]).toBe("'My Data Sheet'!A:G");
        expect(result.ranges[2]).toBe("'Already Quoted'!C1:D5");
      }
    });

    it('should escape single quotes in sheet names', () => {
      const params = {
        operation: 'read_values' as const,
        spreadsheet_id: '1234567890',
        range: "O'Brien's Data!A1:B10", // Contains single quotes
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'read_values') {
        expect(result.range).toBe("'O''Brien''s Data'!A1:B10");
      }
    });

    it('should fix improperly escaped quoted sheet names', () => {
      // Edge case: already quoted but internal quotes not escaped
      const params = {
        operation: 'read_values' as const,
        spreadsheet_id: '1234567890',
        range: "'O'Brien's Data'!A1:B10", // Quoted but not properly escaped
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'read_values') {
        expect(result.range).toBe("'O''Brien''s Data'!A1:B10");
      }
    });

    it('should not double-escape already properly escaped sheet names', () => {
      const params = {
        operation: 'read_values' as const,
        spreadsheet_id: '1234567890',
        range: "'O''Brien''s Data'!A1:B10", // Already properly escaped
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'read_values') {
        // Should remain unchanged - already properly escaped
        expect(result.range).toBe("'O''Brien''s Data'!A1:B10");
      }
    });
  });

  describe('Value Sanitization', () => {
    it('should convert null values to empty strings', () => {
      const params = {
        operation: 'update_values' as const,
        spreadsheet_id: '1234567890',
        range: 'Sheet1!A1',
        values: [
          ['Vendor', 'Date', 'Amount', 'Description'],
          ['Vercel', null, '100', null], // null values
        ],
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'update_values') {
        expect(result.values[0]).toEqual([
          'Vendor',
          'Date',
          'Amount',
          'Description',
        ]);
        expect(result.values[1]).toEqual(['Vercel', '', '100', '']); // null converted to ''
      }
    });

    it('should convert undefined values to empty strings', () => {
      const params = {
        operation: 'write_values' as const,
        spreadsheet_id: '1234567890',
        range: 'Sheet1!A1',
        values: [
          ['Name', 'Email'],
          ['John', undefined], // undefined value
        ],
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'write_values') {
        expect(result.values[1]).toEqual(['John', '']); // undefined converted to ''
      }
    });

    it('should handle mixed null/undefined/valid values', () => {
      const params = {
        operation: 'append_values' as const,
        spreadsheet_id: '1234567890',
        range: 'Sheet1!A:A',
        values: [
          ['Vendor', null, 'Amount', undefined, 'Status'],
          ['AWS', '2024-01-01', null, true, undefined],
        ],
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'append_values') {
        expect(result.values[0]).toEqual([
          'Vendor',
          '',
          'Amount',
          '',
          'Status',
        ]);
        expect(result.values[1]).toEqual(['AWS', '2024-01-01', '', true, '']);
      }
    });

    it('should convert Date objects to ISO strings', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const params = {
        operation: 'update_values' as const,
        spreadsheet_id: '1234567890',
        range: 'Sheet1!A1',
        values: [
          ['Name', 'Created'],
          ['Test', date], // Date object
        ],
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'update_values') {
        expect(result.values[1][0]).toBe('Test');
        expect(result.values[1][1]).toBe(date.toISOString());
      }
    });

    it('should preserve valid string, number, and boolean values', () => {
      const params = {
        operation: 'write_values' as const,
        spreadsheet_id: '1234567890',
        range: 'Sheet1!A1',
        values: [['Text', 123, true, 'More Text']],
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'write_values') {
        expect(result.values[0]).toEqual(['Text', 123, true, 'More Text']);
      }
    });
  });

  describe('Range Validation', () => {
    it('should validate simple cell references', () => {
      expect(validateAndNormalizeRange('A1')).toBe('A1');
      expect(validateAndNormalizeRange('Z100')).toBe('Z100');
    });

    it('should validate range references', () => {
      expect(validateAndNormalizeRange('A1:B10')).toBe('A1:B10');
      expect(validateAndNormalizeRange('A:G')).toBe('A:G');
    });

    it('should validate ranges with unquoted sheet names', () => {
      expect(validateAndNormalizeRange('Sheet1!A1:B10')).toBe('Sheet1!A1:B10');
    });

    it('should validate ranges with quoted sheet names', () => {
      expect(validateAndNormalizeRange("'Sheet Name'!A1:B10")).toBe(
        "'Sheet Name'!A1:B10"
      );
      expect(validateAndNormalizeRange("'My Data'!A:G")).toBe("'My Data'!A:G");
    });

    it('should normalize and validate ranges with spaces in sheet names', () => {
      expect(validateAndNormalizeRange('Sheet With Spaces!A1:B10')).toBe(
        "'Sheet With Spaces'!A1:B10"
      );
    });
  });

  describe('normalizeRange utility', () => {
    it('should handle sheet names with single quotes', () => {
      expect(normalizeRange("O'Brien's Data!A1")).toBe("'O''Brien''s Data'!A1");
    });

    it('should fix improperly quoted sheet names with unescaped quotes', () => {
      expect(normalizeRange("'O'Brien's Data'!A1")).toBe(
        "'O''Brien''s Data'!A1"
      );
    });

    it('should not modify properly escaped quoted sheet names', () => {
      expect(normalizeRange("'O''Brien''s Data'!A1")).toBe(
        "'O''Brien''s Data'!A1"
      );
    });

    it('should return ranges without sheet names unchanged', () => {
      expect(normalizeRange('A1:B10')).toBe('A1:B10');
    });
  });

  describe('Empty-range handling (Sheets API omits `values` for empty ranges)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('batch_read_values returns [] for a range whose valueRange has no values key, no throw', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          spreadsheetId: 'sheet-1',
          valueRanges: [
            {
              range: 'Data!A1:B2',
              majorDimension: 'ROWS',
              values: [['a', 'b']],
            },
            // Empty tab: the API omits `values` entirely
            { range: 'EmptyTab!A1:B2', majorDimension: 'ROWS' },
          ],
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await new GoogleSheetsBubble({
        operation: 'batch_read_values',
        spreadsheet_id: 'sheet-1',
        ranges: ['Data!A1:B2', 'EmptyTab!A1:B2'],
        credentials: { [CredentialType.GOOGLE_SHEETS_CRED]: 'test-token' },
      }).action();

      expect(result.success).toBe(true);
      expect(result.data?.value_ranges).toEqual([
        { range: 'Data!A1:B2', majorDimension: 'ROWS', values: [['a', 'b']] },
        { range: 'EmptyTab!A1:B2', majorDimension: 'ROWS', values: [] },
      ]);
    });

    it('ValueRangeSchema defaults a missing values key to []', () => {
      const parsed = ValueRangeSchema.parse({ range: 'EmptyTab!A1:B2' });
      expect(parsed.values).toEqual([]);
    });

    it('update_values result validates when updatedData carries no values key (all-empty write)', () => {
      const parsed = GoogleSheetsResultSchema.parse({
        operation: 'update_values',
        success: true,
        updated_range: 'Sheet1!A1:B2',
        updated_rows: 2,
        updated_columns: 2,
        updated_cells: 4,
        updated_data: { range: 'Sheet1!A1:B2', majorDimension: 'ROWS' },
        error: '',
      });
      if (parsed.operation === 'update_values') {
        expect(parsed.updated_data?.values).toEqual([]);
      }
    });
  });

  describe('testCredential scope check', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const bubbleWithCred = () =>
      new GoogleSheetsBubble({
        operation: 'read_values',
        spreadsheet_id: 'sheet-1',
        range: 'Sheet1!A1:B2',
        credentials: { [CredentialType.GOOGLE_SHEETS_CRED]: 'test-token' },
      });

    it('rejects a live token whose granted scopes exclude Sheets (e.g. Gmail-only)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse({
            scope:
              'openid email https://www.googleapis.com/auth/gmail.readonly',
          })
        )
      );
      await expect(bubbleWithCred().testCredential()).rejects.toThrow(
        /no Google Sheets scope/
      );
    });

    it('accepts a token granted the spreadsheets scope', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse({
            scope: 'https://www.googleapis.com/auth/spreadsheets',
          })
        )
      );
      await expect(bubbleWithCred().testCredential()).resolves.toBe(true);
    });

    it('accepts a token granted a Drive scope (Sheets API accepts drive scopes)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse({ scope: 'https://www.googleapis.com/auth/drive.file' })
        )
      );
      await expect(bubbleWithCred().testCredential()).resolves.toBe(true);
    });

    it('keeps the HTTP-200 pass when tokeninfo carries no scope field', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ aud: 'client-id', exp: '9999999999' }))
      );
      await expect(bubbleWithCred().testCredential()).resolves.toBe(true);
    });
  });

  describe('Combined Edge Cases', () => {
    it('should handle range normalization and value sanitization together', () => {
      const params = {
        operation: 'update_values' as const,
        spreadsheet_id: '1234567890',
        range: 'My Data Sheet!A1', // Sheet name with spaces
        values: [
          ['Vendor', 'Date', 'Amount'],
          ['Vercel', null, 100],
          ['AWS', undefined, 200],
        ],
      };

      const result = GoogleSheetsParamsSchema.parse(params);
      if (result.operation === 'update_values') {
        expect(result.range).toBe("'My Data Sheet'!A1");
        expect(result.values[0]).toEqual(['Vendor', 'Date', 'Amount']);
        expect(result.values[1]).toEqual(['Vercel', '', 100]);
        expect(result.values[2]).toEqual(['AWS', '', 200]);
      }
    });
  });
});
