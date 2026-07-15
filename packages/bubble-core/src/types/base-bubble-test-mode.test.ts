/**
 * TEST-MODE SWITCH acceptance tests.
 *
 * The unit under test is the REAL BaseBubble.action() lifecycle — the
 * interception above performAction. The two fixture bubbles mirror the two
 * incompatible client patterns that coexist in the codebase:
 *   - SdkStyleBubble  → resend.ts pattern: SDK client constructed INSIDE
 *     performAction from a credential.
 *   - BareFetchBubble → github.ts pattern: no client object at all,
 *     chooseCredential() re-called inside every operation handler.
 * Because the gate sits above performAction, both behave identically in test
 * mode: no client constructed, no credential read, no fetch issued.
 *
 * The real ResendBubble (SDK) and GithubBubble (bare fetch) are also exercised
 * with a global fetch spy asserting ZERO network attempts.
 */

import { z } from 'zod';
import { ServiceBubble } from './service-bubble-class.js';
import type { BubbleContext } from './bubble.js';
import { CredentialType } from '@bubblelab/shared-schemas';
import type {
  BubbleOperationMetadata,
  OperationSideEffectMetadata,
  SideEffect,
} from '@bubblelab/shared-schemas';
import { ResendBubble } from '../bubbles/service-bubble/resend.js';
import { GithubBubble } from '../bubbles/service-bubble/github.js';

/**
 * Full IR-8 metadata record for a fixture operation. The test-mode gate only
 * reads `sideEffect`; the provenance fields satisfy the
 * BubbleOperationMetadata contract declared on ServiceBubble.
 */
const hint = (sideEffect: SideEffect): OperationSideEffectMetadata => ({
  sideEffect,
  destructive: false,
  idempotent: false,
  confidence: 1,
  source: 'manual',
  citation: 'test fixture',
});

// ── SDK-style fixture (resend.ts pattern) ────────────────────────────────────

class FakeSdkClient {
  static constructedCount = 0;
  constructor(public readonly apiKey: string) {
    FakeSdkClient.constructedCount++;
  }
  async send(text: string): Promise<{ id: string }> {
    return { id: `sent-${text.length}` };
  }
  async status(id: string): Promise<string> {
    return `delivered-${id}`;
  }
}

const SdkParamsSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('send_message'),
    text: z.string(),
    credentials: z.record(z.nativeEnum(CredentialType), z.string()).optional(),
  }),
  z.object({
    operation: z.literal('get_status'),
    id: z.string(),
    credentials: z.record(z.nativeEnum(CredentialType), z.string()).optional(),
  }),
]);

const SdkResultSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('send_message'),
    messageId: z.string(),
    success: z.boolean(),
    error: z.string(),
  }),
  z.object({
    operation: z.literal('get_status'),
    status: z.string(),
    success: z.boolean(),
    error: z.string(),
  }),
]);

type SdkParams = z.output<typeof SdkParamsSchema>;
type SdkResult = z.output<typeof SdkResultSchema>;

class SdkStyleBubble extends ServiceBubble<SdkParams, SdkResult> {
  static readonly bubbleName = 'sdk-style-test-bubble';
  static readonly type = 'service' as const;
  static readonly service = 'test';
  static readonly authType = 'apikey' as const;
  static readonly schema = SdkParamsSchema;
  static readonly resultSchema = SdkResultSchema;
  static readonly shortDescription = 'SDK-client fixture (resend pattern)';
  static readonly longDescription = 'SDK-client fixture (resend pattern)';
  static readonly alias = 'sdk-test';
  static readonly operationMetadata: BubbleOperationMetadata = {
    send_message: hint('write'),
    get_status: hint('read'),
  };

  static performActionCount = 0;
  static chooseCredentialCount = 0;

  static resetCounters(): void {
    SdkStyleBubble.performActionCount = 0;
    SdkStyleBubble.chooseCredentialCount = 0;
    FakeSdkClient.constructedCount = 0;
  }

  constructor(params: SdkParams, context?: BubbleContext) {
    super(params, context);
  }

  public async testCredential(): Promise<boolean> {
    return true;
  }

  protected chooseCredential(): string | undefined {
    SdkStyleBubble.chooseCredentialCount++;
    return this.params.credentials?.[CredentialType.RESEND_CRED];
  }

  protected async performAction(): Promise<SdkResult> {
    SdkStyleBubble.performActionCount++;
    // Client constructed INSIDE performAction, exactly like resend.ts:375
    const client = new FakeSdkClient(this.chooseCredential() ?? '');
    if (this.params.operation === 'send_message') {
      const sent = await client.send(this.params.text);
      return {
        operation: 'send_message',
        messageId: sent.id,
        success: true,
        error: '',
      };
    }
    return {
      operation: 'get_status',
      status: await client.status(this.params.id),
      success: true,
      error: '',
    };
  }
}

// ── Bare-fetch fixture (github.ts pattern) ───────────────────────────────────

const FetchParamsSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('create_record'),
    name: z.string(),
    credentials: z.record(z.nativeEnum(CredentialType), z.string()).optional(),
  }),
  z.object({
    operation: z.literal('get_record'),
    id: z.string(),
    credentials: z.record(z.nativeEnum(CredentialType), z.string()).optional(),
  }),
]);

const FetchResultSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('create_record'),
    recordId: z.string(),
    success: z.boolean(),
    error: z.string(),
  }),
  z.object({
    operation: z.literal('get_record'),
    value: z.string(),
    success: z.boolean(),
    error: z.string(),
  }),
]);

type FetchParams = z.output<typeof FetchParamsSchema>;
type FetchResult = z.output<typeof FetchResultSchema>;

class BareFetchBubble extends ServiceBubble<FetchParams, FetchResult> {
  static readonly bubbleName = 'bare-fetch-test-bubble';
  static readonly type = 'service' as const;
  static readonly service = 'test';
  static readonly authType = 'apikey' as const;
  static readonly schema = FetchParamsSchema;
  static readonly resultSchema = FetchResultSchema;
  static readonly shortDescription = 'Bare-fetch fixture (github pattern)';
  static readonly longDescription = 'Bare-fetch fixture (github pattern)';
  static readonly alias = 'fetch-test';
  static readonly operationMetadata: BubbleOperationMetadata = {
    create_record: hint('write'),
    get_record: hint('read'),
  };

  static performActionCount = 0;
  static chooseCredentialCount = 0;
  static fetchAttemptCount = 0;

  static resetCounters(): void {
    BareFetchBubble.performActionCount = 0;
    BareFetchBubble.chooseCredentialCount = 0;
    BareFetchBubble.fetchAttemptCount = 0;
  }

  constructor(params: FetchParams, context?: BubbleContext) {
    super(params, context);
  }

  public async testCredential(): Promise<boolean> {
    return true;
  }

  protected chooseCredential(): string | undefined {
    BareFetchBubble.chooseCredentialCount++;
    return this.params.credentials?.[CredentialType.GITHUB_TOKEN];
  }

  // No client object; credential re-read inside each handler, like github.ts
  private async handleCreateRecord(name: string): Promise<FetchResult> {
    const token = this.chooseCredential();
    BareFetchBubble.fetchAttemptCount++;
    return {
      operation: 'create_record',
      recordId: `rec-${name}-${token ? 'auth' : 'anon'}`,
      success: true,
      error: '',
    };
  }

  private async handleGetRecord(id: string): Promise<FetchResult> {
    const token = this.chooseCredential();
    BareFetchBubble.fetchAttemptCount++;
    return {
      operation: 'get_record',
      value: `value-${id}-${token ? 'auth' : 'anon'}`,
      success: true,
      error: '',
    };
  }

  protected async performAction(): Promise<FetchResult> {
    BareFetchBubble.performActionCount++;
    if (this.params.operation === 'create_record') {
      return this.handleCreateRecord(this.params.name);
    }
    return this.handleGetRecord(this.params.id);
  }
}

// ── Fixture with read_with_side_effects and no-operation params ─────────────

const PlainParamsSchema = z.object({
  name: z.string(),
  credentials: z.record(z.nativeEnum(CredentialType), z.string()).optional(),
});
const PlainResultSchema = z.object({
  greeting: z.string(),
  success: z.boolean(),
  error: z.string(),
});
type PlainParams = z.output<typeof PlainParamsSchema>;
type PlainResult = z.output<typeof PlainResultSchema>;

class NoOperationBubble extends ServiceBubble<PlainParams, PlainResult> {
  static readonly bubbleName = 'no-operation-test-bubble';
  static readonly type = 'service' as const;
  static readonly service = 'test';
  static readonly authType = 'none' as const;
  static readonly schema = PlainParamsSchema;
  static readonly resultSchema = PlainResultSchema;
  static readonly shortDescription = 'Bubble without an operation param';
  static readonly longDescription = 'Bubble without an operation param';
  static readonly alias = 'no-op-test';
  // '*' classifies a bubble that has no operation discriminator
  static operationMetadata: BubbleOperationMetadata | undefined = undefined;

  static performActionCount = 0;

  constructor(params: PlainParams, context?: BubbleContext) {
    super(params, context);
  }
  public async testCredential(): Promise<boolean> {
    return true;
  }
  protected chooseCredential(): string | undefined {
    return undefined;
  }
  protected async performAction(): Promise<PlainResult> {
    NoOperationBubble.performActionCount++;
    return {
      greeting: `Hello, ${this.params.name}!`,
      success: true,
      error: '',
    };
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  SdkStyleBubble.resetCounters();
  BareFetchBubble.resetCounters();
  NoOperationBubble.performActionCount = 0;
  NoOperationBubble.operationMetadata = undefined;
});

describe('sideEffect getter', () => {
  test('resolves the hint for the current operation', () => {
    const write = new SdkStyleBubble({ operation: 'send_message', text: 'x' });
    const read = new SdkStyleBubble({ operation: 'get_status', id: '1' });
    expect(write.sideEffect).toBe('write');
    expect(read.sideEffect).toBe('read');
  });

  test('defaults to write when the class declares no metadata', () => {
    const bubble = new NoOperationBubble({ name: 'a' });
    expect(bubble.sideEffect).toBe('write');
  });

  test("resolves the '*' key for bubbles without an operation param", () => {
    NoOperationBubble.operationMetadata = { '*': hint('read') };
    const bubble = new NoOperationBubble({ name: 'a' });
    expect(bubble.sideEffect).toBe('read');
  });
});

describe('test mode: SDK-client bubble (resend pattern)', () => {
  test('write-hinted op NEVER reaches performAction: no client, no credential', async () => {
    const bubble = new SdkStyleBubble(
      {
        operation: 'send_message',
        text: 'hi',
        credentials: { [CredentialType.RESEND_CRED]: 'fake-key' },
      },
      { testMode: true }
    );
    const result = await bubble.action();

    expect(SdkStyleBubble.performActionCount).toBe(0);
    expect(FakeSdkClient.constructedCount).toBe(0);
    expect(SdkStyleBubble.chooseCredentialCount).toBe(0);
    expect(result.mocked).toBe(true);
    expect(result.success).toBe(true);
    // Operation-aware mock: matches the discriminated-union option in play
    expect(result.data.operation).toBe('send_message');
    expect(() => SdkResultSchema.parse(result.data)).not.toThrow();
  });

  test('read-hinted op DOES run for real in test mode', async () => {
    const bubble = new SdkStyleBubble(
      { operation: 'get_status', id: '42' },
      { testMode: true }
    );
    const result = await bubble.action();

    expect(SdkStyleBubble.performActionCount).toBe(1);
    expect(FakeSdkClient.constructedCount).toBe(1);
    expect(result.mocked).toBeUndefined();
    expect(result.data).toMatchObject({ status: 'delivered-42' });
  });

  test('write op runs normally when testMode is off', async () => {
    const bubble = new SdkStyleBubble({
      operation: 'send_message',
      text: 'hi',
    });
    const result = await bubble.action();

    expect(SdkStyleBubble.performActionCount).toBe(1);
    expect(FakeSdkClient.constructedCount).toBe(1);
    expect(result.mocked).toBeUndefined();
    expect(result.data).toMatchObject({ messageId: 'sent-2' });
  });

  test('testMode set via executionMeta (the generated-flow path) also mocks', async () => {
    const bubble = new SdkStyleBubble(
      { operation: 'send_message', text: 'hi' },
      { executionMeta: { testMode: true } }
    );
    const result = await bubble.action();

    expect(SdkStyleBubble.performActionCount).toBe(0);
    expect(result.mocked).toBe(true);
  });
});

describe('test mode: bare-fetch bubble (github pattern)', () => {
  test('write-hinted op NEVER reaches performAction: no fetch, no credential', async () => {
    const bubble = new BareFetchBubble(
      {
        operation: 'create_record',
        name: 'x',
        credentials: { [CredentialType.GITHUB_TOKEN]: 'fake-token' },
      },
      { testMode: true }
    );
    const result = await bubble.action();

    expect(BareFetchBubble.performActionCount).toBe(0);
    expect(BareFetchBubble.fetchAttemptCount).toBe(0);
    expect(BareFetchBubble.chooseCredentialCount).toBe(0);
    expect(result.mocked).toBe(true);
    expect(result.success).toBe(true);
    expect(result.data.operation).toBe('create_record');
    expect(() => FetchResultSchema.parse(result.data)).not.toThrow();
  });

  test('read-hinted op DOES run for real in test mode', async () => {
    const bubble = new BareFetchBubble(
      { operation: 'get_record', id: '7' },
      { testMode: true }
    );
    const result = await bubble.action();

    expect(BareFetchBubble.performActionCount).toBe(1);
    expect(BareFetchBubble.fetchAttemptCount).toBe(1);
    expect(result.mocked).toBeUndefined();
    expect(result.data).toMatchObject({ value: 'value-7-anon' });
  });
});

describe('explicit per-operation write grant ("dummy-data" testing)', () => {
  test('a write runs for real ONLY with a grant matching its call-site key', async () => {
    const bubble = new BareFetchBubble(
      { operation: 'create_record', name: 'granted' },
      {
        testMode: true,
        invocationCallSiteKey: 'flow.ts:12:create#1',
        approvedWriteCallSites: ['flow.ts:12:create#1'],
      }
    );
    const result = await bubble.action();

    expect(BareFetchBubble.performActionCount).toBe(1);
    expect(result.mocked).toBeUndefined();
    expect(result.data).toMatchObject({ recordId: 'rec-granted-anon' });
  });

  test('a grant for a DIFFERENT call site does not unlock the write', async () => {
    const bubble = new BareFetchBubble(
      { operation: 'create_record', name: 'x' },
      {
        testMode: true,
        invocationCallSiteKey: 'flow.ts:12:create#1',
        approvedWriteCallSites: ['flow.ts:99:other#1'],
      }
    );
    const result = await bubble.action();

    expect(BareFetchBubble.performActionCount).toBe(0);
    expect(result.mocked).toBe(true);
  });

  test('a grant cannot fire when the bubble has no call-site identity', async () => {
    const bubble = new BareFetchBubble(
      { operation: 'create_record', name: 'x' },
      {
        testMode: true,
        approvedWriteCallSites: ['flow.ts:12:create#1'],
      }
    );
    const result = await bubble.action();

    expect(BareFetchBubble.performActionCount).toBe(0);
    expect(result.mocked).toBe(true);
  });

  test('grant also matches currentUniqueId and works via executionMeta', async () => {
    const bubble = new SdkStyleBubble(
      { operation: 'send_message', text: 'go' },
      {
        currentUniqueId: 'sdk-style-test-bubble#1',
        executionMeta: {
          testMode: true,
          approvedWriteCallSites: ['sdk-style-test-bubble#1'],
        },
      }
    );
    const result = await bubble.action();

    expect(SdkStyleBubble.performActionCount).toBe(1);
    expect(result.mocked).toBeUndefined();
  });
});

describe('recorded mock preference (Contract KB seam)', () => {
  test('a recorded real response is preferred over the generated mock', async () => {
    const recorded = {
      operation: 'send_message',
      messageId: 'recorded-real-id',
      success: true,
      error: '',
    };
    const lookups: unknown[] = [];
    const bubble = new SdkStyleBubble(
      { operation: 'send_message', text: 'hi' },
      {
        testMode: true,
        invocationCallSiteKey: 'site-1',
        recordedMockProvider: (lookup) => {
          lookups.push(lookup);
          return recorded;
        },
      }
    );
    const result = await bubble.action();

    expect(SdkStyleBubble.performActionCount).toBe(0);
    expect(result.mocked).toBe(true);
    expect(result.data).toEqual(recorded);
    expect(lookups).toEqual([
      {
        bubbleName: 'sdk-style-test-bubble',
        operation: 'send_message',
        callSiteKey: 'site-1',
      },
    ]);
  });

  test('falls back to the generated mock when no recording exists', async () => {
    const bubble = new SdkStyleBubble(
      { operation: 'send_message', text: 'hi' },
      { testMode: true, recordedMockProvider: () => undefined }
    );
    const result = await bubble.action();

    expect(result.mocked).toBe(true);
    expect(result.data.operation).toBe('send_message');
    expect(typeof (result.data as { messageId?: unknown }).messageId).toBe(
      'string'
    );
  });

  test('a broken recording store falls back instead of failing the run', async () => {
    const bubble = new SdkStyleBubble(
      { operation: 'send_message', text: 'hi' },
      {
        testMode: true,
        recordedMockProvider: () => {
          throw new Error('kb down');
        },
      }
    );
    const result = await bubble.action();

    expect(result.mocked).toBe(true);
    expect(result.success).toBe(true);
    expect(SdkStyleBubble.performActionCount).toBe(0);
  });
});

describe('fail-safe default: unclassified operations are treated as writes', () => {
  test('a bubble with no metadata is mocked in test mode', async () => {
    const bubble = new NoOperationBubble({ name: 'a' }, { testMode: true });
    const result = await bubble.action();

    expect(NoOperationBubble.performActionCount).toBe(0);
    expect(result.mocked).toBe(true);
  });

  test('read_with_side_effects is mocked (only pure reads run)', async () => {
    NoOperationBubble.operationMetadata = {
      '*': hint('read_with_side_effects'),
    };
    const bubble = new NoOperationBubble({ name: 'a' }, { testMode: true });
    const result = await bubble.action();

    expect(NoOperationBubble.performActionCount).toBe(0);
    expect(result.mocked).toBe(true);
  });
});

describe('REAL bubbles: interception is auth-agnostic (zero network attempts)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => {
      throw new Error('network attempted in test mode');
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('ResendBubble (SDK client built inside performAction) is mocked', async () => {
    const bubble = new ResendBubble(
      {
        operation: 'send_email',
        from: 'noreply@example.com',
        to: ['user@example.com'],
        subject: 'test',
        text: 'test',
        credentials: { [CredentialType.RESEND_CRED]: 'fake-key' },
      },
      { testMode: true }
    );
    const result = await bubble.action();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.mocked).toBe(true);
    expect(result.success).toBe(true);
    expect((result.data as { operation?: string }).operation).toBe(
      'send_email'
    );
  });

  test('GithubBubble (bare fetch, no client) is mocked identically', async () => {
    const bubble = new GithubBubble(
      {
        operation: 'create_issue',
        owner: 'octocat',
        repo: 'Hello-World',
        title: 'test issue',
        credentials: { [CredentialType.GITHUB_TOKEN]: 'fake-token' },
      },
      { testMode: true }
    );
    const result = await bubble.action();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.mocked).toBe(true);
    expect(result.success).toBe(true);
    expect((result.data as { operation?: string }).operation).toBe(
      'create_issue'
    );
  });
});
