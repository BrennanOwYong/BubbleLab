/**
 * Run-time grounding acceptance tests (drift signal, docs-lie detection,
 * sign-off enforcement, write-set computation). The unit under test is the
 * REAL BaseBubble.action() lifecycle plus the real override registry and
 * file store — nothing in the unit under test is mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ServiceBubble } from '../types/service-bubble-class.js';
import type { BubbleContext } from '../types/bubble.js';
import { BubbleDriftError, isDriftError } from '../types/bubble-errors.js';
import {
  getSideEffectOverrideRegistry,
  SideEffectOverrideRegistry,
  FileSideEffectOverrideStore,
} from './side-effect-overrides.js';
import { computeWriteSet } from './write-set.js';
import {
  detectMutationEvidence,
  downgradeLyingRead,
} from './mutation-evidence.js';
import type {
  BubbleOperationMetadata,
  ContractDriftEvent,
  OperationSideEffectMetadata,
  ParsedBubbleWithInfo,
  SideEffect,
  SideEffectCorrectionEvent,
} from '@bubblelab/shared-schemas';
import { BubbleParameterType } from '@bubblelab/shared-schemas';

const hint = (sideEffect: SideEffect): OperationSideEffectMetadata => ({
  sideEffect,
  destructive: false,
  idempotent: false,
  confidence: 1,
  source: 'prose',
  citation: 'test fixture docs',
});

// ── Fixture bubble ───────────────────────────────────────────────────────────

const ParamsSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list_items') }),
  z.object({ operation: z.literal('create_item'), name: z.string() }),
]);

const ResultSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('list_items'),
    items: z.array(z.string()),
    success: z.boolean(),
    error: z.string(),
  }),
  z.object({
    operation: z.literal('create_item'),
    itemId: z.string(),
    success: z.boolean(),
    error: z.string(),
  }),
]);

type Params = z.output<typeof ParamsSchema>;
type Result = z.output<typeof ResultSchema>;

/** What performAction returns on the next invocation (set per test). */
let nextRealResponse: Record<string, unknown> | undefined;

class GroundingFixtureBubble extends ServiceBubble<Params, Result> {
  static readonly bubbleName = 'grounding-fixture-bubble';
  static readonly type = 'service' as const;
  static readonly service = 'test';
  static readonly authType = 'apikey' as const;
  static readonly schema = ParamsSchema;
  static readonly resultSchema = ResultSchema;
  static readonly shortDescription = 'grounding fixture';
  static readonly longDescription = 'grounding fixture';
  static readonly alias = 'grounding-fixture';
  static readonly operationMetadata: BubbleOperationMetadata = {
    list_items: hint('read'),
    create_item: hint('write'),
  };

  static performActionCount = 0;

  constructor(params: Params, context?: BubbleContext) {
    super(params, context);
  }

  public async testCredential(): Promise<boolean> {
    return true;
  }

  protected chooseCredential(): string | undefined {
    return undefined;
  }

  protected async performAction(): Promise<Result> {
    GroundingFixtureBubble.performActionCount++;
    if (nextRealResponse) {
      return nextRealResponse as unknown as Result;
    }
    if (this.params.operation === 'list_items') {
      return {
        operation: 'list_items',
        items: ['a', 'b'],
        success: true,
        error: '',
      };
    }
    return {
      operation: 'create_item',
      itemId: 'item-1',
      success: true,
      error: '',
    };
  }
}

const registry = getSideEffectOverrideRegistry();

beforeEach(() => {
  registry.clear();
  nextRealResponse = undefined;
  GroundingFixtureBubble.performActionCount = 0;
});

afterEach(() => {
  registry.clear();
});

// ── Drift signal (OUTPUT_MISMATCH) ───────────────────────────────────────────

describe('contract drift signal', () => {
  it('a real response violating resultSchema throws BubbleDriftError with code OUTPUT_MISMATCH and deviations', async () => {
    nextRealResponse = {
      operation: 'list_items',
      items: 'not-an-array',
      success: true,
      error: '',
    };
    const bubble = new GroundingFixtureBubble({ operation: 'list_items' });

    const thrown = await bubble.action().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(BubbleDriftError);
    const drift = thrown as BubbleDriftError;
    expect(drift.code).toBe('OUTPUT_MISMATCH');
    expect(drift.name).toBe('BubbleDriftError');
    expect(drift.operation).toBe('list_items');
    expect(drift.deviations.length).toBeGreaterThan(0);
    expect(drift.deviations.some((d) => d.path.includes('items'))).toBe(true);
    expect(isDriftError(drift)).toBe(true);
  });

  it('the drift observer receives the event BEFORE the throw, so a consumer exists even if flow code catches', async () => {
    nextRealResponse = {
      operation: 'list_items',
      items: 42,
      success: true,
      error: '',
    };
    const events: ContractDriftEvent[] = [];
    const bubble = new GroundingFixtureBubble(
      { operation: 'list_items' },
      {
        executionMeta: { onContractDrift: (e) => events.push(e) },
      } as BubbleContext
    );

    // Flow code swallowing the error must not lose the signal.
    try {
      await bubble.action();
    } catch {
      /* swallowed, like user flow code would */
    }
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe('OUTPUT_MISMATCH');
    expect(events[0].bubbleName).toBe('grounding-fixture-bubble');
    expect(events[0].operation).toBe('list_items');
    expect(events[0].deviations.length).toBeGreaterThan(0);
  });

  it('input validation failure stays a plain BubbleValidationError — drift is DISTINCT', () => {
    let thrown: unknown;
    try {
      new GroundingFixtureBubble({
        operation: 'create_item',
      } as unknown as Params);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(isDriftError(thrown)).toBe(false);
    expect((thrown as { code?: string }).code).toBeUndefined();
  });

  it('isDriftError recognizes the code across module-instance boundaries (structural, not instanceof)', () => {
    const foreign = new Error('Result contract drift');
    (foreign as unknown as { code: string }).code = 'OUTPUT_MISMATCH';
    expect(isDriftError(foreign)).toBe(true);
    expect(isDriftError(new Error('generic'))).toBe(false);
  });
});

// ── Docs-lie detection + persisted reclassification ─────────────────────────

describe('docs-lie detection', () => {
  it('a doc-said-read op returning HTTP 201 is reclassified to read_with_side_effects (source observed) and never re-learned', async () => {
    nextRealResponse = {
      operation: 'list_items',
      items: ['a'],
      success: true,
      error: '',
      statusCode: 201,
    };
    const corrections: SideEffectCorrectionEvent[] = [];
    const context = {
      executionMeta: {
        onSideEffectCorrection: (e: SideEffectCorrectionEvent) =>
          corrections.push(e),
      },
    } as BubbleContext;

    const first = new GroundingFixtureBubble(
      { operation: 'list_items' },
      context
    );
    expect(first.sideEffect).toBe('read'); // docs say read
    await first.action();

    // Reclassified with runtime-verified provenance
    const override = registry.get('grounding-fixture-bubble', 'list_items');
    expect(override?.sideEffect).toBe('read_with_side_effects');
    expect(override?.source).toBe('observed');
    expect(corrections).toHaveLength(1);
    expect(corrections[0].previous?.sideEffect).toBe('read');

    // The correction outranks the docs for every later instance
    const second = new GroundingFixtureBubble(
      { operation: 'list_items' },
      context
    );
    expect(second.sideEffect).toBe('read_with_side_effects');
    expect(second.operationSideEffectMetadata?.source).toBe('observed');

    // Never re-learned: running again records no second correction
    nextRealResponse = undefined;
    await second.action().catch(() => undefined);
    expect(corrections).toHaveLength(1);
  });

  it('a clean read (no creation marker, no probe) is NOT reclassified — honest about detectability', async () => {
    const bubble = new GroundingFixtureBubble({ operation: 'list_items' });
    await bubble.action();
    expect(
      registry.get('grounding-fixture-bubble', 'list_items')
    ).toBeUndefined();
  });

  it('a caller-supplied before/after state probe catches a mutating read with no response markers', async () => {
    let state = 0;
    const context = {
      executionMeta: {
        // The "state" the read secretly mutates: differs before/after.
        mutationProbe: () => ({ state: state++ }),
      },
    } as BubbleContext;
    const bubble = new GroundingFixtureBubble(
      { operation: 'list_items' },
      context
    );
    await bubble.action();

    const override = registry.get('grounding-fixture-bubble', 'list_items');
    expect(override?.sideEffect).toBe('read_with_side_effects');
    expect(override?.source).toBe('observed');
  });

  it('the reclassified operation is now mocked in test mode — the corrected hint feeds the write gates', async () => {
    registry.record({
      bubbleName: 'grounding-fixture-bubble',
      operation: 'list_items',
      metadata: downgradeLyingRead(hint('read'), 'observed in earlier run'),
      evidence: 'observed in earlier run',
      observedAt: new Date().toISOString(),
    });
    const bubble = new GroundingFixtureBubble(
      { operation: 'list_items' },
      { testMode: true } as BubbleContext
    );
    const result = await bubble.action();
    expect(result.mocked).toBe(true);
    expect(GroundingFixtureBubble.performActionCount).toBe(0);
  });

  it('detectMutationEvidence: bare ids are never evidence; explicit markers are', () => {
    expect(detectMutationEvidence({ id: 'abc', items: [] }).detected).toBe(
      false
    );
    expect(detectMutationEvidence({ statusCode: 200 }).detected).toBe(false);
    expect(detectMutationEvidence({ statusCode: 201 }).detected).toBe(true);
    expect(detectMutationEvidence({ created: true }).detected).toBe(true);
    expect(detectMutationEvidence({ createdId: 'x1' }).detected).toBe(true);
    expect(
      detectMutationEvidence({ data: { statusCode: 201 } }).detected
    ).toBe(true);
  });
});

// ── Persistence across processes (file store) ───────────────────────────────

describe('override persistence across runs', () => {
  it('a correction recorded through a file store is loaded by a fresh registry (new process)', async () => {
    const storePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'se-overrides-')),
      'overrides.json'
    );

    // "Process 1": learn the correction and persist it
    const processOne = new SideEffectOverrideRegistry();
    await processOne.configureStore(new FileSideEffectOverrideStore(storePath));
    const recorded = processOne.record({
      bubbleName: 'grounding-fixture-bubble',
      operation: 'list_items',
      metadata: downgradeLyingRead(hint('read'), 'HTTP 201 Created status'),
      evidence: 'HTTP 201 Created status',
      observedAt: new Date().toISOString(),
    });
    expect(recorded).toBe(true);
    // save() is fire-and-forget; give the microtask queue a beat
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(storePath)).toBe(true);

    // "Process 2": a fresh registry loads the persisted correction
    const processTwo = new SideEffectOverrideRegistry();
    await processTwo.configureStore(new FileSideEffectOverrideStore(storePath));
    const loaded = processTwo.get('grounding-fixture-bubble', 'list_items');
    expect(loaded?.sideEffect).toBe('read_with_side_effects');
    expect(loaded?.source).toBe('observed');

    // Never re-learned: process 2 refuses to record it again
    expect(
      processTwo.record({
        bubbleName: 'grounding-fixture-bubble',
        operation: 'list_items',
        metadata: downgradeLyingRead(hint('read'), 'again'),
        evidence: 'again',
        observedAt: new Date().toISOString(),
      })
    ).toBe(false);
  });
});

// ── Sign-off enforcement in the base class (defense in depth) ───────────────

describe('write sign-off enforcement (real runs)', () => {
  const enforceContext = (
    approved: string[],
    ids: { variableId?: number; currentUniqueId?: string }
  ): BubbleContext =>
    ({
      ...ids,
      executionMeta: {
        enforceWriteSignOff: true,
        approvedWriteCallSites: approved,
      },
    }) as BubbleContext;

  it('an unapproved write-hinted operation is mocked — it CANNOT execute', async () => {
    const bubble = new GroundingFixtureBubble(
      { operation: 'create_item', name: 'x' },
      enforceContext([], { variableId: 42 })
    );
    const result = await bubble.action();
    expect(result.mocked).toBe(true);
    expect(GroundingFixtureBubble.performActionCount).toBe(0);
  });

  it('an approved write executes for real (String(variableId) identity)', async () => {
    const bubble = new GroundingFixtureBubble(
      { operation: 'create_item', name: 'x' },
      enforceContext(['42'], { variableId: 42 })
    );
    const result = await bubble.action();
    expect(result.mocked).toBeUndefined();
    expect(GroundingFixtureBubble.performActionCount).toBe(1);
  });

  it('a child of an approved call site is covered (prefix on currentUniqueId), a stranger is not', async () => {
    const child = new GroundingFixtureBubble(
      { operation: 'create_item', name: 'x' },
      enforceContext(['ai-agent#1'], {
        currentUniqueId: 'ai-agent#1.grounding-fixture-bubble#1',
      })
    );
    expect((await child.action()).mocked).toBeUndefined();

    const stranger = new GroundingFixtureBubble(
      { operation: 'create_item', name: 'x' },
      enforceContext(['ai-agent#1'], {
        currentUniqueId: 'other-agent#1.grounding-fixture-bubble#1',
      })
    );
    expect((await stranger.action()).mocked).toBe(true);
  });

  it('reads run untouched under enforcement', async () => {
    const bubble = new GroundingFixtureBubble(
      { operation: 'list_items' },
      enforceContext([], { variableId: 42 })
    );
    const result = await bubble.action();
    expect(result.mocked).toBeUndefined();
    expect(GroundingFixtureBubble.performActionCount).toBe(1);
  });
});

// ── Write-set computation ────────────────────────────────────────────────────

describe('computeWriteSet', () => {
  const parsedBubble = (
    overrides: Partial<ParsedBubbleWithInfo> & { variableId: number }
  ): ParsedBubbleWithInfo => ({
    variableName: 'b',
    bubbleName: 'grounding-fixture-bubble' as ParsedBubbleWithInfo['bubbleName'],
    className: 'GroundingFixtureBubble',
    parameters: [],
    hasAwait: true,
    hasActionCall: true,
    nodeType: 'service',
    location: { startLine: 1, startCol: 1, endLine: 1, endCol: 10 },
    ...overrides,
  });

  const lookup = (name: string) =>
    name === 'grounding-fixture-bubble'
      ? GroundingFixtureBubble.operationMetadata
      : undefined;

  it('classified writes are listed with citation; classified reads are not', () => {
    const writeSet = computeWriteSet(
      {
        '1': parsedBubble({
          variableId: 1,
          parameters: [
            {
              name: 'operation',
              value: 'create_item',
              type: BubbleParameterType.STRING,
            },
          ],
        }),
        '2': parsedBubble({
          variableId: 2,
          parameters: [
            {
              name: 'operation',
              value: 'list_items',
              type: BubbleParameterType.STRING,
            },
          ],
        }),
      },
      lookup
    );
    expect(writeSet).toHaveLength(1);
    expect(writeSet[0].operation).toBe('create_item');
    expect(writeSet[0].sideEffect).toBe('write');
    expect(writeSet[0].aliasKeys).toContain('1');
    expect(writeSet[0].reason).toContain('test fixture docs');
  });

  it('fail-safe: non-literal operations, unknown operations, and metadata-less bubbles are writes', () => {
    const writeSet = computeWriteSet(
      {
        '1': parsedBubble({
          variableId: 1,
          parameters: [
            {
              name: 'operation',
              value: 'someVariable',
              type: BubbleParameterType.VARIABLE,
            },
          ],
        }),
        '2': parsedBubble({
          variableId: 2,
          parameters: [
            {
              name: 'operation',
              value: 'not_a_real_op',
              type: BubbleParameterType.STRING,
            },
          ],
        }),
        '3': parsedBubble({
          variableId: 3,
          bubbleName: 'ai-agent' as ParsedBubbleWithInfo['bubbleName'],
        }),
      },
      lookup
    );
    expect(writeSet).toHaveLength(3);
    expect(writeSet.every((e) => e.sideEffect === 'write')).toBe(true);
  });

  it('a runtime-verified correction pulls a documented read INTO the write set', () => {
    registry.record({
      bubbleName: 'grounding-fixture-bubble',
      operation: 'list_items',
      metadata: downgradeLyingRead(hint('read'), 'observed mutation'),
      evidence: 'observed mutation',
      observedAt: new Date().toISOString(),
    });
    const writeSet = computeWriteSet(
      {
        '1': parsedBubble({
          variableId: 1,
          parameters: [
            {
              name: 'operation',
              value: 'list_items',
              type: BubbleParameterType.STRING,
            },
          ],
        }),
      },
      lookup
    );
    expect(writeSet).toHaveLength(1);
    expect(writeSet[0].sideEffect).toBe('read_with_side_effects');
    expect(writeSet[0].reason).toContain('runtime-verified');
  });

  it('a pure-read flow yields an empty write set (no sign-off needed)', () => {
    const writeSet = computeWriteSet(
      {
        '1': parsedBubble({
          variableId: 1,
          parameters: [
            {
              name: 'operation',
              value: 'list_items',
              type: BubbleParameterType.STRING,
            },
          ],
        }),
      },
      lookup
    );
    expect(writeSet).toHaveLength(0);
  });
});
