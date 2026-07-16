/**
 * S7 validation gate 3 probe: the generated redshift-data bubble registers in
 * the factory and exposes params/result schemas + operationMetadata; plus a
 * runtime Zod accept/reject round-trip and a class instantiation.
 *
 * Runtime caveat (documented in the config and CredentialType description):
 * live calls additionally require AWS SigV4 request signing, which the
 * generated raw-fetch bearer pattern does not implement yet. These probes
 * exercise registration and contracts only.
 */
import { BubbleFactory, RedshiftDataBubble } from '@bubblelab/bubble-core';

const factory = new BubbleFactory();
await factory.registerDefaults();

const metadata = factory.getMetadata('redshift-data');
if (!metadata) throw new Error('FAIL: no factory metadata for redshift-data');
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

const cls = factory.get('redshift-data');
if (!cls) throw new Error('FAIL: factory.get returned nothing');
const valid = cls.schema.safeParse({
  operation: 'execute_statement',
  endpointUrl: 'https://redshift-data.us-east-1.amazonaws.com',
  Sql: 'SELECT count(*) FROM adherence_events',
  Database: 'analytics',
  WorkgroupName: 'clinical-wg',
});
console.log('valid execute_statement request parses:', valid.success);

const invalid = cls.schema.safeParse({
  operation: 'execute_statement',
  endpointUrl: 'https://redshift-data.us-east-1.amazonaws.com',
  Sql: 12345,
});
console.log('type-corrupted request rejected:', !invalid.success);

const missing = cls.schema.safeParse({ operation: 'describe_statement' });
console.log('missing required fields rejected:', !missing.success);

const resultOk = cls.resultSchema.safeParse({
  operation: 'describe_statement',
  success: true,
  error: '',
  Id: 'd9b6c0c9-0747-4bf4-b142-e8883122f766',
  Status: 'FINISHED',
  HasResultSet: true,
  ResultRows: 1,
  Duration: 1024,
});
console.log(
  'result payload validates against result schema:',
  resultOk.success
);

const resultDrift = cls.resultSchema.safeParse({
  operation: 'describe_statement',
  success: true,
  error: '',
  Status: 'NOT_A_DOCUMENTED_STATE',
});
console.log('drifted response rejected (Status enum):', !resultDrift.success);

const bubble = new RedshiftDataBubble({
  operation: 'describe_statement',
  endpointUrl: 'https://redshift-data.us-east-1.amazonaws.com',
  Id: 'd9b6c0c9-0747-4bf4-b142-e8883122f766',
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
