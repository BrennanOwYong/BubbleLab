/**
 * Conversation-thread persistence through the real generate route.
 *
 * Acceptance criteria:
 * - AC-1: a planning run that CRASHES mid-agent still leaves the incoming
 *   conversationMessages persisted on the flow's metadata, plus an
 *   interruption marker, with lastUpdatedPhase = 'planning'.
 * - AC-2: a completed planning round appends the assistant outcome
 *   (clarification_request) to the persisted thread.
 * - AC-3: a first-round call with no messages synthesizes a user message
 *   from the prompt so the thread is never empty.
 * - AC-4: a FAILED building run still leaves the thread persisted with
 *   lastUpdatedPhase = 'building'.
 *
 * Runs against the real Hono app and real sqlite test DB. Only the LLM
 * agents (runCoffee / runBoba) are mocked — persistence is exercised for
 * real through the route.
 */
// @ts-expect-error - Bun test types
import { describe, it, expect, mock, afterAll } from 'bun:test';
import '../config/env.js';
import { db } from '../db/index.js';
import { bubbleFlows } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type {
  CoffeeMessage,
  CoffeeResponse,
  GenerationResult,
} from '@bubblelab/shared-schemas';
import * as coffeeModule from '../services/ai/coffee.js';
import * as bobaModule from '../services/ai/boba.js';

// Capture originals before any mock.module call so afterAll can restore them
const originalRunCoffee = coffeeModule.runCoffee;
const originalRunBoba = bobaModule.runBoba;

// TestApp/setup imported AFTER originals are captured (setup preloads app)
import { TestApp } from '../test/test-app.js';
import { TEST_USER_ID } from '../test/setup.js';

afterAll(() => {
  mock.module('../services/ai/coffee.js', () => ({
    ...coffeeModule,
    runCoffee: originalRunCoffee,
  }));
  mock.module('../services/ai/boba.js', () => ({
    ...bobaModule,
    runBoba: originalRunBoba,
  }));
});

async function seedFlow(name: string): Promise<number> {
  const [row] = await db
    .insert(bubbleFlows)
    .values({
      userId: TEST_USER_ID,
      name,
      description: 'conversation persistence test flow',
      prompt: 'test prompt',
      code: '',
      originalCode: '',
      bubbleParameters: {},
      workflow: null,
      inputSchema: {},
      eventType: 'webhook/http',
      cron: null,
      cronActive: false,
      defaultInputs: {},
      generationError: null,
    })
    .returning({ id: bubbleFlows.id });
  return row.id;
}

async function readMetadata(flowId: number): Promise<{
  conversationMessages?: CoffeeMessage[];
  lastUpdatedPhase?: string;
}> {
  const flow = await db.query.bubbleFlows.findFirst({
    where: eq(bubbleFlows.id, flowId),
    columns: { metadata: true },
  });
  return (flow?.metadata ?? {}) as {
    conversationMessages?: CoffeeMessage[];
    lastUpdatedPhase?: string;
  };
}

function sampleThread(): CoffeeMessage[] {
  return [
    {
      id: 'msg-user-1',
      timestamp: '2026-07-23T00:00:00.000Z',
      type: 'user',
      content: 'Build me a flow that posts to Slack',
    },
    {
      id: 'msg-clarq-1',
      timestamp: '2026-07-23T00:00:01.000Z',
      type: 'clarification_request',
      questions: [
        {
          id: 'q1',
          question: 'Which channel?',
          choices: [
            { id: 'c1', label: '#general' },
            { id: 'c2', label: '#random' },
          ],
          // Matches the zod default applied by route validation, so the
          // persisted thread round-trips toEqual against this fixture
          allowMultiple: false,
        },
      ],
    },
    {
      id: 'msg-clara-1',
      timestamp: '2026-07-23T00:00:02.000Z',
      type: 'clarification_response',
      answers: { q1: ['c1'] },
    },
  ];
}

async function postGenerate(
  phase: 'planning' | 'building',
  body: Record<string, unknown>
): Promise<string> {
  const response = await TestApp.post(
    `/bubble-flow/generate?phase=${phase}`,
    body
  );
  // Drain the SSE stream so the route handler runs to completion
  return await response.text();
}

describe('conversation thread persistence on incomplete generations', () => {
  it('AC-1: persists the thread when the planning agent crashes mid-run', async () => {
    const flowId = await seedFlow('crash-planning-flow');
    const messages = sampleThread();

    mock.module('../services/ai/coffee.js', () => ({
      ...coffeeModule,
      runCoffee: async (): Promise<CoffeeResponse> => {
        throw new Error('simulated mid-generation crash');
      },
    }));

    const sse = await postGenerate('planning', {
      prompt: 'Build me a flow that posts to Slack',
      flowId,
      messages,
    });
    expect(sse).toContain('simulated mid-generation crash');

    const metadata = await readMetadata(flowId);
    expect(metadata.lastUpdatedPhase).toBe('planning');
    const persisted = metadata.conversationMessages ?? [];
    // The 3 incoming messages survive, plus the interruption marker
    expect(persisted.length).toBe(4);
    expect(persisted.slice(0, 3)).toEqual(messages);
    expect(persisted[3].type).toBe('system');
  });

  it('AC-2: appends the clarification outcome after a completed planning round', async () => {
    const flowId = await seedFlow('clarification-planning-flow');
    const messages = sampleThread();
    const clarificationResult: CoffeeResponse = {
      type: 'clarification',
      clarification: {
        questions: [
          {
            id: 'q2',
            question: 'Scheduled or webhook?',
            choices: [
              { id: 's', label: 'Scheduled' },
              { id: 'w', label: 'Webhook' },
            ],
          },
        ],
      },
      success: true,
    };

    mock.module('../services/ai/coffee.js', () => ({
      ...coffeeModule,
      runCoffee: async (): Promise<CoffeeResponse> => clarificationResult,
    }));

    await postGenerate('planning', {
      prompt: 'Build me a flow that posts to Slack',
      flowId,
      messages,
    });

    const metadata = await readMetadata(flowId);
    expect(metadata.lastUpdatedPhase).toBe('planning');
    const persisted = metadata.conversationMessages ?? [];
    expect(persisted.length).toBe(4);
    expect(persisted.slice(0, 3)).toEqual(messages);
    expect(persisted[3].type).toBe('clarification_request');
    if (persisted[3].type === 'clarification_request') {
      expect(persisted[3].questions[0].id).toBe('q2');
    }
  });

  it('AC-3: synthesizes a user message when the first round sends no messages', async () => {
    const flowId = await seedFlow('first-round-flow');
    const planResult: CoffeeResponse = {
      type: 'plan',
      plan: {
        summary: 'Post to Slack hourly',
        steps: [
          {
            title: 'Send message',
            description: 'Post to #general',
            bubblesUsed: ['slack'],
          },
        ],
        estimatedBubbles: ['slack'],
      },
      success: true,
    };

    mock.module('../services/ai/coffee.js', () => ({
      ...coffeeModule,
      runCoffee: async (): Promise<CoffeeResponse> => planResult,
    }));

    await postGenerate('planning', {
      prompt: 'Post to Slack every hour',
      flowId,
    });

    const metadata = await readMetadata(flowId);
    const persisted = metadata.conversationMessages ?? [];
    expect(persisted.length).toBe(2);
    expect(persisted[0].type).toBe('user');
    if (persisted[0].type === 'user') {
      expect(persisted[0].content).toBe('Post to Slack every hour');
    }
    expect(persisted[1].type).toBe('plan');
  });

  it('AC-4: persists the thread when the building phase fails', async () => {
    const flowId = await seedFlow('failed-building-flow');
    const messages: CoffeeMessage[] = [
      ...sampleThread(),
      {
        id: 'msg-plan-approval-1',
        timestamp: '2026-07-23T00:00:03.000Z',
        type: 'plan_approval',
        approved: true,
      },
    ];
    const failedGeneration: GenerationResult = {
      generatedCode: '',
      isValid: false,
      success: false,
      error: 'simulated boba failure',
      toolCalls: [],
      summary: '',
      inputsSchema: '',
    };

    mock.module('../services/ai/boba.js', () => ({
      ...bobaModule,
      runBoba: async (): Promise<GenerationResult> => failedGeneration,
    }));

    await postGenerate('building', {
      prompt: 'Build me a flow that posts to Slack',
      flowId,
      messages,
      planContext: 'Plan: post to Slack',
    });

    const metadata = await readMetadata(flowId);
    expect(metadata.lastUpdatedPhase).toBe('building');
    expect(metadata.conversationMessages).toEqual(messages);

    const flow = await db.query.bubbleFlows.findFirst({
      where: eq(bubbleFlows.id, flowId),
      columns: { generationError: true },
    });
    expect(flow?.generationError).toBe('simulated boba failure');
  });
});
