import { db } from '../db/index.js';
import { bubbleFlowExecutions, bubbleFlows, users } from '../db/schema.js';
import {
  runBubbleFlowWithStreaming,
  type StreamingExecutionOptions,
} from './execution.js';
import {
  ParsedBubbleWithInfo,
  cleanUpObjectForDisplayAndStorage,
  type StreamingLogEvent,
  type StreamCallback,
} from '@bubblelab/shared-schemas';
import type { ExecutionResult } from '@bubblelab/shared-schemas';

import { eq, and, sql } from 'drizzle-orm';
import type { BubbleTriggerEventRegistry } from '@bubblelab/bubble-core';
import { AppType } from '../config/clerk-apps.js';
import { getPricingTable } from '../config/pricing.js';
import { autoBindMissingCredentials } from './credential-auto-bind.js';

export interface ExecutionPayload {
  type: keyof BubbleTriggerEventRegistry;
  timestamp: string;
  path: string;
  method?: string;
  executionId: string;
  headers?: Record<string, string>;
  body?: unknown;
  [key: string]: unknown; // Allow additional properties for BubbleTriggerEvent compatibility
}

export interface ExecutionOptions {
  userId: string;
  systemCredentials?: Record<string, string>;
  appType?: AppType;
  pricingTable: Record<string, { unit: string; unitCost: number }>;
}

// Use shared prepareForStorage for payload and result

/**
 * Executes a BubbleFlow triggered by webhook and updates execution counters
 */
export async function executeBubbleFlowViaWebhook(
  bubbleFlowId: number,
  payload: ExecutionPayload,
  options: ExecutionOptions
): Promise<ExecutionResult> {
  const result = await executeBubbleFlowWithTracking(
    bubbleFlowId,
    payload,
    options
  );

  // Update webhook execution counters
  if (result.success) {
    await db
      .update(bubbleFlows)
      .set({
        webhookExecutionCount: sql`${bubbleFlows.webhookExecutionCount} + 1`,
      })
      .where(eq(bubbleFlows.id, bubbleFlowId));
  } else {
    await db
      .update(bubbleFlows)
      .set({
        webhookExecutionCount: sql`${bubbleFlows.webhookExecutionCount} + 1`,
        webhookFailureCount: sql`${bubbleFlows.webhookFailureCount} + 1`,
      })
      .where(eq(bubbleFlows.id, bubbleFlowId));
  }

  return result;
}

/**
 * Executes a BubbleFlow and handles the database operations.
 * Supports both streaming and non-streaming execution.
 */
export async function executeBubbleFlowWithTracking(
  bubbleFlowId: number,
  payload: ExecutionPayload,
  options: StreamingExecutionOptions
): Promise<ExecutionResult> {
  // find the user in the user table and get the app type of the user
  const user = await db.query.users.findFirst({
    where: and(eq(users.clerkId, options.userId)),
  });

  if (!user) {
    throw new Error('Invalid user');
  }

  const appType = user.appType as AppType;

  // Get BubbleFlow from database (only if it belongs to the user)
  const flow = await db.query.bubbleFlows.findFirst({
    where: and(
      eq(bubbleFlows.id, bubbleFlowId),
      eq(bubbleFlows.userId, options.userId)
    ),
  });

  if (!flow) {
    throw new Error(
      'Something went wrong, please recreate the flow. If the problem persists, please contact Nodex support.'
    );
  }

  // Single-match backstop: fill unbound required-credential slots the user's
  // credentials decide unambiguously, and persist the bindings so every later
  // path (editor load, webhook, cron) sees them. Without this, a flow whose
  // stored bindings were never persisted (e.g. created before the credential
  // was connected) fails server-side execution despite an obvious match.
  const flowBubbleParameters = flow.bubbleParameters as Record<
    string,
    ParsedBubbleWithInfo
  >;
  const autoBind = await autoBindMissingCredentials(
    options.userId,
    flowBubbleParameters
  );
  if (autoBind.bound.length > 0) {
    await db
      .update(bubbleFlows)
      .set({ bubbleParameters: autoBind.bubbleParameters })
      .where(eq(bubbleFlows.id, bubbleFlowId));
  }

  // Create execution record
  const execResult = await db
    .insert(bubbleFlowExecutions)
    .values({
      bubbleFlowId,
      payload: cleanUpObjectForDisplayAndStorage(payload),
      status: 'running',
      code: flow.originalCode,
    })
    .returning();

  // Always collect streaming events for storage in executionLogs
  // This ensures logs are available for history replay regardless of streaming
  const collectedEvents: StreamingLogEvent[] = [];
  const originalCallback = options.streamCallback;

  // Create a collection callback that always captures events
  // If streaming is enabled, also forward to the original callback
  const collectionCallback: StreamCallback = async (
    event: StreamingLogEvent
  ) => {
    collectedEvents.push(event);
    if (originalCallback) {
      await originalCallback(event);
    }
  };

  // Pre-flight credential check (S1): every required non-platform,
  // non-optional slot still unbound after auto-bind means no matching
  // connected account exists — the run WILL fail at that bubble. Emit an
  // observable warn event up front (streamed + persisted in executionLogs)
  // instead of letting the failure surface only as a deep bubble error.
  for (const slot of autoBind.unbound) {
    const bubbleName =
      flowBubbleParameters[slot.bubbleKey]?.bubbleName ?? slot.bubbleKey;
    await collectionCallback({
      type: 'warn',
      timestamp: new Date().toISOString(),
      message: `Credential pre-flight: no connected account satisfies ${slot.credentialType} required by ${bubbleName}`,
      additionalData: {
        preflight: 'missing_credential',
        bubbleKey: slot.bubbleKey,
        credentialType: slot.credentialType,
      },
    });
  }

  try {
    // Always use streaming execution to capture logs
    // The collectionCallback will collect events regardless of whether
    // we're streaming to a client (webhook, cron, manual all get logged)
    const result = await runBubbleFlowWithStreaming(
      flow.originalCode!, // Use original TypeScript code
      autoBind.bubbleParameters,
      payload,
      {
        userId: options.userId,
        streamCallback: collectionCallback,
        useWebhookLogger: options.useWebhookLogger,
        pricingTable: getPricingTable(),
        appType: appType,
        testMode: options.testMode,
        approvedWriteCallSites: options.approvedWriteCallSites,
      }
    );

    // Update execution record with result and collected logs
    await db
      .update(bubbleFlowExecutions)
      .set({
        result: cleanUpObjectForDisplayAndStorage({
          data: result.data,
          ...result.summary,
        }),
        error: result.success ? null : result.error,
        status: result.success ? 'success' : 'error',
        executionLogs: collectedEvents.length > 0 ? collectedEvents : null,
        completedAt: new Date(),
      })
      .where(eq(bubbleFlowExecutions.id, execResult[0].id));

    return {
      executionId: execResult[0].id,
      success: result.success,
      data: originalCallback
        ? result.summary || 'Execution completed without logging'
        : result.data,
      error: result.error,
    };
  } catch (error) {
    // Update execution record with error and collected logs
    const errorMessage = error instanceof Error ? error.message : String(error);

    await db
      .update(bubbleFlowExecutions)
      .set({
        result: null,
        error: errorMessage,
        status: 'error',
        executionLogs: collectedEvents.length > 0 ? collectedEvents : null,
        completedAt: new Date(),
      })
      .where(eq(bubbleFlowExecutions.id, execResult[0].id));

    return {
      executionId: execResult[0].id,
      success: false,
      error: errorMessage,
    };
  }
}
