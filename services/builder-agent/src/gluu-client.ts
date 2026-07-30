/**
 * Typed HTTP client for the Gluu (BubbleLab) API at GLUU_API_URL
 * (default http://localhost:3001). Thin adapter only: every method wraps one
 * existing endpoint served by apps/bubblelab-api; no generation or
 * provisioning logic is reimplemented here.
 *
 * Response shapes mirror the server's zod/OpenAPI schemas:
 * - apps/bubblelab-api/src/routes/bubble-flows.ts (list/get/create/validate/run-context-flow)
 * - apps/bubblelab-api/src/routes/user-profile.ts (GET/PUT /user-profile)
 * - apps/bubblelab-api/src/routes/credentials.ts (GET /credentials)
 * - packages/bubble-shared-schemas/src/bubbleflow-schema.ts, bubbleflow-execution-schema.ts
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Response schemas (subset of fields this server consumes; passthrough keeps
// the rest available to callers)
// ---------------------------------------------------------------------------

export const flowSummarySchema = z
  .object({
    id: z.number(),
    name: z.string(),
    description: z.string().optional(),
    eventType: z.string(),
    isActive: z.boolean(),
    cronActive: z.boolean(),
    cronSchedule: z.string().optional(),
    executionCount: z.number(),
    bubbles: z.array(
      z.object({ bubbleName: z.string(), className: z.string() })
    ),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type FlowSummary = z.infer<typeof flowSummarySchema>;

export const listFlowsResponseSchema = z.object({
  bubbleFlows: z.array(flowSummarySchema),
  userMonthlyUsage: z.object({ count: z.number() }).optional(),
});
export type ListFlowsResponse = z.infer<typeof listFlowsResponseSchema>;

export const flowDetailSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    description: z.string().optional(),
    prompt: z.string().optional(),
    eventType: z.string(),
    requiredCredentials: z.record(z.string(), z.array(z.string())).default({}),
    userProfileDefaults: z.record(z.string(), z.string()).optional(),
    code: z.string(),
    generationError: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    metadata: z.record(z.string(), z.unknown()).default({}),
    isActive: z.boolean(),
    cron: z.string().nullable(),
    cronActive: z.boolean(),
    defaultInputs: z.record(z.string(), z.unknown()).default({}),
    createdAt: z.string(),
    updatedAt: z.string(),
    webhook_url: z.string(),
  })
  .passthrough();
export type FlowDetail = z.infer<typeof flowDetailSchema>;

export const userProfileSchema = z.object({
  recipientEmail: z.string().nullable(),
  telegramChatId: z.string().nullable(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

export const credentialSchema = z
  .object({
    id: z.number(),
    credentialType: z.string(),
    name: z.string().nullable().optional(),
    createdAt: z.string(),
    isOauth: z.boolean().optional(),
    oauthProvider: z.string().nullable().optional(),
    oauthScopes: z.array(z.string()).nullable().optional(),
  })
  .passthrough();
export type Credential = z.infer<typeof credentialSchema>;

export const validateResponseSchema = z
  .object({
    valid: z.boolean(),
    success: z.boolean().optional(),
    error: z.string().optional(),
    errors: z.array(z.string()).optional(),
    // Lint violations (e.g. create-if-missing) — being ADDED to the validate
    // response by a pending backend change; optional so this client degrades
    // gracefully against a backend without it.
    lintErrors: z.array(z.string()).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    bubbles: z.record(z.string(), z.unknown()).optional(),
    eventType: z.string().optional(),
    cron: z.string().nullable().optional(),
    requiredCredentials: z.record(z.string(), z.array(z.string())).optional(),
    defaultInputs: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ValidateResponse = z.infer<typeof validateResponseSchema>;

export const createFlowResponseSchema = z
  .object({
    id: z.number(),
    message: z.string(),
    eventType: z.string(),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    requiredCredentials: z.record(z.string(), z.array(z.string())).default({}),
    webhook: z
      .object({
        id: z.number(),
        url: z.string(),
        path: z.string(),
        active: z.boolean(),
      })
      .optional(),
  })
  .passthrough();
export type CreateFlowResponse = z.infer<typeof createFlowResponseSchema>;

export const runContextFlowResponseSchema = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional().nullable(),
});

// Events on the /execute-stream SSE (StreamingLogEvent subset the run popup
// renders; packages/bubble-shared-schemas/src/streaming-events.ts). The
// route's own top-level catch emits {type:'error', error} (no message), so
// both fields are accepted.
const runStreamEventSchema = z
  .object({
    type: z.string(),
    message: z.string().optional(),
    error: z.string().optional(),
    bubbleName: z.string().optional(),
    variableName: z.string().optional(),
    variableId: z.number().optional(),
    additionalData: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export interface FlowRunError {
  type: 'error' | 'fatal';
  message: string;
  bubbleName?: string;
  variableName?: string;
  variableId?: number;
  additionalData?: string;
}

/** The same outcome the studio run popup shows: error/fatal events with the
 * failing bubble, the final result, and whether the stream ran to completion. */
export interface FlowRunSummary {
  success: boolean;
  streamCompleted: boolean;
  errors: FlowRunError[];
  finalResult: string | null;
  eventCount: number;
  durationMs: number;
}

function truncate(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GluuApiError extends Error {}

export class GluuClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GluuApiError(
        `Gluu API ${init?.method ?? 'GET'} ${path} -> HTTP ${response.status}: ${text.slice(0, 500)}`
      );
    }
    return response;
  }

  private async json<S extends z.ZodTypeAny>(
    schema: S,
    path: string,
    init?: RequestInit
  ): Promise<z.output<S>> {
    const response = await this.request(path, init);
    return schema.parse(await response.json()) as z.output<S>;
  }

  // GET /bubble-flow
  listFlows(): Promise<ListFlowsResponse> {
    return this.json(listFlowsResponseSchema, '/bubble-flow');
  }

  // GET /bubble-flow/:id
  getFlow(flowId: number): Promise<FlowDetail> {
    return this.json(flowDetailSchema, `/bubble-flow/${flowId}`);
  }

  // GET /user-profile
  getProfile(): Promise<UserProfile> {
    return this.json(userProfileSchema, '/user-profile');
  }

  // PUT /user-profile (partial upsert; omitted fields never overwrite)
  setProfile(patch: {
    recipientEmail?: string | null;
    telegramChatId?: string | null;
  }): Promise<UserProfile> {
    return this.json(userProfileSchema, '/user-profile', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  // GET /credentials
  listCredentials(): Promise<Credential[]> {
    return this.json(z.array(credentialSchema), '/credentials');
  }

  // POST /bubble-flow — create a flow from authored code. The server
  // validates the code, parses bubbles, auto-binds credentials, and stores
  // the eventType derived from the code's trigger (the request eventType must
  // still be a valid BubbleTriggerEventRegistry key).
  createFlow(body: {
    name: string;
    code: string;
    eventType: string;
    description?: string;
    prompt?: string;
  }): Promise<CreateFlowResponse> {
    return this.json(createFlowResponseSchema, '/bubble-flow', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // POST /bubble-flow/validate — the only standalone write path for
  // defaultInputs (options.syncInputsWithFlow persists them with the code).
  validateFlow(body: {
    code: string;
    flowId?: number;
    options?: {
      includeDetails?: boolean;
      strictMode?: boolean;
      syncInputsWithFlow?: boolean;
    };
    defaultInputs?: Record<string, unknown>;
    activateCron?: boolean;
  }): Promise<ValidateResponse> {
    return this.json(validateResponseSchema, '/bubble-flow/validate', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // POST /bubble-flow/:id/execute-stream — the SAME execution path the studio
  // "Test Flow" button uses (apps/bubble-studio/src/hooks/useRunExecution.ts
  // executeWithStreaming). Consumes the SSE and reduces it to the outcome the
  // user sees in the run popup. No parallel executor: the server runs
  // executeBubbleFlowWithTracking exactly as it does for the button.
  async executeFlowStream(
    flowId: number,
    payload: Record<string, unknown>,
    timeoutMs = 240_000
  ): Promise<FlowRunSummary> {
    const startedAt = Date.now();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    const errors: FlowRunError[] = [];
    let finalResult: string | null = null;
    let streamCompleted = false;
    let eventCount = 0;

    const consumeEvent = (raw: string) => {
      const parsed = runStreamEventSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      const event = parsed.data;
      eventCount++;
      if (event.type === 'error' || event.type === 'fatal') {
        errors.push({
          type: event.type,
          message: event.message ?? event.error ?? 'Unknown error',
          ...(event.bubbleName !== undefined
            ? { bubbleName: event.bubbleName }
            : {}),
          ...(event.variableName !== undefined
            ? { variableName: event.variableName }
            : {}),
          ...(event.variableId !== undefined
            ? { variableId: event.variableId }
            : {}),
          ...(event.additionalData !== undefined
            ? { additionalData: truncate(event.additionalData, 1500) }
            : {}),
        });
      } else if (event.type === 'execution_complete') {
        finalResult =
          event.additionalData !== undefined
            ? truncate(event.additionalData, 4000)
            : (event.message ?? null);
      } else if (event.type === 'stream_complete') {
        streamCompleted = true;
      }
    };

    try {
      const response = await fetch(
        `${this.baseUrl}/bubble-flow/${flowId}/execute-stream`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: abort.signal,
        }
      );
      if (!response.ok || response.body === null) {
        const text = await response.text().catch(() => '');
        throw new GluuApiError(
          `Gluu API POST /bubble-flow/${flowId}/execute-stream -> HTTP ${response.status}: ${text.slice(0, 500)}`
        );
      }

      // Same SSE parsing discipline as the studio hook: buffer, split lines,
      // accumulate data: lines, flush on blank line.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = '';
      let dataLines: string[] = [];
      const flush = () => {
        if (dataLines.length === 0) return;
        const raw = dataLines.join('');
        dataLines = [];
        try {
          consumeEvent(raw);
        } catch {
          // Non-JSON data frame (e.g. heartbeat comment leakage): skip.
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          flush();
          break;
        }
        textBuffer += decoder.decode(value, { stream: true });
        const lines = textBuffer.split(/\r?\n/);
        textBuffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (line === '') {
            flush();
            continue;
          }
          if (line.startsWith('data:')) {
            const after = line.substring(5);
            dataLines.push(after.startsWith(' ') ? after.substring(1) : after);
          }
        }
        if (streamCompleted) break;
      }
    } catch (error) {
      if (abort.signal.aborted) {
        errors.push({
          type: 'fatal',
          message: `Run exceeded the ${Math.round(timeoutMs / 1000)}s self-test timeout and was aborted; the flow may still be running server-side.`,
        });
      } else if (error instanceof GluuApiError) {
        throw error;
      } else {
        errors.push({
          type: 'fatal',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    return {
      success: streamCompleted && errors.length === 0,
      streamCompleted,
      errors,
      finalResult,
      eventCount,
      durationMs: Date.now() - startedAt,
    };
  }

  // POST /bubble-flow/generate/run-context-flow — validate + execute a flow
  // immediately with explicit credential ids (credential type -> id).
  runContextFlow(
    flowCode: string,
    credentials: Record<string, number>
  ): Promise<{ success: boolean; result?: unknown; error?: string | null }> {
    return this.json(
      runContextFlowResponseSchema,
      '/bubble-flow/generate/run-context-flow',
      {
        method: 'POST',
        body: JSON.stringify({ flowCode, credentials }),
      }
    );
  }
}
