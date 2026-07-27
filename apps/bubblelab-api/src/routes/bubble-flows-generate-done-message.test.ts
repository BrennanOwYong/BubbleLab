/**
 * Build-completion (workflow-done) message + setup provisioning through the
 * real generate route (building phase).
 *
 * Acceptance criteria:
 * - AC-1: a SUCCESSFUL build appends a programmatic system message to
 *   metadata.conversationMessages with kind 'workflow-done-needs-info' when
 *   required inputs are still blank, carrying timestampMs and the FULL field
 *   descriptor list; the message is also streamed as a workflow_done SSE
 *   event.
 * - AC-2: with every required input already known (defaultInputs), the
 *   message is the 'workflow-done' variant without fields.
 * - AC-3: a plan message declaring setupResources triggers provisioning; with
 *   no connected Google credential it degrades to a skipped_no_credential
 *   record (field left blank, generation unharmed).
 *
 * Runs against the real Hono app + sqlite test DB. Only runBoba is mocked —
 * validation, parsing, provisioning, and persistence run for real. No test
 * here exercises the live Sheets create call (needs a real Google
 * credential); the created path is covered in setup-provisioning.test.ts via
 * an injected creator.
 */
// @ts-expect-error - Bun test types
import { describe, it, expect, mock, afterAll } from 'bun:test';
import '../config/env.js';
import { db } from '../db/index.js';
import { bubbleFlows } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type {
  ConversationEntry,
  GenerationResult,
  WorkflowDoneMessage,
} from '@bubblelab/shared-schemas';
import { isWorkflowDoneMessage } from '@bubblelab/shared-schemas';
import type { SetupProvisioningState } from '../services/setup-provisioning.js';
import * as bobaModule from '../services/ai/boba.js';

const originalRunBoba = bobaModule.runBoba;

// TestApp/setup imported AFTER originals are captured (setup preloads app)
import { TestApp } from '../test/test-app.js';
import { TEST_USER_ID } from '../test/setup.js';

afterAll(() => {
  mock.module('../services/ai/boba.js', () => ({
    ...bobaModule,
    runBoba: originalRunBoba,
  }));
});

// Valid flow whose payload requires spreadsheetId (custom webhook payload
// fields become the flow's input schema).
const SHEETS_FLOW = `
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';
import type { WebhookEvent } from '@bubblelab/bubble-core';

export interface Output {
  ok: boolean;
}

export interface CustomWebhookPayload extends WebhookEvent {
  /**
   * Google Sheets spreadsheet the answers land in
   * @header Answers spreadsheet
   * @hint Which spreadsheet should the answers go to?
   */
  spreadsheetId: string;
}

export class SheetsAppendFlow extends BubbleFlow<'webhook/http'> {
  constructor() {
    super('sheets-append-flow', 'Appends one row');
  }

  private async appendRow(spreadsheetId: string): Promise<boolean> {
    const appender = new GoogleSheetsBubble({
      operation: 'append_values',
      spreadsheet_id: spreadsheetId,
      range: 'Sheet1!A:B',
      values: [['a', 'b']],
    });
    const result = await appender.action();
    return result.success;
  }

  async handle(payload: CustomWebhookPayload): Promise<Output> {
    const ok = await this.appendRow(payload.spreadsheetId);
    return { ok };
  }
}`;

function successfulGeneration(): GenerationResult {
  return {
    generatedCode: SHEETS_FLOW,
    isValid: true,
    success: true,
    error: '',
    toolCalls: [],
    summary: '',
    inputsSchema: '',
  };
}

async function seedFlow(
  name: string,
  defaultInputs: Record<string, unknown> = {}
): Promise<number> {
  const [row] = await db
    .insert(bubbleFlows)
    .values({
      userId: TEST_USER_ID,
      name,
      description: 'done-message test flow',
      prompt: 'test prompt',
      code: '',
      originalCode: '',
      bubbleParameters: {},
      workflow: null,
      inputSchema: {},
      eventType: 'webhook/http',
      cron: null,
      cronActive: false,
      defaultInputs,
      generationError: null,
    })
    .returning({ id: bubbleFlows.id });
  return row.id;
}

async function readFlow(flowId: number): Promise<{
  conversationMessages: ConversationEntry[];
  setupProvisioning: SetupProvisioningState;
  defaultInputs: Record<string, unknown>;
}> {
  const flow = await db.query.bubbleFlows.findFirst({
    where: eq(bubbleFlows.id, flowId),
    columns: { metadata: true, defaultInputs: true },
  });
  const metadata = (flow?.metadata ?? {}) as Record<string, unknown>;
  return {
    conversationMessages:
      (metadata.conversationMessages as ConversationEntry[]) ?? [],
    setupProvisioning:
      (metadata.setupProvisioning as SetupProvisioningState) ?? {},
    defaultInputs: (flow?.defaultInputs as Record<string, unknown>) ?? {},
  };
}

function lastMessageAsDone(messages: ConversationEntry[]): WorkflowDoneMessage {
  const last = messages[messages.length - 1];
  expect(isWorkflowDoneMessage(last)).toBe(true);
  return last as WorkflowDoneMessage;
}

async function postBuilding(body: Record<string, unknown>): Promise<string> {
  const response = await TestApp.post(
    '/bubble-flow/generate?phase=building',
    body
  );
  return await response.text();
}

describe('workflow-done message + setup provisioning on successful builds', () => {
  it('AC-1: appends the needs-info variant with fields and streams workflow_done', async () => {
    mock.module('../services/ai/boba.js', () => ({
      ...bobaModule,
      runBoba: async (): Promise<GenerationResult> => successfulGeneration(),
    }));

    const before = Date.now();
    const flowId = await seedFlow('done-needs-info-flow');
    const sse = await postBuilding({
      prompt: 'Append answers to a sheet',
      flowId,
    });

    expect(sse).toContain('"type":"workflow_done"');

    const { conversationMessages } = await readFlow(flowId);
    const done = lastMessageAsDone(conversationMessages);
    expect(done.role).toBe('system');
    expect(done.kind).toBe('workflow-done-needs-info');
    expect(done.text).toBe('Workflow done, but I still need some information');
    expect(typeof done.timestampMs).toBe('number');
    expect(done.timestampMs).toBeGreaterThanOrEqual(before);
    // header/hint come from the @header/@hint JSDoc tags on the payload
    // interface, lifted by the real BubbleParser during validation.
    expect(done.fields).toEqual([
      {
        key: 'spreadsheetId',
        header: 'Answers spreadsheet',
        hint: 'Which spreadsheet should the answers go to?',
      },
    ]);
    // The persisted entry has NO CoffeeMessage `type` field.
    expect('type' in done).toBe(false);
  });

  it('AC-2: emits the satisfied variant when required inputs are already known', async () => {
    mock.module('../services/ai/boba.js', () => ({
      ...bobaModule,
      runBoba: async (): Promise<GenerationResult> => successfulGeneration(),
    }));

    const flowId = await seedFlow('done-satisfied-flow', {
      spreadsheetId: 'sheet-preexisting',
    });
    await postBuilding({ prompt: 'Append answers to a sheet', flowId });

    const { conversationMessages, defaultInputs } = await readFlow(flowId);
    const done = lastMessageAsDone(conversationMessages);
    expect(done.kind).toBe('workflow-done');
    expect(done.text).toBe('Workflow done! Check it out now');
    expect(done.fields).toBeUndefined();
    expect(defaultInputs.spreadsheetId).toBe('sheet-preexisting');
  });

  it('AC-3: plan-declared setupResources provision (degrading without a credential)', async () => {
    mock.module('../services/ai/boba.js', () => ({
      ...bobaModule,
      runBoba: async (): Promise<GenerationResult> => successfulGeneration(),
    }));

    const flowId = await seedFlow('done-provisioning-flow');
    const messages: CoffeeMessage[] = [
      {
        id: 'msg-user-1',
        timestamp: '2026-07-27T00:00:00.000Z',
        type: 'user',
        content: 'Pipe survey answers into a new sheet',
      },
      {
        id: 'msg-plan-1',
        timestamp: '2026-07-27T00:00:01.000Z',
        type: 'plan',
        plan: {
          summary: 'Append answers into a dedicated sheet',
          steps: [
            {
              title: 'Append',
              description: 'Append a row',
              bubblesUsed: ['google-sheets'],
            },
          ],
          estimatedBubbles: ['google-sheets'],
          setupResources: [
            {
              kind: 'google_spreadsheet',
              inputKey: 'spreadsheetId',
              title: 'Survey answers',
            },
          ],
        },
      },
    ];

    await postBuilding({
      prompt: 'Pipe survey answers into a new sheet',
      flowId,
      messages,
    });

    const { conversationMessages, setupProvisioning, defaultInputs } =
      await readFlow(flowId);
    // No Google credential in the test DB -> provisioning degrades, never
    // crashes the build, and records why the field stayed blank.
    expect(setupProvisioning.spreadsheetId?.status).toBe(
      'skipped_no_credential'
    );
    expect(defaultInputs.spreadsheetId).toBeUndefined();

    const done = lastMessageAsDone(conversationMessages);
    expect(done.kind).toBe('workflow-done-needs-info');
    // The incoming thread (user + plan) precedes the done message
    expect(conversationMessages.length).toBe(3);
    const planEntry = conversationMessages[1];
    expect('type' in planEntry && planEntry.type).toBe('plan');
  });

  it('AC-4: a thread containing a prior workflow-done message round-trips through the route', async () => {
    mock.module('../services/ai/boba.js', () => ({
      ...bobaModule,
      runBoba: async (): Promise<GenerationResult> => successfulGeneration(),
    }));

    const flowId = await seedFlow('done-roundtrip-flow', {
      spreadsheetId: 'sheet-preexisting',
    });
    const priorDone: ConversationEntry = {
      role: 'system',
      kind: 'workflow-done-needs-info',
      timestampMs: 1753500000000,
      text: 'Workflow done, but I still need some information',
      fields: [
        { key: 'spreadsheetId', header: 'Answers spreadsheet', hint: '' },
      ],
    };
    const messages: ConversationEntry[] = [
      {
        id: 'msg-user-1',
        timestamp: '2026-07-27T00:00:00.000Z',
        type: 'user',
        content: 'Rebuild the flow',
      },
      priorDone,
    ];

    const sse = await postBuilding({
      prompt: 'Rebuild the flow',
      flowId,
      messages,
    });
    // Route accepted the union shape (a 400 would carry no generation events)
    expect(sse).toContain('generation_complete');

    const { conversationMessages } = await readFlow(flowId);
    // prior user + prior done + fresh done
    expect(conversationMessages.length).toBe(3);
    expect(conversationMessages[1]).toEqual(priorDone);
    const done = lastMessageAsDone(conversationMessages);
    expect(done.kind).toBe('workflow-done');
  });
});
