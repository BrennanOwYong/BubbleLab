/**
 * Watchdog engine acceptance: drift detector classification, conditional
 * fetch over file:// sources, registry round-trip. The end-to-end path
 * (fetch -> convert -> diff -> regenerate -> changelog) is exercised by the
 * proof run in scripts/watchdog-check.ts with a file:// override; these
 * tests pin the decision logic.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolSourceRegistry } from '@bubblelab/shared-schemas';
import type { OpenApiDocument } from '../openapi.js';
import { diffSpecs } from './spec-diff.js';
import {
  extractSpecVersion,
  fetchSource,
  sha256Hex,
} from './fetch-source.js';
import { loadRegistry, saveRegistry } from './registry-io.js';

function specWith(overrides: {
  version?: string;
  submitBody?: Record<string, unknown>;
  submitRequired?: string[];
  includeCancel?: boolean;
  responseProps?: Record<string, unknown>;
  timeoutParam?: boolean;
}): OpenApiDocument {
  const {
    version = '2.0.0',
    submitBody = { statement: { type: 'string' }, timeout: { type: 'number' } },
    submitRequired = ['statement'],
    includeCancel = true,
    responseProps = {
      statementHandle: { type: 'string' },
      message: { type: 'string' },
    },
    timeoutParam = true,
  } = overrides;
  const doc = {
    openapi: '3.0.0',
    info: { title: 'Test SQL API', version },
    paths: {
      '/api/v2/statements': {
        post: {
          operationId: 'SubmitStatement',
          summary: 'Submit a statement',
          parameters: timeoutParam
            ? [
                {
                  name: 'async',
                  in: 'query',
                  required: false,
                  schema: { type: 'boolean' },
                },
              ]
            : [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: submitBody,
                  required: submitRequired,
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: responseProps },
                },
              },
            },
          },
        },
      },
      ...(includeCancel
        ? {
            '/api/v2/statements/{statementHandle}/cancel': {
              post: {
                operationId: 'CancelStatement',
                parameters: [
                  {
                    name: 'statementHandle',
                    in: 'path',
                    required: true,
                    schema: { type: 'string' },
                  },
                ],
                responses: {
                  '200': {
                    description: 'ok',
                    content: {
                      'application/json': {
                        schema: {
                          type: 'object',
                          properties: { message: { type: 'string' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          }
        : {}),
    },
  };
  return doc as unknown as OpenApiDocument;
}

const OPS = ['SubmitStatement', 'CancelStatement'];

describe('spec-diff drift detector', () => {
  test('identical specs produce no changes and no breaking flag', () => {
    const diff = diffSpecs(specWith({}), specWith({}), OPS, 'test.yaml');
    expect(diff.breaking).toBe(false);
    expect(diff.addedOperations).toHaveLength(0);
    expect(diff.removedOperations).toHaveLength(0);
    expect(diff.changedOperations).toHaveLength(0);
  });

  test('removed operation is BREAKING', () => {
    const diff = diffSpecs(
      specWith({}),
      specWith({ includeCancel: false }),
      OPS,
      'test.yaml'
    );
    expect(diff.breaking).toBe(true);
    expect(diff.removedOperations).toEqual([
      {
        operationId: 'CancelStatement',
        method: 'POST',
        path: '/api/v2/statements/{statementHandle}/cancel',
      },
    ]);
    expect(diff.breakingFindings.join(' ')).toContain('CancelStatement');
  });

  test('new optional body property is non-breaking; required is breaking', () => {
    const withOptional = diffSpecs(
      specWith({}),
      specWith({
        submitBody: {
          statement: { type: 'string' },
          timeout: { type: 'number' },
          warehouse: { type: 'string' },
        },
      }),
      OPS,
      'test.yaml'
    );
    expect(withOptional.breaking).toBe(false);
    // extract.ts flattens body top-level properties into WireFields, so a
    // new body property surfaces as an added (optional) param.
    expect(
      withOptional.changedOperations[0].changes.some(
        (c) => c.kind === 'param-added' && c.path === 'body.warehouse'
      )
    ).toBe(true);

    const withRequired = diffSpecs(
      specWith({}),
      specWith({
        submitBody: {
          statement: { type: 'string' },
          timeout: { type: 'number' },
          warehouse: { type: 'string' },
        },
        submitRequired: ['statement', 'warehouse'],
      }),
      OPS,
      'test.yaml'
    );
    expect(withRequired.breaking).toBe(true);
  });

  test('body property type change is BREAKING with movement recorded', () => {
    const diff = diffSpecs(
      specWith({}),
      specWith({
        submitBody: {
          statement: { type: 'string' },
          timeout: { type: 'string' },
        },
      }),
      OPS,
      'test.yaml'
    );
    expect(diff.breaking).toBe(true);
    const change = diff.changedOperations[0].changes.find(
      (c) => c.kind === 'param-type-changed'
    );
    expect(change?.path).toBe('body.timeout');
    expect(change?.from).toBe('number');
    expect(change?.to).toBe('string');
  });

  test('removed response property is BREAKING; added is not', () => {
    const removed = diffSpecs(
      specWith({}),
      specWith({ responseProps: { statementHandle: { type: 'string' } } }),
      OPS,
      'test.yaml'
    );
    expect(removed.breaking).toBe(true);
    expect(
      removed.changedOperations[0].changes.some(
        (c) =>
          c.kind === 'response-property-removed' &&
          c.path === 'response.message'
      )
    ).toBe(true);

    const added = diffSpecs(
      specWith({}),
      specWith({
        responseProps: {
          statementHandle: { type: 'string' },
          message: { type: 'string' },
          stats: { type: 'object' },
        },
      }),
      OPS,
      'test.yaml'
    );
    expect(added.breaking).toBe(false);
  });

  test('query param removal is BREAKING; version-only change is not', () => {
    const paramGone = diffSpecs(
      specWith({}),
      specWith({ timeoutParam: false }),
      OPS,
      'test.yaml'
    );
    expect(paramGone.breaking).toBe(true);
    expect(
      paramGone.changedOperations[0].changes.some(
        (c) => c.kind === 'param-removed' && c.path === 'query.async'
      )
    ).toBe(true);

    const versionOnly = diffSpecs(
      specWith({}),
      specWith({ version: '2.1.0' }),
      OPS,
      'test.yaml'
    );
    expect(versionOnly.breaking).toBe(false);
    expect(versionOnly.infoVersion).toEqual({ from: '2.0.0', to: '2.1.0' });
  });
});

describe('fetch-source', () => {
  test('file:// source fetches, hashes, and reports body-hash mechanism', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-'));
    const file = join(dir, 'spec.yaml');
    writeFileSync(file, 'openapi: 3.0.0\ninfo:\n  version: 9.9.9\n', 'utf8');
    const outcome = await fetchSource(
      {
        key: 'spec',
        url: pathToFileURL(file).href,
        conditional: [],
        snapshot: null,
      },
      'openapi'
    );
    expect(outcome.status).toBe('fetched');
    if (outcome.status === 'fetched') {
      expect(outcome.sha256).toBe(sha256Hex(outcome.body));
      expect(outcome.mechanism).toBe('body-hash');
    }
  });

  test('extractSpecVersion reads OpenAPI info.version and Discovery revision', () => {
    expect(
      extractSpecVersion('openapi', 'openapi: 3.0.0\ninfo:\n  version: 2.0.0\n')
    ).toBe('2.0.0');
    expect(
      extractSpecVersion(
        'openapi',
        JSON.stringify({ openapi: '3.0.0', info: { version: '1.2.3' } })
      )
    ).toBe('1.2.3');
    expect(
      extractSpecVersion(
        'google-discovery',
        JSON.stringify({ revision: '20260707' })
      )
    ).toBe('20260707');
    expect(extractSpecVersion('aws-smithy', '{}')).toBeNull();
  });
});

describe('registry round-trip', () => {
  test('save + load preserves the document and validates it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-registry-'));
    const registry: ToolSourceRegistry = {
      registryVersion: 1,
      tools: [
        {
          name: 'demo-tool',
          specType: 'openapi',
          monitoring: 'auto',
          sources: [
            {
              key: 'spec',
              url: 'https://example.com/spec.yaml',
              conditional: ['etag'],
              snapshot: {
                etag: '"abc"',
                lastModified: null,
                sha256: 'deadbeef',
                bytes: 42,
                specVersion: '1.0.0',
                fetchedAt: '2026-07-17T00:00:00.000Z',
              },
            },
          ],
          pipeline: {
            rawTarget: null,
            prettierRawTarget: false,
            convert: null,
            fixture: 'fixtures/demo.yaml',
            generate: ['src/cli.ts'],
            config: 'examples/demo.config.json',
          },
          generatedFiles: { 'demo-tool.ts': 'cafe' },
          outDir: 'packages/bubble-core/src/bubbles/service-bubble/demo-tool',
          docsUrl: 'https://example.com/docs',
          references: ['https://example.com/spec.yaml'],
          pendingReview: null,
        },
      ],
    };
    saveRegistry(dir, registry);
    expect(loadRegistry(dir)).toEqual(registry);
  });
});
