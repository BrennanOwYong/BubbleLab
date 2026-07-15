/**
 * Run-time grounding through the REAL generated-code path (temp-file import):
 * - the OUTPUT_MISMATCH drift signal survives the BubbleRunner wrapper
 *   boundary as a distinct errorCode + structured drift events, including
 *   when flow code catches the thrown error;
 * - enforceWriteSignOff blocks unapproved writes end-to-end, and the keys
 *   computeWriteSet emits are the keys the runtime grant matching accepts;
 * - Phase-1 authoring (parse, credential discovery, write-set computation,
 *   mock generation) issues ZERO network calls and touches no credentials.
 */

import { BubbleRunner } from './BubbleRunner';
import { BubbleScript } from '../parse/BubbleScript';
import { BubbleInjector } from '../injection/BubbleInjector';
import { getFixture } from '../../tests/fixtures/index.js';
import {
  BubbleFactory,
  HelloWorldBubble,
  computeWriteSet,
  MockDataGenerator,
} from '@bubblelab/bubble-core';
import type { BubbleName } from '@bubblelab/shared-schemas';

const HOOK_TIMEOUT = 600_000; // registerDefaults scans ~287 files; minutes on WSL /mnt/c
const TEST_TIMEOUT = 600_000;

describe('BubbleRunner run-time grounding', () => {
  const bubbleFactory = new BubbleFactory();
  const helloWorldScript = getFixture('hello-world');

  beforeAll(async () => {
    await bubbleFactory.registerDefaults();
  }, HOOK_TIMEOUT);

  const originalPerformAction = (
    HelloWorldBubble.prototype as unknown as Record<string, unknown>
  )['performAction'];

  afterEach(() => {
    (HelloWorldBubble.prototype as unknown as Record<string, unknown>)[
      'performAction'
    ] = originalPerformAction;
  });

  const patchHelloWorldToDrift = () => {
    // The temp-file module resolves the SAME bubble-core instance, so this
    // prototype patch is what the generated flow executes: a REAL response
    // that violates HelloWorldBubble's declared resultSchema (greeting missing).
    (HelloWorldBubble.prototype as unknown as Record<string, unknown>)[
      'performAction'
    ] = async () => ({ success: true, error: '' });
  };

  it(
    'drift survives the wrapper boundary: distinct errorCode OUTPUT_MISMATCH + structured events, not a generic failure',
    async () => {
      patchHelloWorldToDrift();
      const runner = new BubbleRunner(helloWorldScript, bubbleFactory, {
        pricingTable: {},
      });
      const result = await runner.runAll();

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('OUTPUT_MISMATCH');
      expect(result.drift).toBeDefined();
      expect(result.drift!.length).toBeGreaterThan(0);
      expect(result.drift![0].bubbleName).toBe('hello-world');
      expect(result.drift![0].code).toBe('OUTPUT_MISMATCH');
      expect(
        result.drift![0].deviations.some((d) => d.path.includes('greeting'))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    'drift survives even when FLOW CODE catches the error (the reference-build bug this port must not repeat)',
    async () => {
      patchHelloWorldToDrift();
      const catchingFlow = `
import { BubbleFlow, HelloWorldBubble, WebhookEvent } from '@bubblelab/bubble-core';

export class CatchingFlow extends BubbleFlow<'webhook/http'> {
  async handle(_payload: WebhookEvent) {
    try {
      const greeting = new HelloWorldBubble({ message: 'Hello', name: 'World' });
      await greeting.action();
    } catch {
      // user flow code swallows the drift error
    }
    return { done: true };
  }
}
`;
      const runner = new BubbleRunner(catchingFlow, bubbleFactory, {
        pricingTable: {},
      });
      const result = await runner.runAll();

      // The flow completed (error swallowed) — but the drift signal reached
      // its consumer anyway, via the observer channel.
      expect(result.success).toBe(true);
      expect(result.drift).toBeDefined();
      expect(result.drift!.length).toBeGreaterThan(0);
      expect(result.drift![0].code).toBe('OUTPUT_MISMATCH');
      expect(result.drift![0].bubbleName).toBe('hello-world');
    },
    TEST_TIMEOUT
  );

  it(
    'enforceWriteSignOff: the write-default bubble is MOCKED without approval, and executes with the write-set keys',
    async () => {
      // Unapproved: blocked (mocked), performAction never runs.
      const blockedRunner = new BubbleRunner(helloWorldScript, bubbleFactory, {
        pricingTable: {},
        enforceWriteSignOff: true,
        approvedWriteCallSites: [],
      });
      const blocked = await blockedRunner.runAll();
      expect(blocked.success).toBe(true);
      expect((blocked.data as { mocked?: boolean }).mocked).toBe(true);

      // Approved with EXACTLY the identities computeWriteSet emits — proving
      // parse-time keys match runtime grant matching end-to-end.
      const script = new BubbleScript(helloWorldScript, bubbleFactory);
      const writeSet = computeWriteSet(
        script.getParsedBubbles(),
        (name) => bubbleFactory.getMetadata(name as BubbleName)?.operationMetadata
      );
      expect(writeSet.length).toBe(1); // hello-world: no metadata → fail-safe write
      const approvedRunner = new BubbleRunner(helloWorldScript, bubbleFactory, {
        pricingTable: {},
        enforceWriteSignOff: true,
        approvedWriteCallSites: writeSet.flatMap((e) => e.aliasKeys),
      });
      const approved = await approvedRunner.runAll();
      expect(approved.success).toBe(true);
      const flowReturn = approved.data as {
        mocked?: boolean;
        data?: { greeting?: string };
      };
      expect(flowReturn.mocked).toBeUndefined();
      expect(flowReturn.data?.greeting).toBe('Hello, World! World!');
    },
    TEST_TIMEOUT
  );

  it(
    'Phase-1 authoring is grounded on mocks alone: parse + credential discovery + write set + mock generation issue ZERO network calls',
    async () => {
      const fetchCalls: unknown[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((...args: unknown[]) => {
        fetchCalls.push(args);
        throw new Error('Network access attempted during authoring');
      }) as typeof fetch;

      try {
        const script = new BubbleScript(helloWorldScript, bubbleFactory);
        const injector = new BubbleInjector(script);
        const credentialReqs = injector.findCredentials();
        const writeSet = computeWriteSet(
          script.getParsedBubbles(),
          (name) =>
            bubbleFactory.getMetadata(name as BubbleName)?.operationMetadata
        );
        const metadata = bubbleFactory.getMetadata(
          'hello-world' as BubbleName
        );
        const mock = MockDataGenerator.generateMockResult(
          metadata!.resultSchema as never
        );

        expect(credentialReqs).toBeDefined();
        expect(writeSet.length).toBe(1);
        expect(mock).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(fetchCalls).toHaveLength(0);
    },
    TEST_TIMEOUT
  );
});
