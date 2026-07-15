import { describe, it, expect } from 'vitest';
import {
  classifySideEffect,
  classifyFromOpenApi,
  classifyFromMcpAnnotations,
  classifyFromDocText,
  classifyFromManual,
  extractDocSignals,
  ClassificationError,
} from './side-effect-classifier.js';
import { OperationSideEffectMetadataSchema } from '@bubblelab/shared-schemas';

describe('side-effect classifier — the HTTP method is never the signal', () => {
  it('classifies a POST that only reads as read (acceptance criterion)', () => {
    // Real-world shape: Notion's POST /v1/databases/{id}/query is a query endpoint.
    const result = classifyFromOpenApi({
      kind: 'openapi',
      method: 'POST',
      summary: 'Query a database',
      description:
        'Returns a list of pages contained in the database, filtered and ordered according to the filter and sort objects provided in the request.',
      citation:
        'https://developers.notion.com/reference/post-database-query — "Returns a list of pages contained in the database"',
    });
    expect(result).toBeDefined();
    expect(result!.sideEffect).toBe('read');
    expect(result!.destructive).toBe(false);
  });

  it('classifies a GET that creates as write (acceptance criterion)', () => {
    const result = classifyFromOpenApi({
      kind: 'openapi',
      method: 'GET',
      summary: 'Start an export',
      description:
        'Creates a new export job for the account and returns its id. The export is generated asynchronously.',
      citation: 'openapi.yaml#/paths/~1exports/get',
    });
    expect(result).toBeDefined();
    expect(result!.sideEffect).toBe('write');
    // Creating again creates a duplicate — never idempotent from prose alone
    expect(result!.idempotent).toBe(false);
  });

  it('yields no classification from an OpenAPI entry with method but no prose', () => {
    const result = classifyFromOpenApi({
      kind: 'openapi',
      method: 'DELETE',
      citation: 'openapi.yaml#/paths/~1things~1{id}/delete',
    });
    expect(result).toBeUndefined();
  });

  it('uses the method only to corroborate idempotency of a write', () => {
    const put = classifyFromOpenApi({
      kind: 'openapi',
      method: 'PUT',
      description: 'Creates or replaces the resource at the target URI.',
      citation: 'openapi.yaml#/paths/~1things~1{id}/put',
    });
    expect(put!.sideEffect).toBe('write');
    expect(put!.idempotent).toBe(true); // RFC 9110: PUT is idempotent
  });
});

describe('binding rule: write iff docs say a new record is created', () => {
  it('classifies a nominal read that mutates as read_with_side_effects', () => {
    const result = classifyFromDocText({
      kind: 'prose',
      docText: 'Returns the message and marks it as read in the user mailbox.',
      citation: 'https://example.dev/docs/messages/get — quoted',
    });
    expect(result!.sideEffect).toBe('read_with_side_effects');
  });

  it('classifies update/delete (mutation without record creation) as read_with_side_effects with the destructive flag', () => {
    const result = classifyFromDocText({
      kind: 'prose',
      docText:
        'Immediately and permanently deletes the specified message. This operation cannot be undone.',
      citation:
        'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/delete — quoted',
    });
    expect(result!.sideEffect).toBe('read_with_side_effects');
    expect(result!.destructive).toBe(true);
  });

  it('classifies record creation as write even when phrased as a side effect', () => {
    const result = classifyFromDocText({
      kind: 'prose',
      docText:
        'Sends the specified message to the recipients. A new message record is created in the Sent folder.',
      citation: 'https://example.dev/docs/messages/send — quoted',
    });
    expect(result!.sideEffect).toBe('write');
  });

  it('ignores negated clauses ("does not modify")', () => {
    const result = classifyFromDocText({
      kind: 'prose',
      docText: 'Returns the current configuration. Does not modify any data.',
      citation: 'https://example.dev/docs/config/get — quoted',
    });
    expect(result!.sideEffect).toBe('read');
  });
});

describe('provenance is mandatory', () => {
  it('rejects empty citations on doc evidence', () => {
    expect(() =>
      classifyFromDocText({
        kind: 'prose',
        docText: 'Returns a list of items.',
        citation: '   ',
      })
    ).toThrow(ClassificationError);
  });

  it('rejects manual evidence without a citation', () => {
    expect(() =>
      classifyFromManual({
        kind: 'manual',
        sideEffect: 'read',
        destructive: false,
        idempotent: true,
      })
    ).toThrow(ClassificationError);
  });

  it('throws instead of guessing when no evidence yields a classification', () => {
    expect(() => classifySideEffect([])).toThrow(ClassificationError);
    expect(() =>
      classifySideEffect([
        {
          kind: 'openapi',
          method: 'POST',
          citation: 'openapi.yaml#/paths/~1x/post',
        },
      ])
    ).toThrow(ClassificationError);
  });

  it('every produced classification satisfies the shared Zod schema (non-empty source + citation)', () => {
    const results = [
      classifyFromMcpAnnotations({
        kind: 'mcp',
        annotations: { readOnlyHint: true },
        citation: 'mcp://server/tools/list_items',
      }),
      classifyFromOpenApi({
        kind: 'openapi',
        method: 'POST',
        description: 'Returns matching results.',
        citation: 'openapi.yaml#/paths/~1search/post',
      })!,
      classifyFromDocText({
        kind: 'prose',
        docText: 'Creates a new label.',
        citation:
          'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/create — quoted',
      })!,
      classifyFromManual({
        kind: 'manual',
        sideEffect: 'write',
        destructive: false,
        idempotent: false,
        citation:
          'asserted by maintainer after runtime observation, 2026-07-15',
      }),
    ];
    for (const result of results) {
      const parsed = OperationSideEffectMetadataSchema.parse(result);
      expect(parsed.citation.trim().length).toBeGreaterThan(0);
      expect(parsed.source.length).toBeGreaterThan(0);
    }
  });
});

describe('evidence hierarchy', () => {
  it('prefers MCP annotations over prose, and falls through evidence that yields nothing', () => {
    const result = classifySideEffect([
      {
        kind: 'prose',
        docText: 'Creates a new item.',
        citation: 'https://example.dev/docs — quoted',
      },
      {
        kind: 'openapi',
        method: 'POST',
        citation: 'openapi.yaml#/paths/~1items/post', // no prose → yields nothing
      },
      {
        kind: 'mcp',
        annotations: { readOnlyHint: true },
        citation: 'mcp://server/tools/get_item',
      },
    ]);
    expect(result.source).toBe('mcp');
    expect(result.sideEffect).toBe('read');
  });

  it('maps non-read-only MCP tools to write with spec defaults (destructive true, idempotent false)', () => {
    const result = classifyFromMcpAnnotations({
      kind: 'mcp',
      annotations: {},
      citation: 'mcp://server/tools/do_something',
    });
    expect(result.sideEffect).toBe('write');
    expect(result.destructive).toBe(true);
    expect(result.idempotent).toBe(false);
  });
});

describe('extractDocSignals', () => {
  it('detects creation, mutation, destruction, and read language independently', () => {
    expect(extractDocSignals('Creates a copy of a file.')).toMatchObject({
      createsNewRecord: true,
    });
    expect(extractDocSignals('Updates an event.')).toMatchObject({
      createsNewRecord: false,
      mutates: true,
    });
    expect(extractDocSignals('Deletes an event.')).toMatchObject({
      mutates: true,
      destructive: true,
    });
    expect(
      extractDocSignals('Lists the messages in the mailbox.')
    ).toMatchObject({
      createsNewRecord: false,
      mutates: false,
      reads: true,
    });
  });
});
