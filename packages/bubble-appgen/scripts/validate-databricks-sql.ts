/**
 * S7 validation gate 3 probe: the generated databricks-sql bubble registers
 * in the factory and exposes params/result schemas + operationMetadata; plus
 * a runtime Zod accept/reject round-trip and a class instantiation.
 */
import { BubbleFactory, DatabricksSqlBubble } from '@bubblelab/bubble-core';

const factory = new BubbleFactory();
await factory.registerDefaults();

const metadata = factory.getMetadata('databricks-sql');
if (!metadata) throw new Error('FAIL: no factory metadata for databricks-sql');
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

const cls = factory.get('databricks-sql');
if (!cls) throw new Error('FAIL: factory.get returned nothing');
const valid = cls.schema.safeParse({
  operation: 'execute_statement',
  workspaceUrl: 'https://dbc-a1b2c3d4-e5f6.cloud.databricks.com',
  statement: 'SELECT * FROM range(10)',
  warehouse_id: 'abcdef0123456789',
  wait_timeout: '10s',
  on_wait_timeout: 'CONTINUE',
  disposition: 'INLINE',
  format: 'JSON_ARRAY',
});
console.log('valid execute_statement request parses:', valid.success);

const invalid = cls.schema.safeParse({
  operation: 'execute_statement',
  workspaceUrl: 'https://dbc-a1b2c3d4-e5f6.cloud.databricks.com',
  statement: 12345,
  warehouse_id: 'abcdef0123456789',
});
console.log('type-corrupted request rejected:', !invalid.success);

const missing = cls.schema.safeParse({ operation: 'get_statement' });
console.log('missing required fields rejected:', !missing.success);

const resultOk = cls.resultSchema.safeParse({
  operation: 'get_statement',
  success: true,
  error: '',
  statement_id: '01f06a2b-0000-1abc-9def-0123456789ab',
  status: { state: 'SUCCEEDED' },
  manifest: {
    format: 'JSON_ARRAY',
    schema: { column_count: 1, columns: [{ name: 'id', position: 0 }] },
    total_row_count: 10,
    truncated: false,
  },
  result: {
    chunk_index: 0,
    row_count: 10,
    row_offset: 0,
    data_array: [['0'], ['1']],
  },
});
console.log(
  'result payload validates against result schema:',
  resultOk.success
);

const resultDrift = cls.resultSchema.safeParse({
  operation: 'get_statement',
  success: true,
  error: '',
  status: { state: 'NOT_A_DOCUMENTED_STATE' },
});
console.log('drifted response rejected (state enum):', !resultDrift.success);

const bubble = new DatabricksSqlBubble({
  operation: 'get_statement',
  workspaceUrl: 'https://dbc-a1b2c3d4-e5f6.cloud.databricks.com',
  statement_id: '01f06a2b-0000-1abc-9def-0123456789ab',
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
