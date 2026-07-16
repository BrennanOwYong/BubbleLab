/**
 * S7 validation gate 3 probe: the generated bigquery bubble registers in the
 * factory and exposes params/result schemas + operationMetadata; plus a
 * runtime Zod accept/reject round-trip and a class instantiation.
 */
import { BubbleFactory, BigQueryBubble } from '@bubblelab/bubble-core';

const factory = new BubbleFactory();
await factory.registerDefaults();

const metadata = factory.getMetadata('bigquery');
if (!metadata) throw new Error('FAIL: no factory metadata for bigquery');
console.log('factory registration: OK');
console.log(
  '  operations in metadata:',
  Object.keys(metadata.operationMetadata ?? {})
);
console.log(
  '  side effects:',
  Object.entries(metadata.operationMetadata ?? {}).map(
    ([op, m]) => `${op}=${m.sideEffect}${m.unverified ? ' (unverified)' : ''}`
  )
);

const cls = factory.get('bigquery');
if (!cls) throw new Error('FAIL: factory.get returned nothing');
const valid = cls.schema.safeParse({
  operation: 'jobs_query',
  endpointUrl: 'https://bigquery.googleapis.com/bigquery/v2',
  projectId: 'clinical-analytics-project',
  query: 'SELECT 1',
  useLegacySql: false,
  maxResults: 100,
});
console.log('valid jobs_query request parses:', valid.success);

const invalid = cls.schema.safeParse({
  operation: 'jobs_query',
  endpointUrl: 'https://bigquery.googleapis.com/bigquery/v2',
  projectId: 'clinical-analytics-project',
  query: 12345,
});
console.log('type-corrupted request rejected:', !invalid.success);

const missing = cls.schema.safeParse({ operation: 'datasets_list' });
console.log('missing required fields rejected:', !missing.success);

const resultOk = cls.resultSchema.safeParse({
  operation: 'jobs_query',
  success: true,
  error: '',
  kind: 'bigquery#queryResponse',
  jobComplete: true,
  totalRows: '2',
  schema: {
    fields: [{ name: 'medicationCode', type: 'STRING' }],
  },
  rows: [{ f: [{ v: 'RXN-860975' }] }],
});
console.log(
  'result payload validates against result schema:',
  resultOk.success
);

const resultDrift = cls.resultSchema.safeParse({
  operation: 'jobs_query',
  success: true,
  error: '',
  totalRows: 2,
});
console.log(
  'drifted response rejected (totalRows must be a string):',
  !resultDrift.success
);

const bubble = new BigQueryBubble({
  operation: 'datasets_list',
  endpointUrl: 'https://bigquery.googleapis.com/bigquery/v2',
  projectId: 'clinical-analytics-project',
});
console.log('class instantiation: OK, bubble name =', bubble.name);

if (
  !valid.success ||
  invalid.success ||
  missing.success ||
  !resultOk.success ||
  resultDrift.success
) {
  throw new Error('FAIL: at least one schema assertion failed');
}
console.log('ALL PROBES PASS');
