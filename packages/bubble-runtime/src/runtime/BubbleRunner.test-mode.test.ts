/**
 * Proves the testMode flag threads from BubbleRunnerOptions through the
 * existing executionMeta channel (parameter-formatter injects
 * `executionMeta: __bubbleFlowSelf?.__executionMeta__` into every bubble's
 * BubbleContext) into BaseBubble.action() — with NO additional source
 * rewriting. HelloWorldBubble declares no operationMetadata, so it resolves
 * to the fail-safe 'write' default and must be mocked in test mode.
 */

import { BubbleRunner } from './BubbleRunner';
import { getFixture } from '../../tests/fixtures/index.js';
import { BubbleFactory } from '@bubblelab/bubble-core';

describe('BubbleRunner test-mode threading (no source rewriting)', () => {
  const bubbleFactory = new BubbleFactory();
  const helloWorldScript = getFixture('hello-world');

  beforeEach(async () => {
    await bubbleFactory.registerDefaults();
  });

  it('testMode: write-default bubble returns a mock through the generated-code path', async () => {
    const runner = new BubbleRunner(helloWorldScript, bubbleFactory, {
      pricingTable: {},
      testMode: true,
    });
    const result = await runner.runAll();

    expect(result.success).toBe(true);
    const flowReturn = result.data as {
      mocked?: boolean;
      success?: boolean;
      data?: { greeting?: unknown };
    };
    expect(flowReturn.mocked).toBe(true);
    expect(flowReturn.success).toBe(true);
    // Schema-derived mock, not the real computed greeting
    expect(typeof flowReturn.data?.greeting).toBe('string');
    expect(flowReturn.data?.greeting).not.toBe('Hello, World! World!');
  });

  it('without testMode the same flow executes for real', async () => {
    const runner = new BubbleRunner(helloWorldScript, bubbleFactory, {
      pricingTable: {},
    });
    const result = await runner.runAll();

    expect(result.success).toBe(true);
    const flowReturn = result.data as {
      mocked?: boolean;
      data?: { greeting?: unknown };
    };
    expect(flowReturn.mocked).toBeUndefined();
    expect(flowReturn.data?.greeting).toBe('Hello, World! World!');
  });

  it('approvedWriteCallSites in options rides the same executionMeta channel', async () => {
    const runner = new BubbleRunner(helloWorldScript, bubbleFactory, {
      pricingTable: {},
      testMode: true,
      approvedWriteCallSites: ['some-call-site'],
    });
    const result = await runner.runAll();

    // Grant names a different call site — the write-default bubble stays mocked
    expect(result.success).toBe(true);
    expect((result.data as { mocked?: boolean }).mocked).toBe(true);
  });
});
