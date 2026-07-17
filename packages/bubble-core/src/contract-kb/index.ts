/**
 * Contract Knowledge Base (IR-11/12): per-integration, self-healing record of
 * what APIs ACTUALLY return, keyed by BubbleLab's existing per-call-site
 * identity. See contract-kb.ts for the loop and the anti-poison gate.
 */
export {
  ContractKb,
  ContractKbError,
  contractNodeKeyFor,
  DEFAULT_CONSISTENCY_THRESHOLD,
  type ContractIngestAction,
  type ContractIngestResult,
  type ContractChannelIngestOutcome,
  type ContractDeviation,
  type ContractRollbackResult,
  type ContractKbOptions,
} from './contract-kb.js';
export {
  inferValueSchema,
  mergeValueSchemas,
  fingerprintValueSchema,
  valueSchemaToZod,
  diffValueSchemas,
  canonicalJson,
  LOOSE_VALUE_SCHEMA,
  type ValueSchema,
  type ValueObjectField,
  type ValueSchemaChange,
  type ValueSchemaChangeKind,
} from './value-schema.js';
export {
  integrationKbDocumentSchema,
  toKbJsonValue,
  type IntegrationKbDocument,
  type NodeContractRecord,
  type ContractChannel,
  type ContractChannelName,
  type ContractVersion,
  type ContractVersionSource,
  type PendingContractCluster,
  type KbJsonValue,
} from './document.js';
export {
  InMemoryContractKbStore,
  type ContractKbStore,
} from './store.js';
