/**
 * S7 validation gate 3 probe: the generated bubble registers in the factory
 * and exposes params/result schemas + operationMetadata; plus a runtime Zod
 * accept/reject round-trip and a class instantiation.
 */
import { BubbleFactory, SnowflakeSqlApiBubble } from '@bubblelab/bubble-core';

const factory = new BubbleFactory();
await factory.registerDefaults();

const metadata = factory.getMetadata('snowflake-sql-api');
if (!metadata)
  throw new Error('FAIL: no factory metadata for snowflake-sql-api');
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

// Runtime schema round-trip: valid request accepted
const cls = factory.get('snowflake-sql-api');
if (!cls) throw new Error('FAIL: factory.get returned nothing');
const valid = cls.schema.safeParse({
  operation: 'submit_statement',
  accountUrl: 'https://myorg-myaccount.snowflakecomputing.com',
  statement: 'select * from T where c1=?',
  timeout: 10,
  database: 'TESTDB',
  schema: 'TESTSCHEMA',
  warehouse: 'TESTWH',
  bindings: { '1': { type: 'FIXED', value: '123' } },
});
console.log('valid spec-example request parses:', valid.success);

// Invalid request rejected (statement must be a string)
const invalid = cls.schema.safeParse({
  operation: 'submit_statement',
  accountUrl: 'https://myorg-myaccount.snowflakecomputing.com',
  statement: 12345,
});
console.log('type-corrupted request rejected:', !invalid.success);

// Missing accountUrl rejected
const missing = cls.schema.safeParse({ operation: 'cancel_statement' });
console.log('missing required fields rejected:', !missing.success);

// Result schema validates the spec 202 QueryStatus example
const resultOk = cls.resultSchema.safeParse({
  operation: 'submit_statement',
  success: true,
  error: '',
  code: '000000',
  sqlState: '00000',
  message: 'successfully executed',
  statementHandle: 'e4ce975e-f7ff-4b5e-b15e-bf25f59371ae',
  createdOn: 1597090533987,
});
console.log(
  'spec response example validates against result schema:',
  resultOk.success
);

// Result schema rejects drift (statementHandle not a uuid)
const resultDrift = cls.resultSchema.safeParse({
  operation: 'submit_statement',
  success: true,
  error: '',
  statementHandle: 'not-a-uuid',
});
console.log('drifted response rejected:', !resultDrift.success);

// Class instantiation with typed params (no factory)
const bubble = new SnowflakeSqlApiBubble({
  operation: 'get_statement_status',
  accountUrl: 'https://myorg-myaccount.snowflakecomputing.com',
  statementHandle: 'e4ce975e-f7ff-4b5e-b15e-bf25f59371ae',
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
