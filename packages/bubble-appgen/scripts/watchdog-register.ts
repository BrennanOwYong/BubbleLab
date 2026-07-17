/**
 * Seed / refresh registry/tool-sources.json — the retrofit path that puts
 * EXISTING generated tools under the watchdog.
 *
 * The tool table below records, per generated tool, the authoritative
 * machine source (verified deep links), the conditional-request mechanisms
 * the server honors (live-probed 2026-07-17), and the deterministic
 * pipeline that turns the source into the committed fixture and the
 * generated bubble. Running the script fetches every source once to record
 * the initial snapshot (etag / hash / vendor version) and fingerprints the
 * generated files in bubble-core.
 *
 * Usage:
 *   bun scripts/watchdog-register.ts            # seed/refresh all tools
 *   bun scripts/watchdog-register.ts --no-fetch # fingerprints only
 *
 * Idempotent: re-running refreshes snapshots and fingerprints in place and
 * preserves any pendingReview state.
 *
 * ## References (probe results in fetch-source.ts header)
 * - Stripe:    https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
 * - Kraken:    https://docs.kraken.com/openapi/spot-rest.yaml
 * - Snowflake: https://raw.githubusercontent.com/snowflakedb/snowflake-rest-api-specs/refs/heads/main/specifications/sqlapi.yaml
 * - BigQuery:  https://bigquery.googleapis.com/discovery/v1/apis/bigquery/v2/rest
 * - Redshift:  https://raw.githubusercontent.com/aws/aws-sdk-js-v3/main/codegen/sdk-codegen/aws-models/redshift-data.json
 * - Databricks (hand-transcribed fixture; references only):
 *   https://raw.githubusercontent.com/databricks/databricks-sdk-go/main/service/sql/model.go
 *   https://raw.githubusercontent.com/databricks/databricks-sdk-go/main/service/sql/impl.go
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  RegisteredToolSource,
  ToolSourceRegistry,
} from '@bubblelab/shared-schemas';
import {
  fetchSource,
  toSnapshot,
} from '../src/watchdog/fetch-source.js';
import { fingerprintGeneratedFiles } from '../src/watchdog/check.js';
import {
  loadRegistry,
  registryPath,
  saveRegistry,
} from '../src/watchdog/registry-io.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
const noFetch = process.argv.includes('--no-fetch');

type SeedTool = Omit<RegisteredToolSource, 'generatedFiles' | 'pendingReview'>;

const OUT_ROOT = 'packages/bubble-core/src/bubbles/service-bubble';

const SEED: SeedTool[] = [
  {
    name: 'snowflake-sql-api',
    specType: 'openapi',
    monitoring: 'auto',
    sources: [
      {
        key: 'spec',
        url: 'https://raw.githubusercontent.com/snowflakedb/snowflake-rest-api-specs/refs/heads/main/specifications/sqlapi.yaml',
        conditional: ['etag'],
        snapshot: null,
      },
    ],
    pipeline: {
      rawTarget: 'fixtures/sqlapi.yaml',
      prettierRawTarget: true,
      convert: null,
      fixture: 'fixtures/sqlapi.yaml',
      generate: [
        'src/cli.ts',
        '--spec',
        'fixtures/sqlapi.yaml',
        '--config',
        'examples/snowflake-sql-api.config.json',
      ],
      config: 'examples/snowflake-sql-api.config.json',
    },
    outDir: `${OUT_ROOT}/snowflake-sql-api`,
    docsUrl: 'https://docs.snowflake.com/en/developer-guide/sql-api/intro',
    references: [
      'https://github.com/snowflakedb/snowflake-rest-api-specs',
      'https://docs.snowflake.com/en/developer-guide/sql-api/intro',
    ],
  },
  {
    name: 'stripe-payments-api',
    specType: 'openapi',
    monitoring: 'auto',
    sources: [
      {
        key: 'spec',
        url: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
        conditional: ['etag'],
        snapshot: null,
      },
    ],
    pipeline: {
      rawTarget: null,
      prettierRawTarget: false,
      convert: [
        'scripts/trim-openapi.ts',
        '--trim',
        'examples/stripe-payments-api.trim.json',
        '--source',
        '{download:spec}',
      ],
      fixture: 'fixtures/stripe-payments.yaml',
      generate: [
        'src/cli.ts',
        '--spec',
        'fixtures/stripe-payments.yaml',
        '--config',
        'examples/stripe-payments-api.config.json',
      ],
      config: 'examples/stripe-payments-api.config.json',
    },
    outDir: `${OUT_ROOT}/stripe-payments-api`,
    docsUrl: 'https://docs.stripe.com/api',
    references: [
      'https://github.com/stripe/openapi',
      'https://docs.stripe.com/api/requests',
    ],
  },
  {
    name: 'kraken-spot-api',
    specType: 'openapi',
    monitoring: 'auto',
    sources: [
      {
        key: 'spec',
        url: 'https://docs.kraken.com/openapi/spot-rest.yaml',
        conditional: ['etag', 'last-modified'],
        snapshot: null,
      },
    ],
    pipeline: {
      rawTarget: null,
      prettierRawTarget: false,
      convert: [
        'scripts/trim-openapi.ts',
        '--trim',
        'examples/kraken-spot-api.trim.json',
        '--source',
        '{download:spec}',
      ],
      fixture: 'fixtures/kraken-spot.yaml',
      generate: [
        'src/cli.ts',
        '--spec',
        'fixtures/kraken-spot.yaml',
        '--config',
        'examples/kraken-spot-api.config.json',
      ],
      config: 'examples/kraken-spot-api.config.json',
    },
    outDir: `${OUT_ROOT}/kraken-spot-api`,
    docsUrl: 'https://docs.kraken.com/api/docs/rest-api/get-ticker-information',
    references: [
      'https://docs.kraken.com/openapi/spot-rest.yaml',
      'https://docs.kraken.com/api/docs/guides/spot-rest-intro/',
    ],
  },
  {
    name: 'bigquery',
    specType: 'google-discovery',
    monitoring: 'auto',
    sources: [
      {
        key: 'discovery',
        // NO response ETag/Last-Modified; HEAD answers 404. GET + body hash;
        // the document's own `revision` field is the vendor version.
        url: 'https://bigquery.googleapis.com/discovery/v1/apis/bigquery/v2/rest',
        conditional: [],
        snapshot: null,
      },
    ],
    pipeline: {
      rawTarget: 'fixtures/bigquery-v2.discovery.json',
      prettierRawTarget: true,
      convert: ['scripts/discovery-to-openapi.ts'],
      fixture: 'fixtures/bigquery-v2.openapi.json',
      generate: [
        'src/cli.ts',
        '--spec',
        'fixtures/bigquery-v2.openapi.json',
        '--config',
        'examples/bigquery.config.json',
      ],
      config: 'examples/bigquery.config.json',
    },
    outDir: `${OUT_ROOT}/bigquery`,
    docsUrl: 'https://cloud.google.com/bigquery/docs/reference/rest',
    references: [
      'https://developers.google.com/discovery/v1/reference/apis',
      'https://cloud.google.com/bigquery/docs/reference/rest',
    ],
  },
  {
    name: 'redshift-data',
    specType: 'aws-smithy',
    monitoring: 'auto',
    sources: [
      {
        key: 'model',
        url: 'https://raw.githubusercontent.com/aws/aws-sdk-js-v3/main/codegen/sdk-codegen/aws-models/redshift-data.json',
        conditional: ['etag'],
        snapshot: null,
      },
    ],
    pipeline: {
      rawTarget: 'fixtures/redshift-data.smithy.json',
      prettierRawTarget: true,
      convert: ['scripts/smithy-to-openapi.ts'],
      fixture: 'fixtures/redshift-data.openapi.json',
      generate: [
        'src/cli.ts',
        '--spec',
        'fixtures/redshift-data.openapi.json',
        '--config',
        'examples/redshift-data.config.json',
      ],
      config: 'examples/redshift-data.config.json',
    },
    outDir: `${OUT_ROOT}/redshift-data`,
    docsUrl:
      'https://docs.aws.amazon.com/redshift-data/latest/APIReference/Welcome.html',
    references: [
      'https://raw.githubusercontent.com/aws/aws-sdk-js-v3/main/codegen/sdk-codegen/aws-models/redshift-data.json',
      'https://smithy.io/2.0/aws/protocols/aws-json-1_1-protocol.html',
    ],
  },
  {
    name: 'databricks-sql',
    specType: 'hand-transcribed',
    // Databricks publishes NO machine spec (docs are an SPA); the fixture is
    // hand-transcribed from the official Go SDK generated models. The
    // watchdog can only flag that those references changed.
    monitoring: 'manual',
    sources: [
      {
        key: 'models',
        url: 'https://raw.githubusercontent.com/databricks/databricks-sdk-go/main/service/sql/model.go',
        conditional: ['etag'],
        snapshot: null,
      },
      {
        key: 'endpoints',
        url: 'https://raw.githubusercontent.com/databricks/databricks-sdk-go/main/service/sql/impl.go',
        conditional: ['etag'],
        snapshot: null,
      },
    ],
    pipeline: {
      rawTarget: null,
      prettierRawTarget: false,
      convert: null,
      fixture: 'fixtures/databricks-sql-statements.yaml',
      generate: [
        'src/cli.ts',
        '--spec',
        'fixtures/databricks-sql-statements.yaml',
        '--config',
        'examples/databricks-sql.config.json',
      ],
      config: 'examples/databricks-sql.config.json',
    },
    outDir: `${OUT_ROOT}/databricks-sql`,
    docsUrl: 'https://docs.databricks.com/api/workspace/statementexecution',
    references: [
      'https://docs.databricks.com/api/workspace/statementexecution',
      'https://github.com/databricks/databricks-sdk-go/blob/main/service/sql/model.go',
      'https://github.com/databricks/databricks-sdk-go/blob/main/service/sql/impl.go',
    ],
  },
];

const existing: ToolSourceRegistry = existsSync(registryPath(packageRoot))
  ? loadRegistry(packageRoot)
  : { registryVersion: 1, tools: [] };

const registry: ToolSourceRegistry = { registryVersion: 1, tools: [] };

for (const seed of SEED) {
  const prior = existing.tools.find((tool) => tool.name === seed.name);
  const tool: RegisteredToolSource = {
    ...seed,
    generatedFiles: fingerprintGeneratedFiles(repoRoot, seed),
    pendingReview: prior?.pendingReview ?? null,
  };
  for (const source of tool.sources) {
    const priorSource = prior?.sources.find((s) => s.key === source.key);
    source.snapshot = priorSource?.snapshot ?? null;
    if (!noFetch) {
      const outcome = await fetchSource(source, tool.specType);
      if (outcome.status === 'fetched') {
        source.snapshot = toSnapshot(
          outcome,
          tool.specType,
          new Date().toISOString()
        );
        console.log(
          `${tool.name}/${source.key}: sha256=${outcome.sha256.slice(0, 12)}… ` +
            `etag=${outcome.etag ?? '—'} version=${source.snapshot.specVersion ?? '—'} ` +
            `(${outcome.bytes} bytes)`
        );
      } else if (outcome.status === 'not-modified') {
        console.log(`${tool.name}/${source.key}: unchanged (304)`);
      } else {
        console.error(`${tool.name}/${source.key}: FETCH FAILED ${outcome.message}`);
        process.exitCode = 1;
      }
    }
  }
  console.log(
    `${tool.name}: fingerprinted ${Object.keys(tool.generatedFiles).length} generated file(s)`
  );
  registry.tools.push(tool);
}

saveRegistry(packageRoot, registry);
console.log(`registry written: ${registryPath(packageRoot)}`);
