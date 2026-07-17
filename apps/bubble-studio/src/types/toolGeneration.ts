/**
 * Client mirror of the /tools/generate telemetry event contract
 * (apps/bubblelab-api/src/services/tool-generator.ts). The page renders the
 * run live from these events.
 */

export type ToolGenErrorCode =
  | 'SPEC_URL_FETCH_FAILED'
  | 'SPEC_EMPTY'
  | 'SPEC_PARSE_FAILED'
  | 'NO_OPERATIONS_FOUND'
  | 'OPERATION_EXTRACTION_FAILED'
  | 'CONTRACT_EMIT_FAILED'
  | 'FILE_WRITE_FAILED'
  | 'REGISTRY_WRITE_FAILED';

export interface RegisteredToolOperation {
  name: string;
  method: string;
  path: string;
  sideEffect: string;
  confidence: number;
  summary?: string;
}

export interface RegisteredTool {
  name: string;
  displayName: string;
  service: string;
  credentialType: string;
  source: 'validated-manifest' | 'derived';
  specTitle: string;
  operations: RegisteredToolOperation[];
  files: string[];
  outDir: string;
  addedAt: string;
}

export interface SpecParsedData {
  title: string;
  version?: string;
  pathCount: number;
  operationCount: number;
}

export interface ConfigResolvedData {
  appName: string;
  displayName: string;
  className: string;
  credentialType: string;
  source: 'validated-manifest' | 'derived';
  operationCount: number;
}

export interface OperationFoundData {
  name: string;
  operationId: string;
  method: string;
  path: string;
  summary?: string;
}

export interface OperationClassifiedData {
  name: string;
  method: string;
  path: string;
  sideEffect: string;
  confidence: number;
  unverified?: boolean;
  citation: string;
}

export interface AuthDetectedData {
  credentialType: string;
  scheme: string;
  headerNames: string[];
  baseUrlParam: { name: string; description: string; example: string };
  securitySchemes: string[];
}

export interface ContractEmittedData {
  fileName: string;
  kind: 'schema' | 'metadata' | 'class' | 'tests' | 'index';
  lines: number;
  bytes: number;
  excerpt?: string;
}

export type ToolGenEvent =
  | {
      type: 'run_started';
      data: { specName: string; bytes: number; source: 'upload' | 'url' };
    }
  | { type: 'spec_parsed'; data: SpecParsedData }
  | { type: 'config_resolved'; data: ConfigResolvedData }
  | {
      type: 'operations_found';
      data: { count: number; operations: OperationFoundData[] };
    }
  | { type: 'operation_classified'; data: OperationClassifiedData }
  | { type: 'auth_detected'; data: AuthDetectedData }
  | { type: 'contract_emitted'; data: ContractEmittedData }
  | { type: 'files_written'; data: { outDir: string; files: string[] } }
  | { type: 'tool_registered'; data: RegisteredTool }
  | {
      type: 'generation_complete';
      data: { elapsedMs: number; operationCount: number; fileCount: number };
    }
  | {
      type: 'generation_error';
      data: { code: ToolGenErrorCode; message: string };
    }
  | { type: 'stream_complete' };
