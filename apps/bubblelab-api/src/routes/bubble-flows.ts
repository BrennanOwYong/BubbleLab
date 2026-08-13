import { OpenAPIHono, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { db } from '../db/index.js';
import {
  bubbleFlows,
  webhooks,
  bubbleFlowExecutions,
  users,
  userCredentials,
} from '../db/schema.js';
import { validateBubbleFlow } from '../services/validation.js';
import { processUserCode } from '../services/code-processor.js';
import { getWebhookUrl, generateWebhookPath } from '../utils/webhook.js';
import {
  extractRequiredCredentials,
  extractUnresolvedToolDetections,
  generateDisplayedBubbleParameters,
  mergeCredentialsByBubbleName,
  isSystemCredential,
} from '../services/bubble-flow-parser.js';
import { injectCredentialsIntoBubbleParameters } from '../utils/bubble-parameters.js';
import {
  isInvocationClone,
  type CredentialType,
  type FlowScopeAudit,
  type ParsedBubbleWithInfo,
  type ParsedWorkflow,
} from '@bubblelab/shared-schemas';
import { platformProvidedCredentialTypes } from '../services/platform-credentials.js';
import {
  computeOauthStatus,
  type OauthStatus,
} from '../services/oauth-status.js';
import {
  auditFlowScopes,
  discoverFlowScopeRequirements,
} from '../services/scope-audit-service.js';
import { getUserId, getAppType } from '../middleware/auth.js';
import { eq, and, count } from 'drizzle-orm';
import { isValidBubbleTriggerEvent } from '@bubblelab/shared-schemas';
import {
  createBubbleFlowRoute,
  createEmptyBubbleFlowRoute,
  executeBubbleFlowRoute,
  executeBubbleFlowStreamRoute,
  testBubbleFlowRoute,
  getBubbleFlowRoute,
  updateBubbleFlowRoute,
  updateBubbleFlowNameRoute,
  updatePrimaryOutputRoute,
  listBubbleFlowsRoute,
  activateBubbleFlowRoute,
  deactivateBubbleFlowRoute,
  deleteBubbleFlowRoute,
  listBubbleFlowExecutionsRoute,
  getBubbleFlowExecutionDetailRoute,
  validateBubbleFlowCodeRoute,
  runContextFlowRoute,
} from '../schemas/bubble-flows.js';

import { createBubbleFlowResponseSchema } from '../schemas/index.js';
import {
  setupErrorHandler,
  validationErrorHook,
} from '../utils/error-handler.js';
import { getCurrentWebhookUsage } from '../services/subscription-validation.js';
import { executeBubbleFlowWithTracking } from '../services/bubble-flow-execution.js';
import {
  autoBindMissingCredentials,
  unionTwinCredentials,
} from '../services/credential-auto-bind.js';
import { resolveAccountEmailDefaults } from '../services/account-email-defaults.js';
// user-profile lane: "for me" input prefill (see user-profile-defaults.ts)
import { resolveUserProfileDefaults } from '../services/user-profile-defaults.js';
import { runBubbleFlow } from '../services/execution.js';
import { BubbleScript, validateAndExtract } from '@bubblelab/bubble-runtime';
import { getBubbleFactory } from '../services/bubble-factory-instance.js';
import { PRICING_TABLE } from '../config/pricing.js';

const app = new OpenAPIHono({
  defaultHook: validationErrorHook,
});
setupErrorHandler(app);

app.openapi(listBubbleFlowsRoute, async (c) => {
  const userId = getUserId(c);
  // Fetch both bubble flows and user data in parallel
  const [flows, userData] = await Promise.all([
    db.query.bubbleFlows.findMany({
      where: eq(bubbleFlows.userId, userId),
      columns: {
        id: true,
        name: true,
        description: true,
        eventType: true,
        webhookExecutionCount: true,
        webhookFailureCount: true,
        cronActive: true,
        createdAt: true,
        cron: true,
        updatedAt: true,
        originalCode: true,
        bubbleParameters: true,
        userId: true,
      },
      with: {
        webhooks: {
          columns: {
            isActive: true,
          },
        },
      },
    }),
    db.query.users.findFirst({
      where: eq(users.clerkId, userId),
      columns: {
        monthlyUsageCount: true,
      },
    }),
  ]);

  // Get execution counts for all flows
  const flowIds = flows.map((flow) => flow.id);
  const executionCounts = await Promise.all(
    flowIds.map(async (flowId) => {
      const result = await db
        .select({ count: count() })
        .from(bubbleFlowExecutions)
        .where(eq(bubbleFlowExecutions.bubbleFlowId, flowId));
      return { flowId, count: result[0]?.count || 0 };
    })
  );

  // Create a map for quick lookup
  const executionCountMap = new Map(
    executionCounts.map((item) => [item.flowId, item.count])
  );

  const bubbleFlowsData = flows.map((flow) => {
    // Extract bubble information from bubbleParameters
    const bubbleParameters = flow.bubbleParameters as Record<
      string,
      ParsedBubbleWithInfo
    > | null;
    const bubbles = bubbleParameters
      ? Object.values(bubbleParameters).map((bubble) => ({
          bubbleName: bubble.bubbleName,
          className: bubble.className,
        }))
      : [];

    return {
      id: flow.id,
      name: flow.name,
      description: flow.description || undefined,
      eventType: flow.eventType,
      isActive: flow.webhooks[0]?.isActive ?? false,
      cronActive: flow.cronActive || false,
      cronSchedule: flow.cron || undefined,
      webhookExecutionCount: flow.webhookExecutionCount,
      webhookFailureCount: flow.webhookFailureCount,
      executionCount: executionCountMap.get(flow.id) || 0,
      bubbles,
      ownerId: flow.userId,
      createdAt: flow.createdAt.toISOString(),
      updatedAt: flow.updatedAt.toISOString(),
    };
  });

  const response = {
    bubbleFlows: bubbleFlowsData,
    userMonthlyUsage: {
      count: userData?.monthlyUsageCount ?? 0,
    },
  };

  return c.json(response, 200);
});

app.openapi(createBubbleFlowRoute, async (c) => {
  const data = c.req.valid('json');

  // Validate TypeScript code
  const validationResult = await validateBubbleFlow(data.code, false);

  if (!validationResult.valid) {
    console.debug('Validation failed:', validationResult.errors);
    return c.json(
      {
        error: 'TypeScript validation failed',
        details:
          validationResult.errors?.join('; ') || 'Unknown validation error',
      },
      400
    );
  }

  // Validate that eventType is a valid BubbleTriggerEventRegistry key
  if (!isValidBubbleTriggerEvent(data.eventType)) {
    return c.json(
      {
        error: 'Invalid event type for webhook',
        details: `Event type '${data.eventType}' is not a valid BubbleTriggerEventRegistry key`,
      },
      400
    );
  }

  // Process and transpile the code for execution
  const processedCode = processUserCode(data.code);

  const userId = getUserId(c);

  // Auto-select credentials at identification time: every required slot the
  // user's connected credentials decide unambiguously is bound BEFORE the
  // flow is stored, so a fresh flow arrives in the editor (and at webhook/cron
  // execution) with its credentials already selected and persisted.
  const autoBind = await autoBindMissingCredentials(
    userId,
    validationResult.bubbleParameters || {}
  );

  const [inserted] = await db
    .insert(bubbleFlows)
    .values({
      userId,
      name: data.name,
      description: data.description,
      prompt: data.prompt,
      code: processedCode,
      originalCode: data.code,
      bubbleParameters: autoBind.bubbleParameters,
      workflow: validationResult.workflow || null,
      inputSchema: validationResult.inputSchema || {},
      eventType: validationResult.trigger?.type || 'webhook/http',
      cron: validationResult.trigger?.cronSchedule || null,
      cronActive: false,
      defaultInputs: {},
    })
    .returning({ id: bubbleFlows.id });

  // Extract required credentials from bubble parameters
  const requiredCredentials = extractRequiredCredentials(
    autoBind.bubbleParameters,
    data.code
  );

  const response: z.infer<typeof createBubbleFlowResponseSchema> = {
    id: inserted.id,
    message: 'BubbleFlow created successfully',
    inputSchema: validationResult.inputSchema || {},
    bubbleParameters: autoBind.bubbleParameters,
    workflow: validationResult.workflow,
    eventType: validationResult.trigger?.type || 'webhook/http',
    requiredCredentials,
  };

  // Always create webhook entry for all BubbleFlows
  const webhookPath = data.webhookPath || generateWebhookPath();

  try {
    const [webhookInserted] = await db
      .insert(webhooks)
      .values({
        userId,
        path: webhookPath,
        bubbleFlowId: inserted.id,
        isActive: data.webhookActive,
      })
      .returning({ id: webhooks.id });

    response.webhook = {
      id: webhookInserted.id,
      url: getWebhookUrl(userId, webhookPath),
      path: webhookPath,
      active: data.webhookActive || false,
    };
  } catch (error: unknown) {
    // Handle duplicate webhook path error
    const errorObj = error as {
      message?: string;
      cause?: { message?: string; code?: string };
      code?: string;
    };
    const errorMessage = errorObj?.message || String(error);
    const causeMessage = errorObj?.cause?.message || '';
    const errorCode = errorObj?.code || errorObj?.cause?.code;

    if (
      errorMessage.includes('UNIQUE constraint failed') ||
      errorMessage.includes('SQLITE_CONSTRAINT_UNIQUE') ||
      causeMessage.includes('UNIQUE constraint failed') ||
      causeMessage.includes('SQLITE_CONSTRAINT_UNIQUE') ||
      errorCode === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      return c.json(
        {
          error: 'Webhook path already exists',
          details: `Path '${webhookPath}' is already in use for this user`,
        },
        400
      );
    }
    throw error;
  }

  return c.json(response, 201);
});

// POST /bubble-flow/empty - Create empty BubbleFlow (for async code generation)
app.openapi(createEmptyBubbleFlowRoute, async (c) => {
  const data = c.req.valid('json');

  // Validate that eventType is a valid BubbleTriggerEventRegistry key
  if (!isValidBubbleTriggerEvent(data.eventType)) {
    return c.json(
      {
        error: 'Invalid event type for webhook',
        details: `Event type '${data.eventType}' is not a valid BubbleTriggerEventRegistry key`,
      },
      400
    );
  }

  const userId = getUserId(c);

  // Create empty flow with no code
  const [inserted] = await db
    .insert(bubbleFlows)
    .values({
      userId,
      name: data.name,
      description: data.description,
      prompt: data.prompt,
      code: '', // Empty code - will be generated asynchronously
      originalCode: '', // Empty original code
      bubbleParameters: {}, // Empty bubble parameters
      workflow: null,
      inputSchema: {},
      eventType: data.eventType,
      cron: null,
      cronActive: false,
      defaultInputs: {},
      generationError: null, // No error initially
    })
    .returning({ id: bubbleFlows.id });

  // Always create webhook entry for all BubbleFlows
  const webhookPath = data.webhookPath || generateWebhookPath();

  try {
    const [webhookInserted] = await db
      .insert(webhooks)
      .values({
        userId,
        path: webhookPath,
        bubbleFlowId: inserted.id,
        isActive: data.webhookActive || false, // Usually false for empty flows
      })
      .returning({ id: webhooks.id });

    const response = {
      id: inserted.id,
      message:
        'BubbleFlow created successfully. Code generation in progress...',
      webhook: {
        id: webhookInserted.id,
        url: getWebhookUrl(userId, webhookPath),
        path: webhookPath,
        active: data.webhookActive || false,
      },
    };

    return c.json(response, 201);
  } catch (error: unknown) {
    // Handle duplicate webhook path error
    const errorObj = error as {
      message?: string;
      cause?: { message?: string; code?: string };
      code?: string;
    };
    const errorMessage = errorObj?.message || String(error);
    const causeMessage = errorObj?.cause?.message || '';
    const errorCode = errorObj?.code || errorObj?.cause?.code;

    if (
      errorMessage.includes('UNIQUE constraint failed') ||
      errorMessage.includes('SQLITE_CONSTRAINT_UNIQUE') ||
      causeMessage.includes('UNIQUE constraint failed') ||
      causeMessage.includes('SQLITE_CONSTRAINT_UNIQUE') ||
      errorCode === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      return c.json(
        {
          error: 'Webhook path already exists',
          details: `Path '${webhookPath}' is already in use for this user`,
        },
        400
      );
    }
    throw error;
  }
});

app.openapi(executeBubbleFlowRoute, async (c) => {
  const id = parseInt(c.req.param('id'));
  const userPayload = c.req.valid('json') ?? {}; // Handle empty payloads gracefully

  const userId = getUserId(c);

  try {
    const triggerEvent = {
      type: 'webhook/http' as const,
      timestamp: new Date().toISOString(),
      executionId: crypto.randomUUID(),
      path: `/${id}/execute`,
      body: userPayload,
      ...userPayload,
    };

    const appType = getAppType(c);
    const result = await executeBubbleFlowWithTracking(id, triggerEvent, {
      userId,
      appType,
      pricingTable: PRICING_TABLE,
    });

    if (!result.success) {
      return c.json(
        {
          error: result.error || 'Execution failed',
          details: result.error,
        },
        400
      );
    }

    return c.json(result, 200);
  } catch (error) {
    // Return 404 for "BubbleFlow not found" errors like the original implementation
    if (
      error instanceof Error &&
      (error.message === 'BubbleFlow not found' ||
        error.message ===
          'Something went wrong, please recreate the flow. If the problem persists, please contact Nodex support.')
    ) {
      return c.json({ error: 'BubbleFlow not found' }, 404);
    }
    throw error; // Let global error handler deal with other errors
  }
});

app.openapi(testBubbleFlowRoute, async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = c.req.valid('json') ?? {};
  const userPayload = body.payload ?? {};

  const userId = getUserId(c);

  try {
    const triggerEvent = {
      type: 'webhook/http' as const,
      timestamp: new Date().toISOString(),
      executionId: crypto.randomUUID(),
      path: `/${id}/test`,
      body: userPayload,
      ...userPayload,
    };

    const appType = getAppType(c);
    const result = await executeBubbleFlowWithTracking(id, triggerEvent, {
      userId,
      appType,
      pricingTable: PRICING_TABLE,
      testMode: true,
      approvedWriteCallSites: body.approvedWriteCallSites,
    });

    if (!result.success) {
      return c.json(
        {
          error: result.error || 'Test run failed',
          details: result.error,
        },
        400
      );
    }

    return c.json(result, 200);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'BubbleFlow not found' ||
        error.message ===
          'Something went wrong, please recreate the flow. If the problem persists, please contact Nodex support.')
    ) {
      return c.json({ error: 'BubbleFlow not found' }, 404);
    }
    throw error; // Let global error handler deal with other errors
  }
});

app.openapi(executeBubbleFlowStreamRoute, async (c) => {
  const id = parseInt(c.req.param('id'));
  const userPayload = c.req.valid('json') ?? {}; // Handle empty payloads gracefully
  const userId = getUserId(c);
  const appType = getAppType(c);

  try {
    const triggerEvent = {
      type: 'webhook/http' as const,
      timestamp: new Date().toISOString(),
      executionId: crypto.randomUUID(),
      path: `/${id}/execute-stream`,
      body: userPayload,
      ...userPayload,
    };

    return streamSSE(c, async (stream) => {
      try {
        await executeBubbleFlowWithTracking(id, triggerEvent, {
          userId,
          appType,
          streamCallback: async (event) => {
            await stream.writeSSE({
              data: JSON.stringify(event),
              event: event.type,
              id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            });
          },
          pricingTable: PRICING_TABLE,
        });

        // Save inputs to defaultInputs after successful execution
        // Filter out empty values (undefined, empty strings, empty arrays)
        // Keep null values as they may be explicitly set by the user
        const filteredInputs = Object.fromEntries(
          Object.entries(userPayload).filter(([_, value]) => {
            if (value === undefined) return false;
            if (typeof value === 'string' && value.trim() === '') return false;
            if (Array.isArray(value) && value.length === 0) return false;
            return true;
          })
        );

        // Only save if there are actual inputs
        if (Object.keys(filteredInputs).length > 0) {
          try {
            await db
              .update(bubbleFlows)
              .set({
                defaultInputs: filteredInputs,
                updatedAt: new Date(),
              })
              .where(
                and(eq(bubbleFlows.id, id), eq(bubbleFlows.userId, userId))
              );
          } catch (saveError) {
            console.error(
              `[API] Error saving inputs to flow ${id} defaultInputs:`,
              saveError
            );
            // Non-blocking: continue even if save fails
          }
        }

        // Send stream completion
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'stream_complete',
            timestamp: new Date().toISOString(),
          }),
          event: 'stream_complete',
        });
      } catch (error) {
        console.error('[API] Streaming execution error:', error);
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Unknown streaming error',
            recoverable: false,
          }),
          event: 'error',
        });
      }
    });
  } catch (error) {
    // Return 404 for "BubbleFlow not found" errors like the original implementation
    if (
      error instanceof Error &&
      (error.message === 'BubbleFlow not found' ||
        error.message ===
          'Something went wrong, please recreate the flow. If the problem persists, please contact Nodex support.')
    ) {
      return c.json({ error: 'BubbleFlow not found' }, 404);
    }
    throw error; // Let global error handler deal with other errors
  }
});

// GET /bubble-flow/bubble-details/:bubbleName — authoritative bubble reference
// for the external builder agent (Phase 4). Wraps bubble-core's
// GetBubbleDetailsTool (the same tool Pearl called in-process) so the Node
// sidecar can fetch exact params/result shapes over HTTP before authoring.
app.get('/bubble-details/:bubbleName', async (c) => {
  const bubbleName = c.req.param('bubbleName');
  try {
    const { GetBubbleDetailsTool } = await import('@bubblelab/bubble-core');
    const result = await new GetBubbleDetailsTool({
      bubbleName,
      config: { includeLongDescription: true, includeInputSchema: true },
    }).action();
    if (!result.success || !result.data) {
      // S3 miss path: forward the owning-bubble suggestions the tool now
      // computes, and record the miss as a queryable server event.
      const suggestions = result.data?.suggestions ?? [];
      const { recordServerTelemetryEvent } = await import('./telemetry.js');
      recordServerTelemetryEvent({
        event: 'bubble_discovery.details_miss',
        bubbleName,
        suggestions: suggestions.map((s) => s.name),
      });
      return c.json(
        {
          error: result.error || `Bubble '${bubbleName}' not found`,
          suggestions,
        },
        404
      );
    }
    return c.json(result.data);
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load bubble details',
      },
      500
    );
  }
});

// GET /bubble-flow/bubble-search?q=... — capability -> owning-bubble search
// (BACKLOG S3). Ranks the WHOLE registry (60+ bubbles, not the sidecar's
// 9-bubble prompt excerpt) by registry metadata: name, alias, descriptions,
// and operation literals. Backs the sidecar's search_bubbles tool.
app.get('/bubble-search', async (c) => {
  const query = c.req.query('q') ?? '';
  if (query.trim() === '') {
    return c.json({ error: 'q (search query) is required' }, 400);
  }
  const limitRaw = c.req.query('limit');
  let limit = limitRaw !== undefined ? Number(limitRaw) : 5;
  if (Number.isNaN(limit) || limit < 1) limit = 5;
  limit = Math.min(limit, 10);
  try {
    const { BubbleFactory, searchBubbleMetadata } = await import(
      '@bubblelab/bubble-core'
    );
    const factory = new BubbleFactory();
    await factory.registerDefaults();
    const entries = factory
      .getAllMetadata()
      .filter(
        (entry): entry is NonNullable<typeof entry> => entry !== undefined
      );
    const items = searchBubbleMetadata(entries, query, limit);
    const { recordServerTelemetryEvent } = await import('./telemetry.js');
    recordServerTelemetryEvent({
      event: 'bubble_discovery.search',
      query,
      registrySize: entries.length,
      results: items.map((item) => item.name),
    });
    return c.json({ query, registrySize: entries.length, items });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Bubble search failed',
      },
      500
    );
  }
});

// ---------------------------------------------------------------------------
// GET /bubble-flow/:id/credential-state — grounded per-slot credential state
// (BACKLOG S6). Backs the sidecar's inspect_flow_credentials tool: the fixer
// must classify credential-shaped run errors from the ACTUAL failure layer
// (missing / dead grant / dangling id / platform-provided / resolution), not
// from error text. SYSTEM-ness, platform-env presence, and the clone predicate
// live only in this process (the sidecar has no shared-schemas dependency), so
// the API serves the composed state.
// ---------------------------------------------------------------------------

/** One required-credential slot with its live binding + health state. */
interface CredentialSlotState {
  /** bubbleParameters key (the bubble's variable name). */
  bubbleKey: string;
  variableName: string;
  bubbleName: string;
  credentialType: CredentialType;
  /** Declared in SYSTEM_CREDENTIALS (shared-schemas). */
  system: boolean;
  /** system && the platform env actually backs it (S1 effective
   * classification) — the platform injects it; the user has NOTHING to
   * connect or reconnect and the Setup tab does not list it. */
  platformProvided: boolean;
  /** For declared-SYSTEM slots only: whether the platform env is set. */
  systemEnvPresent?: boolean;
  /** Credential id bound on the bubble's credentials parameter, if any. */
  boundCredentialId: number | null;
  /** False when a bound id points at a deleted credential row (dangling). */
  boundRowExists: boolean;
  boundCredential?: {
    id: number;
    name: string | null;
    isOauth: boolean;
    oauthProvider: string | null;
    /** Access-token health. 'expired' alone never proves a dead grant — a
     * live refresh token recovers it; only combined with a runtime auth
     * failure does it imply reconnect (services/oauth-status.ts). */
    oauthStatus?: OauthStatus;
    oauthExpiresAt?: string;
    createdAt: string;
  };
  /** Connectable rows of this type the user has (0 = nothing to bind). */
  userCredentialsOfType: number;
}

/** The bound id under a type on a bubble's credentials parameter value. */
function boundCredentialIdFor(
  bubble: ParsedBubbleWithInfo,
  credentialType: CredentialType
): number | null {
  const credentialsParam = bubble.parameters.find(
    (p) => p.name === 'credentials'
  );
  if (
    !credentialsParam ||
    typeof credentialsParam.value !== 'object' ||
    credentialsParam.value === null ||
    Array.isArray(credentialsParam.value)
  ) {
    return null;
  }
  const raw = (credentialsParam.value as Record<string, unknown>)[
    credentialType
  ];
  if (typeof raw === 'number') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'number') return raw[0];
  return null;
}

app.get('/:id/credential-state', async (c) => {
  const userId = getUserId(c);
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid ID format' }, 400);
  }

  const flow = await db.query.bubbleFlows.findFirst({
    where: and(eq(bubbleFlows.id, id), eq(bubbleFlows.userId, userId)),
  });
  if (!flow) {
    return c.json({ error: 'BubbleFlow not found' }, 404);
  }

  let bubbleParameters = flow.bubbleParameters as Record<
    string,
    ParsedBubbleWithInfo
  >;
  if (!bubbleParameters || Object.keys(bubbleParameters).length === 0) {
    const bubbleFactory = await getBubbleFactory();
    const script = new BubbleScript(flow.originalCode!, bubbleFactory);
    bubbleParameters = script.getParsedBubbles();
  }

  // Same auto-bind/heal discipline as GET /:id, so the state reported here is
  // exactly the state a run resolves against (never a stale pre-heal view).
  const autoBind = await autoBindMissingCredentials(userId, bubbleParameters);
  if (autoBind.bound.length > 0 || autoBind.healed) {
    bubbleParameters = autoBind.bubbleParameters;
    await db
      .update(bubbleFlows)
      .set({ bubbleParameters })
      .where(eq(bubbleFlows.id, flow.id));
  }

  // Clone slots are already excluded here via the shared isInvocationClone
  // predicate inside extractRequiredCredentials — one slot per real bubble.
  const requiredCredentials = extractRequiredCredentials(
    bubbleParameters,
    flow.originalCode ?? undefined
  );

  const rows = await db.query.userCredentials.findMany({
    where: eq(userCredentials.userId, userId),
    columns: {
      id: true,
      credentialType: true,
      name: true,
      isOauth: true,
      oauthProvider: true,
      oauthExpiresAt: true,
      createdAt: true,
    },
  });
  const platformTypes = platformProvidedCredentialTypes();

  const slots: CredentialSlotState[] = [];
  for (const [bubbleKey, credentialTypes] of Object.entries(
    requiredCredentials
  )) {
    const bubble = bubbleParameters[bubbleKey];
    if (!bubble || isInvocationClone(bubble)) continue;
    for (const credentialType of credentialTypes) {
      const boundCredentialId = boundCredentialIdFor(bubble, credentialType);
      const ofType = rows.filter((r) => r.credentialType === credentialType);
      const boundRow =
        boundCredentialId !== null
          ? rows.find((r) => r.id === boundCredentialId)
          : undefined;
      const system = isSystemCredential(credentialType);
      const platformProvided = system && platformTypes.has(credentialType);
      const oauthStatus = boundRow
        ? computeOauthStatus(boundRow.isOauth, boundRow.oauthExpiresAt)
        : undefined;
      slots.push({
        bubbleKey,
        variableName: bubble.variableName,
        bubbleName: bubble.bubbleName,
        credentialType,
        system,
        platformProvided,
        ...(system ? { systemEnvPresent: platformProvided } : {}),
        boundCredentialId,
        boundRowExists: boundCredentialId !== null && boundRow !== undefined,
        ...(boundRow !== undefined
          ? {
              boundCredential: {
                id: boundRow.id,
                name: boundRow.name ?? null,
                isOauth: boundRow.isOauth === true,
                oauthProvider: boundRow.oauthProvider ?? null,
                ...(oauthStatus !== undefined ? { oauthStatus } : {}),
                ...(boundRow.oauthExpiresAt
                  ? { oauthExpiresAt: boundRow.oauthExpiresAt.toISOString() }
                  : {}),
                createdAt: boundRow.createdAt.toISOString(),
              },
            }
          : {}),
        userCredentialsOfType: ofType.length,
      });
    }
  }

  // Pillar-2 event: every grounding read is queryable from the telemetry ring
  // buffer (GET /telemetry?type=flow.credential_state.read&flowId=N).
  const { recordServerTelemetryEvent } = await import('./telemetry.js');
  recordServerTelemetryEvent({
    event: 'flow.credential_state.read',
    flowId: id,
    slotCount: slots.length,
    unboundSlots: slots.filter(
      (s) => s.boundCredentialId === null && !s.platformProvided
    ).length,
    danglingSlots: slots.filter(
      (s) => s.boundCredentialId !== null && !s.boundRowExists
    ).length,
    platformProvidedSlots: slots.filter((s) => s.platformProvided).length,
  });

  return c.json({ flowId: id, slots }, 200);
});

app.openapi(getBubbleFlowRoute, async (c) => {
  const userId = getUserId(c);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return c.json({ error: 'Invalid ID format' }, 400);
  }

  const flow = await db.query.bubbleFlows.findFirst({
    where: and(eq(bubbleFlows.id, id), eq(bubbleFlows.userId, userId)),
    with: {
      webhooks: {
        columns: {
          isActive: true,
          path: true,
        },
      },
    },
  });

  if (!flow) {
    return c.json({ error: 'BubbleFlow not found' }, 404);
  }

  let bubbleParameters = flow.bubbleParameters as Record<
    string,
    ParsedBubbleWithInfo
  >;
  let workflow: ParsedWorkflow | undefined =
    (flow.workflow as ParsedWorkflow) || undefined;

  if (!bubbleParameters || Object.keys(bubbleParameters).length === 0) {
    //Parse parameters
    const bubbleFactory = await getBubbleFactory();
    const script = new BubbleScript(flow.originalCode!, bubbleFactory);
    //Update db with parsed parameters
    bubbleParameters = script.getParsedBubbles();
    const inputSchema = script.getPayloadJsonSchema();
    workflow = script.getWorkflow();
    await db
      .update(bubbleFlows)
      .set({
        bubbleParameters: bubbleParameters,
        workflow: workflow,
        inputSchema: inputSchema,
      })
      .where(eq(bubbleFlows.id, flow.id));
  }

  // Retroactive one-cred-per-tool auto-bind: flows created before server-side
  // auto-binding existed load with null required-credential slots; fill and
  // persist them here so the flow binds without an editor session ever
  // mounting it. autoBindMissingCredentials returns without touching the DB
  // when no slot is unbound, so bound-through flows pay nothing.
  // healed covers the lazy twin-credential migration: flows persisted with
  // split original/clone bindings converge here on first load and the merged
  // state is written back, so the split never resurfaces.
  const autoBind = await autoBindMissingCredentials(userId, bubbleParameters);
  if (autoBind.bound.length > 0 || autoBind.healed) {
    bubbleParameters = autoBind.bubbleParameters;
    await db
      .update(bubbleFlows)
      .set({ bubbleParameters })
      .where(eq(bubbleFlows.id, flow.id));
  }

  // Pre-connect scope discovery (IR-6/7): which scopes the flow's operations need per
  // credential type, so the Connect UI requests exactly those and can show what needs what.
  const scopeRequirements =
    await discoverFlowScopeRequirements(bubbleParameters);

  const requiredCredentials = extractRequiredCredentials(
    bubbleParameters,
    flow.originalCode ?? undefined
  );

  // S1a: nested agent tools whose array couldn't be resolved statically
  // (e.g. built by a function call) — surfaced instead of silently dropped.
  const unresolvedToolDetections = flow.originalCode
    ? extractUnresolvedToolDetections(bubbleParameters, flow.originalCode)
    : [];

  // Account-email defaults (gmailAccountEmail 0/1/many rule): per required
  // credential type, the email a setup field defaults to when the user has
  // exactly one credential of that type carrying metadata.email.
  const accountEmailDefaults = await resolveAccountEmailDefaults(
    userId,
    requiredCredentials
  );

  // Per "for me" input field (recipientEmail, chat_id, ...) the profile value
  // it should prefill to, keyed by the EXACT inputSchema property name.
  const userProfileDefaults = await resolveUserProfileDefaults(
    userId,
    flow.inputSchema
  );

  const response = {
    id: flow.id,
    name: flow.name,
    description: flow.description || undefined,
    prompt: flow.prompt || undefined,
    eventType: flow.eventType,
    requiredCredentials,
    unresolvedToolDetections,
    scopeRequirements,
    accountEmailDefaults,
    userProfileDefaults,
    code: flow.originalCode ?? '', // Return empty string if null/undefined, preserve empty string
    generationError: flow.generationError || undefined,
    displayedBubbleParameters:
      generateDisplayedBubbleParameters(bubbleParameters),
    bubbleParameters: bubbleParameters,
    workflow: workflow,
    inputSchema: flow.inputSchema || {},
    metadata: flow.metadata || {},
    isActive: flow.webhooks[0]?.isActive ?? false,
    cron: flow.cron || null,
    cronActive: flow.cronActive || false,
    defaultInputs: flow.defaultInputs || {},
    createdAt: flow.createdAt.toISOString(),
    updatedAt: flow.updatedAt.toISOString(),
    webhook_url: getWebhookUrl(userId, flow.webhooks[0]?.path || ''),
  };

  return c.json(response, 200);
});

app.openapi(updateBubbleFlowRoute, async (c) => {
  const userId = getUserId(c);
  const id = parseInt(c.req.param('id'));
  const { bubbleParameters } = c.req.valid('json');

  if (isNaN(id)) {
    return c.json(
      {
        error: 'Invalid ID format',
      },
      400
    );
  }

  // Get existing flow (only if it belongs to the user)
  const existingFlow = await db.query.bubbleFlows.findFirst({
    where: and(eq(bubbleFlows.id, id), eq(bubbleFlows.userId, userId)),
  });

  if (!existingFlow) {
    return c.json(
      {
        error: 'BubbleFlow not found',
      },
      404
    );
  }

  // Basic validation - ensure we still have the same bubble variables
  const existingParams =
    (existingFlow.bubbleParameters as Record<string, ParsedBubbleWithInfo>) ||
    {};
  const newParams = bubbleParameters as Record<string, ParsedBubbleWithInfo>;

  // Check that no variable names were removed
  const existingVarNames = Object.keys(existingParams);
  const newVarNames = Object.keys(newParams);

  const missingVars = existingVarNames.filter(
    (name) => !newVarNames.includes(name)
  );
  if (missingVars.length > 0) {
    return c.json(
      {
        error: 'Cannot remove existing bubble variables',
        details: `Missing variables: ${missingVars.join(', ')}`,
      },
      400
    );
  }

  // The studio writes credential bindings under canonical (original) keys
  // only; mirror them onto invocation-clone twins before persisting so every
  // twin agrees (execution and older readers resolve by either id).
  unionTwinCredentials(newParams);

  // Update the bubble parameters
  await db
    .update(bubbleFlows)
    .set({
      bubbleParameters: newParams,
      updatedAt: new Date(),
    })
    .where(eq(bubbleFlows.id, id));

  return c.json(
    {
      message: 'BubbleFlow parameters updated successfully',
      bubbleParameters: newParams,
    },
    200
  );
});

app.openapi(updateBubbleFlowNameRoute, async (c) => {
  const userId = getUserId(c);
  const id = parseInt(c.req.param('id'));
  const { name } = c.req.valid('json');

  if (isNaN(id)) {
    return c.json(
      {
        error: 'Invalid ID format',
      },
      400
    );
  }

  // Get existing flow (only if it belongs to the user)
  const existingFlow = await db.query.bubbleFlows.findFirst({
    where: and(eq(bubbleFlows.id, id), eq(bubbleFlows.userId, userId)),
  });

  if (!existingFlow) {
    return c.json(
      {
        error: 'BubbleFlow not found',
      },
      404
    );
  }

  // Update the flow name
  await db
    .update(bubbleFlows)
    .set({
      name: name,
      updatedAt: new Date(),
    })
    .where(eq(bubbleFlows.id, id));

  return c.json(
    {
      message: 'BubbleFlow name updated successfully',
    },
    200
  );
});

/** Cast-free narrowing for the untyped metadata jsonb column. */
function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// U2: register the flow's headline output. MERGES primaryOutput into the
// metadata jsonb (never replaces it — metadata also carries generation
// conversation data). Mirrors updateBubbleFlowNameRoute above.
app.openapi(updatePrimaryOutputRoute, async (c) => {
  const userId = getUserId(c);
  const id = parseInt(c.req.param('id'));
  const primaryOutput = c.req.valid('json');

  if (isNaN(id)) {
    return c.json(
      {
        error: 'Invalid ID format',
      },
      400
    );
  }

  // Get existing flow (only if it belongs to the user)
  const existingFlow = await db.query.bubbleFlows.findFirst({
    where: and(eq(bubbleFlows.id, id), eq(bubbleFlows.userId, userId)),
  });

  if (!existingFlow) {
    return c.json(
      {
        error: 'BubbleFlow not found',
      },
      404
    );
  }

  const existingMetadata: Record<string, unknown> = isMetadataRecord(
    existingFlow.metadata
  )
    ? existingFlow.metadata
    : {};

  await db
    .update(bubbleFlows)
    .set({
      metadata: { ...existingMetadata, primaryOutput },
      updatedAt: new Date(),
    })
    .where(eq(bubbleFlows.id, id));

  return c.json(
    {
      message: 'Primary output updated successfully',
    },
    200
  );
});

app.openapi(activateBubbleFlowRoute, async (c) => {
  const userId = getUserId(c);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return c.json(
      {
        error: 'Invalid ID format',
      },
      400
    );
  }

  // Get the bubble flow to ensure it exists and belongs to the user
  const flow = await db.query.bubbleFlows.findFirst({
    where: and(eq(bubbleFlows.id, id), eq(bubbleFlows.userId, userId)),
  });

  if (!flow) {
    return c.json(
      {
        error: 'BubbleFlow not found',
      },
      404
    );
  }

  // Find the associated webhook and activate it
  const webhook = await db.query.webhooks.findFirst({
    where: and(eq(webhooks.bubbleFlowId, id), eq(webhooks.userId, userId)),
  });

  if (!webhook) {
    return c.json(
      {
        error: 'No webhook found for this BubbleFlow',
      },
      404
    );
  }

  // Check if webhook is already active (skip limit check if already active)
  if (!webhook.isActive) {
    // Check webhook limit before activating
    const webhookUsage = await getCurrentWebhookUsage(userId);
    if (webhookUsage.currentUsage >= webhookUsage.limit) {
      return c.json(
        {
          error:
            'Webhook limit exceeded, please deactivate some webhooks or crons, or upgrade your plan to activate more.',
          details: `You have reached your limit of ${webhookUsage.limit} active webhooks/crons. You currently have ${webhookUsage.currentUsage} active. Please deactivate some webhooks or crons, or upgrade your plan to activate more.`,
        },
        403
      );
    }
  }

  // Activate the webhook
  await db
    .update(webhooks)
    .set({
      isActive: true,
      updatedAt: new Date(),
    })
    .where(eq(webhooks.id, webhook.id));

  // Generate the webhook URL
  const webhookUrl = getWebhookUrl(userId, webhook.path);

  return c.json(
    {
      success: true,
      webhookUrl,
      message:
        'BubbleFlow activated successfully! Your Slack bot is now ready to respond to mentions.',
    },
    200
  );
});

app.openapi(deactivateBubbleFlowRoute, async (c) => {
  const userId = getUserId(c);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return c.json(
      {
        error: 'Invalid ID format',
      },
      400
    );
  }

  // Get the bubble flow to ensure it exists and belongs to the user
  const flow = await db.query.bubbleFlows.findFirst({
    where: and(eq(bubbleFlows.id, id), eq(bubbleFlows.userId, userId)),
  });

  if (!flow) {
    return c.json(
      {
        error: 'BubbleFlow not found',
      },
      404
    );
  }

  // Find the associated webhook and deactivate it
  const webhook = await db.query.webhooks.findFirst({
    where: and(eq(webhooks.bubbleFlowId, id), eq(webhooks.userId, userId)),
  });

  if (!webhook) {
    return c.json(
      {
        error: 'No webhook found for this BubbleFlow',
      },
      404
    );
  }

  // Deactivate the webhook
  await db
    .update(webhooks)
    .set({
      isActive: false,
      updatedAt: new Date(),
    })
    .where(eq(webhooks.id, webhook.id));

  return c.json(
    {
      success: true,
      message: 'Webhook deactivated successfully',
    },
    200
  );
});

app.openapi(deleteBubbleFlowRoute, async (c) => {
  const userId = getUserId(c);
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return c.json(
      {
        error: 'Invalid ID format',
      },
      400
    );
  }

  // Check if BubbleFlow exists and belongs to the user
  const flow = await db.query.bubbleFlows.findFirst({
    where: and(eq(bubbleFlows.id, id), eq(bubbleFlows.userId, userId)),
  });

  if (!flow) {
    return c.json(
      {
        error: 'BubbleFlow not found',
      },
      404
    );
  }

  // Delete the BubbleFlow (cascade will handle webhooks and executions)
  await db.delete(bubbleFlows).where(eq(bubbleFlows.id, id));

  return c.json({ message: 'BubbleFlow deleted successfully' }, 200);
});

app.openapi(listBubbleFlowExecutionsRoute, async (c) => {
  const userId = getUserId(c);
  const id = parseInt(c.req.param('id'));
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  if (isNaN(id)) {
    return c.json(
      {
        error: 'Invalid ID format',
      },
      400
    );
  }

  // Check if BubbleFlow exists and belongs to the user
  const flow = await db.query.bubbleFlows.findFirst({
    where: and(eq(bubbleFlows.id, id), eq(bubbleFlows.userId, userId)),
    with: {
      webhooks: {
        columns: {
          path: true,
        },
      },
    },
  });

  if (!flow) {
    return c.json(
      {
        error: 'BubbleFlow not found',
      },
      404
    );
  }

  // Get execution history for this BubbleFlow
  const [executions, totalResult] = await Promise.all([
    db.query.bubbleFlowExecutions.findMany({
      where: eq(bubbleFlowExecutions.bubbleFlowId, id),
      limit,
      offset,
      orderBy: (table, { desc }) => [desc(table.startedAt)], // Most recent first
    }),
    db
      .select({ count: count() })
      .from(bubbleFlowExecutions)
      .where(eq(bubbleFlowExecutions.bubbleFlowId, id)),
  ]);

  const total = totalResult[0]?.count ?? 0;

  const items = executions.map((execution) => ({
    id: execution.id,
    status: execution.status as 'running' | 'success' | 'error',
    payload: execution.payload as Record<string, unknown>,
    result: execution.result,
    error: execution.error || undefined,
    startedAt: execution.startedAt.toISOString(),
    completedAt: execution.completedAt?.toISOString(),
    webhook_url: getWebhookUrl(userId, flow.webhooks[0]?.path || ''),
    code: execution.code || undefined,
  }));

  return c.json({ items, total }, 200);
});

// GET /bubble-flow/:id/executions/:executionId - Get single execution with logs
app.openapi(getBubbleFlowExecutionDetailRoute, async (c) => {
  const userId = getUserId(c);
  const id = parseInt(c.req.param('id'));
  const executionId = parseInt(c.req.param('executionId'));

  if (isNaN(id) || isNaN(executionId)) {
    return c.json(
      {
        error: 'Invalid ID format',
      },
      400
    );
  }

  // Check if BubbleFlow exists and belongs to the user
  const flow = await db.query.bubbleFlows.findFirst({
    where: and(eq(bubbleFlows.id, id), eq(bubbleFlows.userId, userId)),
    with: {
      webhooks: {
        columns: {
          path: true,
        },
      },
    },
  });

  if (!flow) {
    return c.json(
      {
        error: 'BubbleFlow not found',
      },
      404
    );
  }

  // Get the specific execution
  const execution = await db.query.bubbleFlowExecutions.findFirst({
    where: and(
      eq(bubbleFlowExecutions.id, executionId),
      eq(bubbleFlowExecutions.bubbleFlowId, id)
    ),
  });

  if (!execution) {
    return c.json(
      {
        error: 'Execution not found',
      },
      404
    );
  }

  const response = {
    id: execution.id,
    status: execution.status as 'running' | 'success' | 'error',
    payload: execution.payload as Record<string, unknown>,
    result: execution.result,
    error: execution.error || undefined,
    startedAt: execution.startedAt.toISOString(),
    completedAt: execution.completedAt?.toISOString(),
    webhook_url: getWebhookUrl(userId, flow.webhooks[0]?.path || ''),
    code: execution.code || undefined,
    executionLogs: execution.executionLogs || undefined,
  };

  return c.json(response, 200);
});

// Validate BubbleFlow code
app.openapi(validateBubbleFlowCodeRoute, async (c) => {
  try {
    const { code, options, flowId, credentials, defaultInputs, activateCron } =
      c.req.valid('json');
    const userId = getUserId(c);
    const bubbleFactory = await getBubbleFactory();

    // If flowId is provided, verify user owns the flow
    let existingFlow;

    if (flowId) {
      existingFlow = await db.query.bubbleFlows.findFirst({
        where: and(eq(bubbleFlows.id, flowId), eq(bubbleFlows.userId, userId)),
        with: {
          webhooks: {
            columns: {
              path: true,
            },
          },
        },
        columns: {
          id: true,
          cron: true,
          cronActive: true,
          defaultInputs: true,
          bubbleParameters: true,
          eventType: true,
        },
      });

      if (!existingFlow) {
        return c.json(
          {
            error:
              'BubbleFlow not found or you do not have permission to update it',
          },
          404
        );
      }
    }

    // Only take the shortcut path if we're NOT syncing with flow
    // When syncInputsWithFlow is true, we need to validate and sync the code first
    if (
      flowId &&
      options &&
      activateCron !== undefined &&
      !options.syncInputsWithFlow
    ) {
      // Check if cron is already active (skip limit check if already active)
      if (activateCron && !existingFlow?.cronActive) {
        // Check webhook limit before activating cron
        const webhookUsage = await getCurrentWebhookUsage(userId);
        if (webhookUsage.currentUsage >= webhookUsage.limit) {
          return c.json(
            {
              error:
                'Webhook limit exceeded, please deactivate some webhooks or crons, or upgrade your plan to activate more.',
              details: `You have reached your limit of ${webhookUsage.limit} active webhooks/crons. You currently have ${webhookUsage.currentUsage} active. Please deactivate some webhooks or crons, or upgrade your plan to activate more.`,
            },
            403
          );
        }
      }

      // Just update the activation state of the cron
      await db
        .update(bubbleFlows)
        .set({
          cronActive: activateCron,
        })
        .where(eq(bubbleFlows.id, flowId));

      return c.json(
        {
          valid: true,
          success: true,
          cronActive: activateCron,
          error: '',
          errors: [],
          inputSchema: {},
          bubbles: {},
          eventType: existingFlow?.eventType || 'webhook/http',
          webhookPath: getWebhookUrl(
            userId,
            existingFlow?.webhooks?.[0]?.path || ''
          ),
          cron: existingFlow?.cron || null,
          metadata: {
            validatedAt: new Date().toISOString(),
            codeLength: code?.length || 0,
            strictMode: options?.strictMode ?? true,
            flowUpdated: flowId ? true : false,
          },
          defaultInputs: existingFlow?.defaultInputs || {},
          requiredCredentials: extractRequiredCredentials(
            existingFlow?.bubbleParameters as Record<
              string,
              ParsedBubbleWithInfo
            >
          ),
        },
        200
      );
    }

    // Create a new BubbleFlowValidationTool instance
    const result = await validateAndExtract(code, bubbleFactory, false);

    // Proactive scope audit (IR-6/7): before accepting the build, diff the scopes the flow's
    // operations require (per-operation metadata) against the scopes granted on the assigned
    // credentials. A verifiable missing scope FAILS the build naming the scope and the
    // operations that need it; unverifiable credentials degrade to explicit warnings.
    let scopeAudit: FlowScopeAudit | undefined;
    if (result.valid) {
      let auditParameters = result.bubbleParameters || {};
      if (credentials && Object.keys(credentials).length > 0) {
        auditParameters = mergeCredentialsByBubbleName(
          auditParameters,
          existingFlow?.bubbleParameters as Record<
            string | number,
            ParsedBubbleWithInfo
          > | null,
          credentials
        );
      }
      scopeAudit = await auditFlowScopes({
        bubbleParameters: auditParameters,
        requestCredentials: credentials,
        userId,
      });
      if (!scopeAudit.ok) {
        return c.json(
          {
            valid: false,
            success: false,
            inputSchema: result.inputSchema || {},
            eventType: result.trigger?.type || 'webhook/http',
            webhookPath: getWebhookUrl(
              userId,
              existingFlow?.webhooks?.[0]?.path || ''
            ),
            cron: result.trigger?.cronSchedule || null,
            cronActive: existingFlow?.cronActive || false,
            workflow: result.workflow,
            error: scopeAudit.errors.join('; '),
            errors: scopeAudit.errors,
            lintErrors: result.lintErrors,
            scopeAudit,
            metadata: {
              validatedAt: new Date().toISOString(),
              codeLength: code?.length || 0,
              strictMode: options?.strictMode ?? true,
              flowUpdated: false,
            },
          },
          200
        );
      }
    }

    // If validation is successful and flowId is provided, update the flow as well before returning the result
    if (
      result.valid &&
      existingFlow &&
      flowId &&
      options?.syncInputsWithFlow === true
    ) {
      // Check webhook limit before activating cron (if activating)
      if (activateCron && !existingFlow?.cronActive) {
        const webhookUsage = await getCurrentWebhookUsage(userId);
        if (webhookUsage.currentUsage >= webhookUsage.limit) {
          return c.json(
            {
              error:
                'Webhook limit exceeded, please deactivate some webhooks or crons, or upgrade your plan to activate more.',
              details: `You have reached your limit of ${webhookUsage.limit} active webhooks/crons. You currently have ${webhookUsage.currentUsage} active. Please deactivate some webhooks or crons, or upgrade your plan to activate more.`,
            },
            403
          );
        }
      }

      // Prepare bubble parameters with credentials - merge by bubbleName
      // This handles when variableIds change but bubbleNames stay the same
      let finalBubbleParameters = result.bubbleParameters || {};
      if (credentials && Object.keys(credentials).length > 0) {
        finalBubbleParameters = mergeCredentialsByBubbleName(
          finalBubbleParameters,
          existingFlow?.bubbleParameters as Record<
            string | number,
            ParsedBubbleWithInfo
          > | null,
          credentials
        );
      }
      // Refill slots the bubbleName merge could not map (fresh flow, changed
      // variableIds, stale old params) when the user's credentials decide them
      // unambiguously — a validation round-trip must never persist fewer
      // bindings than the user's credentials can justify.
      finalBubbleParameters = (
        await autoBindMissingCredentials(userId, finalBubbleParameters)
      ).bubbleParameters;
      const cronExpression = result.trigger?.cronSchedule || null;

      // Prepare update object
      const updateData: Partial<typeof bubbleFlows.$inferSelect> = {
        originalCode: code,
        bubbleParameters: finalBubbleParameters,
        workflow: result.workflow || null,
        inputSchema: result.inputSchema || {},
        eventType: result.trigger?.type,
        updatedAt: new Date(),
        cron: cronExpression,
        cronActive: activateCron,
      };

      // Only include defaultInputs if it's provided and not empty
      if (defaultInputs && Object.keys(defaultInputs).length > 0) {
        updateData.defaultInputs = defaultInputs;
      }
      await db
        .update(bubbleFlows)
        .set(updateData)
        .where(eq(bubbleFlows.id, flowId));
    }

    // Prepare final bubble parameters - merge credentials by bubbleName
    // This handles when variableIds change but bubbleNames stay the same
    let finalBubbleParametersForResponse = result.bubbleParameters || {};
    if (credentials && Object.keys(credentials).length > 0) {
      // Use bubbleName-based matching to carry over credentials from old bubbles to new
      finalBubbleParametersForResponse = mergeCredentialsByBubbleName(
        finalBubbleParametersForResponse,
        existingFlow?.bubbleParameters as Record<
          string | number,
          ParsedBubbleWithInfo
        > | null,
        credentials
      );
    }

    // Same single-match refill as the sync branch, so the response the studio
    // rebuilds its selections from never drops an unambiguous binding.
    if (result.valid) {
      finalBubbleParametersForResponse = (
        await autoBindMissingCredentials(
          userId,
          finalBubbleParametersForResponse
        )
      ).bubbleParameters;
    }

    // Return the validation result based on if code itself is valid
    if (result.valid) {
      return c.json(
        {
          valid: true,
          success: true,
          inputSchema: result.inputSchema || {},
          bubbles: finalBubbleParametersForResponse,
          eventType: result.trigger?.type || 'webhook/http',
          webhookPath: getWebhookUrl(
            userId,
            existingFlow?.webhooks?.[0]?.path || ''
          ),
          cron: result.trigger?.cronSchedule || null,
          cronActive: activateCron,
          defaultInputs: defaultInputs || existingFlow?.defaultInputs || {},
          workflow: result.workflow,
          error: '',
          errors: [],
          lintErrors: result.lintErrors,
          scopeAudit,
          requiredCredentials: extractRequiredCredentials(
            finalBubbleParametersForResponse,
            code
          ),
          metadata: {
            validatedAt: new Date().toISOString(),
            codeLength: code?.length || 0,
            strictMode: options?.strictMode ?? true,
            flowUpdated: flowId ? true : false,
          },
        },
        200
      );
    } else {
      // If validation tool failed, return error structure that matches our schema
      return c.json(
        {
          valid: false,
          success: false,
          inputSchema: result.inputSchema || {},
          eventType: result.trigger?.type || 'webhook/http',
          webhookPath: getWebhookUrl(
            userId,
            existingFlow?.webhooks?.[0]?.path || ''
          ),
          cron: result.trigger?.cronSchedule || null,
          cronActive: existingFlow?.cronActive || false,
          workflow: result.workflow,
          error: result.errors?.join('; ') || 'Validation failed',
          errors: [result.errors?.join('; ') || 'Validation failed'],
          lintErrors: result.lintErrors,
          metadata: {
            validatedAt: new Date().toISOString(),
            codeLength: code?.length || 0,
            strictMode: options?.strictMode ?? true,
            flowUpdated: false,
          },
        },
        200
      );
    }
  } catch (error) {
    console.error('Validation error:', error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : 'Unknown validation error',
      },
      500
    );
  }
});

// POST /generate/run-context-flow - Execute a context-gathering flow
// Simplified execution path used by external agents to gather context
// (e.g., database schema, file listings) before authoring a flow.
app.openapi(runContextFlowRoute, async (c) => {
  const userId = getUserId(c);
  try {
    const { flowCode, credentials } = c.req.valid('json');

    // Validate the flow code
    const bubbleFactory = await getBubbleFactory();
    const validationResult = await validateAndExtract(
      flowCode,
      bubbleFactory,
      false
    );

    if (!validationResult.valid) {
      return c.json(
        {
          error: `Flow validation failed: ${validationResult.errors?.join(', ') || 'Unknown error'}`,
        },
        400
      );
    }

    // Get parsed bubbles from validation result
    // Convert number keys to strings (validateAndExtract returns Record<number, ...>)
    const parsedBubbles: Record<string, ParsedBubbleWithInfo> = {};
    for (const [varId, bubble] of Object.entries(
      validationResult.bubbleParameters || {}
    )) {
      parsedBubbles[String(varId)] = bubble;
    }

    // Build bubbleParameters with credentials injected
    // For each bubble variable, we need to add the user-provided credential IDs
    // to the credentials parameter so runBubbleFlow can fetch and decrypt them
    const bubbleParametersWithCreds = injectCredentialsIntoBubbleParameters(
      parsedBubbles,
      validationResult.requiredCredentials || {},
      credentials
    );

    // Execute the flow using the standard execution path
    const executionResult = await runBubbleFlow(
      flowCode,
      bubbleParametersWithCreds,
      {
        type: 'webhook/http',
        timestamp: new Date().toISOString(),
        path: '/context-gathering',
        method: 'POST',
        executionId: `ctx-${Date.now()}`,
        body: {},
      },
      {
        userId,
        pricingTable: PRICING_TABLE,
      }
    );

    return c.json(
      {
        success: executionResult.success,
        result: executionResult.data,
        error: executionResult.error,
      },
      200
    );
  } catch (error) {
    console.error('[API] Context flow execution error:', error);
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

export default app;
