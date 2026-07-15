import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import {
  OperationSideEffectMetadataSchema,
  type BubbleName,
  type BubbleOperationMetadata,
} from '@bubblelab/shared-schemas';
import { BubbleFactory } from '../bubble-factory.js';
import { ServiceBubble } from '../types/service-bubble-class.js';
import { ResendBubble } from '../bubbles/service-bubble/resend.js';
import { HelloWorldBubble } from '../bubbles/service-bubble/hello-world.js';
import { GetBubbleDetailsTool } from '../bubbles/tool-bubble/get-bubble-details-tool.js';

/** Bubbles backfilled with doc-grounded per-operation metadata (IR-8). */
const BACKFILLED_BUBBLES: BubbleName[] = [
  'resend',
  'gmail',
  'google-calendar',
  'google-drive',
  'github',
  'airtable',
];

/** Extract operation literals from a params schema (discriminated union on 'operation'). */
function extractOperationNames(schema: unknown): string[] {
  const names: string[] = [];
  if (!schema || typeof schema !== 'object' || !('_def' in schema)) {
    return names;
  }
  const def = (schema as z.ZodTypeAny)._def;
  if (def.typeName !== 'ZodDiscriminatedUnion') return names;
  for (const option of def.options as z.ZodTypeAny[]) {
    if (!option || typeof option !== 'object' || !('shape' in option)) {
      continue;
    }
    const literal = (option as z.ZodObject<z.ZodRawShape>).shape[
      def.discriminator as string
    ];
    if (literal && literal._def.typeName === 'ZodLiteral') {
      names.push(String(literal._def.value));
    }
  }
  return names;
}

describe('BaseBubble side-effect resolution at runtime', () => {
  it('resolves the classification of the CURRENT operation (per operation, not per bubble)', () => {
    const read = new ResendBubble({
      operation: 'get_email_status',
      email_id: 'email-123',
    });
    expect(read.sideEffect).toBe('read');
    expect(read.operationSideEffectMetadata?.citation).toContain(
      'resend.com/docs'
    );

    const write = new ResendBubble({
      operation: 'send_email',
      to: 'user@example.com',
      subject: 'Hello',
      text: 'Hi',
    });
    expect(write.sideEffect).toBe('write');
    expect(write.operationSideEffectMetadata?.source).toBeTruthy();
  });

  it('fails safe to write for a bubble without an operation param', () => {
    const bubble = new HelloWorldBubble({ name: 'World' });
    expect(bubble.sideEffect).toBe('write');
    expect(bubble.operationSideEffectMetadata).toBeUndefined();
  });

  it('fails safe to write for an operation missing from the metadata map', () => {
    const PartialParamsSchema = z.discriminatedUnion('operation', [
      z.object({ operation: z.literal('classified_read') }),
      z.object({ operation: z.literal('unclassified_op') }),
    ]);
    const PartialResultSchema = z.object({
      success: z.boolean(),
      error: z.string(),
    });
    type PartialParams = z.input<typeof PartialParamsSchema>;
    type PartialResult = z.output<typeof PartialResultSchema>;

    class PartiallyClassifiedBubble extends ServiceBubble<
      PartialParams,
      PartialResult
    > {
      static readonly bubbleName = 'hello-world' as BubbleName; // unregistered test double
      static readonly type = 'service' as const;
      static readonly schema = PartialParamsSchema;
      static readonly resultSchema = PartialResultSchema;
      static readonly shortDescription = 'test double';
      static readonly longDescription = 'test double';
      static readonly operationMetadata: BubbleOperationMetadata = {
        classified_read: {
          sideEffect: 'read',
          destructive: false,
          idempotent: true,
          confidence: 0.9,
          source: 'manual',
          citation: 'test fixture — asserted for unit test',
        },
      };
      protected async performAction(): Promise<PartialResult> {
        return { success: true, error: '' };
      }
      public async testCredential(): Promise<boolean> {
        return true;
      }
      protected chooseCredential(): string | undefined {
        return undefined;
      }
    }

    const classified = new PartiallyClassifiedBubble({
      operation: 'classified_read',
    });
    expect(classified.sideEffect).toBe('read');

    const unclassified = new PartiallyClassifiedBubble({
      operation: 'unclassified_op',
    });
    expect(unclassified.sideEffect).toBe('write');
    expect(unclassified.operationSideEffectMetadata).toBeUndefined();
  });
});

describe('backfilled metadata reachable from factory metadata (catalogue path)', () => {
  let factory: BubbleFactory;

  // registerDefaults scans every bubble source file for dependency inference;
  // on WSL//mnt/c filesystems the first scan can exceed the global hookTimeout.
  beforeAll(async () => {
    factory = new BubbleFactory();
    await factory.registerDefaults();
  }, 600_000);

  it('exposes operationMetadata for every backfilled bubble', () => {
    for (const name of BACKFILLED_BUBBLES) {
      const metadata = factory.getMetadata(name);
      expect(metadata, name).toBeDefined();
      expect(
        metadata!.operationMetadata,
        `${name} lost its operationMetadata`
      ).toBeDefined();
      expect(Object.keys(metadata!.operationMetadata!).length).toBeGreaterThan(
        0
      );
    }
  });

  it('guard: every bubble that declares operationMetadata covers ALL its operations, and every entry carries non-empty source + citation', () => {
    for (const name of factory.list()) {
      const metadata = factory.getMetadata(name);
      if (!metadata?.operationMetadata) continue;

      const declaredOps = Object.keys(metadata.operationMetadata);
      const schemaOps = extractOperationNames(metadata.schema);

      // No stale entries: every declared op exists in the schema
      for (const op of declaredOps) {
        expect(
          schemaOps,
          `${name}: metadata declares unknown operation '${op}'`
        ).toContain(op);
      }
      // No unclassified ops: every schema op has an entry (new operations
      // cannot ship unclassified once a bubble opts in)
      for (const op of schemaOps) {
        expect(
          declaredOps,
          `${name}: operation '${op}' has no side-effect classification`
        ).toContain(op);
      }
      // Every entry parses and carries provenance
      for (const [op, entry] of Object.entries(metadata.operationMetadata)) {
        const parsed = OperationSideEffectMetadataSchema.parse(entry);
        expect(
          parsed.citation.trim().length,
          `${name}.${op}: empty citation`
        ).toBeGreaterThan(0);
        expect(parsed.source, `${name}.${op}: empty source`).toBeTruthy();
      }
    }
  });

  it('doc-grounded classifications match the binding rule for known operations', () => {
    const gmail = factory.getMetadata('gmail')!.operationMetadata!;
    expect(gmail.send_email.sideEffect).toBe('write');
    expect(gmail.get_email.sideEffect).toBe('read');
    // Nominal reads that mutate, and non-creating mutations
    expect(gmail.mark_as_read.sideEffect).toBe('read_with_side_effects');
    expect(gmail.delete_email.sideEffect).toBe('read_with_side_effects');
    expect(gmail.delete_email.destructive).toBe(true);

    const calendar = factory.getMetadata('google-calendar')!.operationMetadata!;
    expect(calendar.create_event.sideEffect).toBe('write');
    expect(calendar.list_events.sideEffect).toBe('read');
    expect(calendar.delete_event.destructive).toBe(true);

    // copy_doc: docs say it creates a copy — a new record — so it is write
    const drive = factory.getMetadata('google-drive')!.operationMetadata!;
    expect(drive.copy_doc.sideEffect).toBe('write');
    expect(drive.list_files.sideEffect).toBe('read');
  });
});

describe('catalogue surfacing for the code-generating LLM', () => {
  // The tool's performAction runs registerDefaults(); under parallel
  // full-suite load on WSL//mnt/c the first source scan can exceed the
  // default 60s testTimeout, so this test carries its own budget.
  it(
    'get-bubble-details-tool emits per-operation side effects with provenance',
    { timeout: 600_000 },
    async () => {
      const tool = new GetBubbleDetailsTool({ bubbleName: 'resend' });
      const result = await tool.action();
      expect(result.success).toBe(true);

      const sideEffects = result.data?.operationSideEffects;
      expect(sideEffects).toBeDefined();
      expect(sideEffects).toContain('send_email: write');
      expect(sideEffects).toContain('get_email_status: read');
      expect(sideEffects).toContain('citation:');
      expect(sideEffects).toContain('source:');

      // Usage examples tag each operation with its side effect
      expect(result.data?.usageExample).toContain('[side-effect: write]');
      expect(result.data?.usageExample).toContain('[side-effect: read]');
    }
  );
});
