import { z } from 'zod';
import { ServiceBubble } from '../../types/service-bubble-class.js';
import type { BubbleContext } from '../../types/bubble.js';
import { CredentialType } from '@bubblelab/shared-schemas';
import { CONTRACT_DRIFT_PROBE_OPERATION_METADATA } from './contract-drift-probe.metadata.js';

/**
 * Diagnostic service bubble for the Contract KB drift pipeline (IR-11/12).
 *
 * Purpose: exercise the OUTPUT_CONTRACT_VIOLATION path deterministically,
 * with zero credentials and zero network — the in-process equivalent of an
 * upstream API changing its response shape. Like HelloWorldBubble, it exists
 * for testing and validation of the platform itself.
 *
 * Operations:
 * - `probe_read` (read-hinted): returns an in-process record. `shape:
 *   'conform'` matches the declared resultSchema; `shape: 'drift'` returns a
 *   structurally different record — simulating contract drift — which
 *   BaseBubble.action() surfaces as a BubbleOutputContractViolationError and
 *   a grounded drift observation.
 * - `record_write` (write-hinted): returns a deterministic receipt. In test
 *   mode this operation is mocked by the test-mode gate; in a real run its
 *   response is recorded by the Contract KB, which then serves it back as a
 *   recorded mock (`getRecordedMock()`), closing the reality-grounding loop.
 */
const ContractDriftProbeParamsSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z
      .literal('probe_read')
      .describe('Return an in-process probe record (no external call)'),
    shape: z
      .enum(['conform', 'drift'])
      .optional()
      .default('conform')
      .describe(
        "'conform' returns the declared shape; 'drift' returns a structurally different shape, simulating an upstream API contract change"
      ),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),
  z.object({
    operation: z
      .literal('record_write')
      .describe('Return a deterministic write receipt (no external call)'),
    note: z
      .string()
      .optional()
      .default('recorded-write')
      .describe('Note echoed into the receipt'),
    credentials: z
      .record(z.nativeEnum(CredentialType), z.string())
      .optional()
      .describe(
        'Object mapping credential types to values (injected at runtime)'
      ),
  }),
]);

const ContractDriftProbeResultSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z
      .literal('probe_read')
      .describe('Return an in-process probe record'),
    record: z
      .object({
        id: z.string().describe('Probe record id'),
        status: z.string().describe('Probe record status'),
      })
      .describe('The probe record — the declared output contract'),
    success: z.boolean().describe('Whether the operation was successful'),
    error: z.string().describe('Error message if operation failed'),
  }),
  z.object({
    operation: z
      .literal('record_write')
      .describe('Return a deterministic write receipt'),
    receipt: z
      .object({
        id: z.string().describe('Receipt id'),
        note: z.string().describe('Echoed note'),
      })
      .describe('The write receipt'),
    success: z.boolean().describe('Whether the operation was successful'),
    error: z.string().describe('Error message if operation failed'),
  }),
]);

type ContractDriftProbeResult = z.output<typeof ContractDriftProbeResultSchema>;
type ContractDriftProbeParams = z.input<typeof ContractDriftProbeParamsSchema>;
type ContractDriftProbeParsedParams = z.output<
  typeof ContractDriftProbeParamsSchema
>;

export class ContractDriftProbeBubble<
  T extends ContractDriftProbeParams = ContractDriftProbeParams,
> extends ServiceBubble<
  T,
  Extract<ContractDriftProbeResult, { operation: T['operation'] }>
> {
  static readonly type = 'service' as const;
  static readonly service = 'nodex-core';
  static readonly authType = 'none' as const;
  static readonly bubbleName = 'contract-drift-probe';
  static readonly schema = ContractDriftProbeParamsSchema;
  static readonly resultSchema = ContractDriftProbeResultSchema;
  static readonly operationMetadata = CONTRACT_DRIFT_PROBE_OPERATION_METADATA;
  static readonly shortDescription =
    'Diagnostic bubble that deterministically exercises the contract-drift pipeline';
  static readonly longDescription = `
    Diagnostic bubble for the Contract Knowledge Base (IR-11/12). Runs
    entirely in-process (no credentials, no network) and either conforms to
    its declared result contract or deliberately violates it, simulating an
    upstream API changing shape.
    Use cases:
    - Verifying that contract drift is detected, surfaced with the
      OUTPUT_CONTRACT_VIOLATION code, and ingested by the Contract KB
    - Verifying that recorded real responses are served as test-mode mocks
    - Platform testing, never business workflows
  `;
  static readonly alias = 'drift-probe';

  constructor(
    params: T = { operation: 'probe_read' } as T,
    context?: BubbleContext
  ) {
    super(params, context);
  }

  protected chooseCredential(): string | undefined {
    // Diagnostic bubble: no credentials, no network.
    return undefined;
  }

  public async testCredential(): Promise<boolean> {
    return true;
  }

  protected async performAction(
    context?: BubbleContext
  ): Promise<Extract<ContractDriftProbeResult, { operation: T['operation'] }>> {
    void context;
    type Result = Extract<
      ContractDriftProbeResult,
      { operation: T['operation'] }
    >;
    const params = this.params as ContractDriftProbeParsedParams;

    if (params.operation === 'probe_read') {
      if (params.shape === 'drift') {
        // Deliberately violates the declared resultSchema — the in-process
        // equivalent of an upstream API renaming/retyping response fields.
        // There is no typed way to express "the wrong shape" against the
        // declared result type; the unknown-cast is the probe's entire point.
        const drifted = {
          operation: 'probe_read',
          record: { id: 42, shape: 'changed' },
          success: true,
          error: '',
        };
        return drifted as unknown as Result;
      }
      return {
        operation: 'probe_read',
        record: { id: 'probe-1', status: 'ok' },
        success: true,
        error: '',
      } as Result;
    }

    return {
      operation: 'record_write',
      receipt: { id: 'receipt-1', note: params.note },
      success: true,
      error: '',
    } as Result;
  }
}
