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
    // Access-token health the route already computes (credentials.ts via
    // services/oauth-status.ts). 'expired' = the ACCESS token lapsed; a live
    // refresh token recovers it silently, so it implies reconnect only when
    // paired with a runtime auth failure.
    oauthStatus: z.enum(['active', 'expired', 'needs_refresh']).optional(),
    oauthExpiresAt: z.string().optional(),
  })
  .passthrough();
export type Credential = z.infer<typeof credentialSchema>;

// GET /bubble-flow/:id/credential-state (S6) — the fixer's grounding data:
// per required-credential slot, the ACTUAL binding + health + SYSTEM state
// computed server-side (bubble-flows.ts credential-state route). Clone slots
// are already excluded server-side via the shared isInvocationClone predicate.
export const credentialSlotStateSchema = z
  .object({
    bubbleKey: z.string(),
    variableName: z.string(),
    bubbleName: z.string(),
    credentialType: z.string(),
    system: z.boolean(),
    platformProvided: z.boolean(),
    systemEnvPresent: z.boolean().optional(),
    boundCredentialId: z.number().nullable(),
    boundRowExists: z.boolean(),
    boundCredential: z
      .object({
        id: z.number(),
        name: z.string().nullable(),
        isOauth: z.boolean(),
        oauthProvider: z.string().nullable(),
        oauthStatus: z.enum(['active', 'expired', 'needs_refresh']).optional(),
        oauthExpiresAt: z.string().optional(),
        createdAt: z.string(),
      })
      .optional(),
    userCredentialsOfType: z.number(),
  })
  .passthrough();
export type CredentialSlotState = z.infer<typeof credentialSlotStateSchema>;

export const flowCredentialStateSchema = z
  .object({
    flowId: z.number(),
    slots: z.array(credentialSlotStateSchema),
  })
  .passthrough();
export type FlowCredentialState = z.infer<typeof flowCredentialStateSchema>;

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

// PATCH /bubble-flow/:id/name response (bubble-flows.ts updateBubbleFlowNameRoute)
export const renameFlowResponseSchema = z.object({
  message: z.string(),
});
export type RenameFlowResponse = z.infer<typeof renameFlowResponseSchema>;

// U2: the flow's registered headline output, persisted at
// bubble_flows.metadata.primaryOutput (bubble-flows.ts updatePrimaryOutputRoute).
// Invariant: every registered key is a top-level property of the handle()
// return object, so finalResult[key] is always defined on a successful run.
export const primaryOutputSchema = z
  .object({
    kind: z.enum(['artefact', 'process', 'both']),
    label: z.string().min(1).max(80),
    artefactKey: z.string().min(1).optional(),
    outcomeKeys: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (value) => value.kind === 'process' || value.artefactKey !== undefined,
    { message: "artefactKey is required when kind is 'artefact' or 'both'" }
  )
  .refine(
    (value) =>
      value.kind === 'artefact' || (value.outcomeKeys?.length ?? 0) > 0,
    {
      message: "outcomeKeys must be non-empty when kind is 'process' or 'both'",
    }
  );
export type PrimaryOutput = z.infer<typeof primaryOutputSchema>;

// PATCH /bubble-flow/:id/primary-output response ({message} only, same as rename)
export const setPrimaryOutputResponseSchema = z.object({
  message: z.string(),
});
export type SetPrimaryOutputResponse = z.infer<
  typeof setPrimaryOutputResponseSchema
>;

export const runContextFlowResponseSchema = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional().nullable(),
});

// Events on the /execute-stream SSE (StreamingLogEvent subset the run popup
// renders; packages/bubble-shared-schemas/src/streaming-events.ts). The
// route's own top-level catch emits {type:'error', error} (no message), so
// both fields are accepted.
export const runStreamEventSchema = z
  .object({
    type: z.string(),
    message: z.string().optional(),
    error: z.string().optional(),
    timestamp: z.string().optional(),
    bubbleName: z.string().optional(),
    variableName: z.string().optional(),
    variableId: z.number().optional(),
    additionalData: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type RunStreamEvent = z.infer<typeof runStreamEventSchema>;

/**
 * S4 run-signal reducer — a KEEP-IN-SYNC mirror of the studio's canonical
 * collector `collectRunErrorSignals` at
 * apps/bubble-studio/src/utils/executionErrorSignals.ts (also ported for
 * event tests at scripts/event-test/lib/signals.mjs). The sidecar sits
 * outside the pnpm workspace (pnpm-workspace.yaml: apps/*, packages/*,
 * tools/*, docs), so it cannot import the studio module; any change to the
 * studio collector updates this mirror in the same PR
 * (parity-guarded by scripts/event-test/tests/s4_requirement_completeness.test.mjs).
 *
 * Shared signal classes (identical source/label/message as the studio,
 * event-only — no bubbleParameters name resolution here):
 *  - `error` / `fatal` events                                   -> 'event'
 *  - `bubble_execution_complete` with result.success === false  -> 'bubble' (FAILED STEP)
 *  - bubble results whose HTTP status is >= 400                 -> 'http'   (HTTP ERROR)
 *  - `execution_complete` with success === false                -> 'run'    (RUN FAILED)
 * Sidecar-only extension (the nested-tool blind spot the studio does not
 * cover yet — see S4 brief open question 2):
 *  - `tool_call_complete` whose toolOutput.success === false    -> 'tool'   (FAILED TOOL)
 */
export type RunSignalSource = 'event' | 'bubble' | 'http' | 'run' | 'tool';

export interface RunSignal {
  source: RunSignalSource;
  /** Short uppercase tag: ERROR, FATAL, FAILED STEP, HTTP ERROR, RUN FAILED, FAILED TOOL. */
  label: string;
  /** Same message text the studio collector composes (step identity inline). */
  message: string;
  variableId?: number;
  /** Request URL joined from the step's `bubble_execution` start event. */
  url?: string;
  /** Nested-tool name, on source 'tool' signals only. */
  toolName?: string;
  additionalData?: string;
}

/** Per-step outcome from every `bubble_execution_complete`, so the agent can
 * verify prompt fulfillment against what each step produced — not only that
 * the run finished. */
export interface StepOutcome {
  variableId?: number;
  variableName?: string;
  bubbleName?: string;
  success: boolean;
  /** True when the step succeeded but its primary payload is empty ('' / [] /
   * nullish). ADVISORY data for the agent's fulfillment judgment, never a
   * hard failure — a delete step legitimately returns nothing. */
  emptyOutput: boolean;
  outputDigest: string | null;
}

/** Nested-tool outcome from every `tool_call_complete` (ai-agent tools). */
export interface ToolCallOutcome {
  toolName: string;
  success: boolean;
  emptyOutput: boolean;
  outputDigest: string | null;
}

/** The run outcome the self-test reasons over: every failure signal the
 * studio's console would surface (plus nested-tool failures), per-step and
 * per-tool outputs for the fulfillment check, and the final result. */
export interface FlowRunSummary {
  /** streamCompleted && signals.length === 0 — strictly stricter than the old
   * error/fatal-only gate; failed steps / HTTP >= 400 / run-level failures /
   * failed nested tools all make this false. */
  success: boolean;
  streamCompleted: boolean;
  signals: RunSignal[];
  stepOutcomes: StepOutcome[];
  toolCalls: ToolCallOutcome[];
  finalResult: string | null;
  eventCount: number;
  durationMs: number;
}

function truncate(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

// --- reducer internals (shapes match the studio collector's) ---------------

interface BubbleResultShape {
  success?: boolean;
  error?: string;
  data?: { status?: number; statusText?: string; error?: string };
}

interface StartEventIdentity {
  url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** variableId lives on the event or inside additionalData depending on the
 * logger path; accept either (same as the studio collector). */
function resolveVariableId(event: RunStreamEvent): number | undefined {
  if (typeof event.variableId === 'number') return event.variableId;
  const fromData = event.additionalData?.variableId;
  return typeof fromData === 'number' ? fromData : undefined;
}

function startEventIdentity(event: RunStreamEvent): StartEventIdentity {
  const params = event.additionalData?.parameters;
  const identity: StartEventIdentity = {};
  if (isRecord(params) && typeof params.url === 'string') {
    identity.url = params.url;
  }
  return identity;
}

/** `(<bubbleName>#<variableId>, url: <url>)` — identical to the studio's. */
function identitySegment(
  bubbleName: string | undefined,
  variableId: number | undefined,
  url: string | undefined
): string {
  if (variableId === undefined) {
    return url ? ` (url: ${url})` : '';
  }
  const urlPart = url ? `, url: ${url}` : '';
  return ` (${bubbleName ?? 'step'}#${variableId}${urlPart})`;
}

/** Empty-payload heuristic for the emptyOutput flag: nullish, '', [], or an
 * object whose every own value is itself empty. Numbers/booleans count as
 * content. */
function isEmptyPayload(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) {
    const values = Object.values(value);
    return values.length === 0 || values.every(isEmptyPayload);
  }
  return false;
}

/** The payload a human would call "the output": .content when present (tool
 * outputs like web-scrape), else .data (bubble results), else the object
 * minus its success/error bookkeeping. */
function primaryPayload(output: unknown): unknown {
  if (isRecord(output)) {
    if ('content' in output) return output.content;
    if ('data' in output) return output.data;
    const rest: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(output)) {
      if (key !== 'success' && key !== 'error') rest[key] = val;
    }
    return rest;
  }
  return output;
}

export interface ReducedRunEvents {
  signals: RunSignal[];
  stepOutcomes: StepOutcome[];
  toolCalls: ToolCallOutcome[];
  finalResult: string | null;
}

/**
 * Pure reducer over a run's StreamingLogEvents. Signal semantics are the
 * studio collector's (see the keep-in-sync header above) plus the 'tool'
 * extension; stepOutcomes/toolCalls carry the per-step data the fulfillment
 * gate (SOP step 8b) judges against.
 */
export function reduceRunEvents(events: RunStreamEvent[]): ReducedRunEvents {
  const signals: RunSignal[] = [];
  const stepOutcomes: StepOutcome[] = [];
  const toolCalls: ToolCallOutcome[] = [];
  let finalResult: string | null = null;
  // Per-variableId FIFO of unconsumed start events (studio discipline): every
  // completion consumes its start so a later failure never joins an earlier
  // iteration's URL.
  const pendingStarts = new Map<number, StartEventIdentity[]>();

  for (const event of events) {
    if (event.type === 'bubble_execution') {
      const varId = resolveVariableId(event);
      if (varId !== undefined) {
        const queue = pendingStarts.get(varId) ?? [];
        queue.push(startEventIdentity(event));
        pendingStarts.set(varId, queue);
      }
      continue;
    }

    if (event.type === 'error' || event.type === 'fatal') {
      signals.push({
        source: 'event',
        label: event.type.toUpperCase(),
        message: event.message || event.error || 'Unknown error',
        ...(event.additionalData !== undefined
          ? { additionalData: truncate(event.additionalData, 1500) }
          : {}),
      });
      continue;
    }

    if (event.type === 'bubble_execution_complete') {
      const variableId = resolveVariableId(event);
      const start: StartEventIdentity =
        variableId !== undefined
          ? (pendingStarts.get(variableId)?.shift() ?? {})
          : {};

      const result = event.additionalData?.result as
        | BubbleResultShape
        | undefined;
      const stepSuccess = result?.success !== false;
      stepOutcomes.push({
        ...(variableId !== undefined ? { variableId } : {}),
        ...(event.variableName !== undefined
          ? { variableName: event.variableName }
          : {}),
        ...(event.bubbleName !== undefined
          ? { bubbleName: event.bubbleName }
          : {}),
        success: stepSuccess,
        emptyOutput:
          stepSuccess &&
          isEmptyPayload(isRecord(result) ? primaryPayload(result) : result),
        outputDigest: result !== undefined ? truncate(result, 600) : null,
      });
      if (!result) continue;

      const stepName =
        event.bubbleName || event.variableName || `step ${variableId ?? '?'}`;
      const identity = identitySegment(event.bubbleName, variableId, start.url);

      if (result.success === false) {
        const reason =
          result.error || result.data?.error || 'the step reported a failure';
        signals.push({
          source: 'bubble',
          label: 'FAILED STEP',
          message: `Step "${stepName}"${identity} failed: ${reason}`,
          ...(variableId !== undefined ? { variableId } : {}),
          ...(start.url !== undefined ? { url: start.url } : {}),
          ...(event.additionalData !== undefined
            ? { additionalData: truncate(event.additionalData, 1500) }
            : {}),
        });
      } else if (
        typeof result.data?.status === 'number' &&
        result.data.status >= 400
      ) {
        signals.push({
          source: 'http',
          label: 'HTTP ERROR',
          message: `Step "${stepName}"${identity} received HTTP ${result.data.status}${
            result.data.statusText ? ` (${result.data.statusText})` : ''
          }`,
          ...(variableId !== undefined ? { variableId } : {}),
          ...(start.url !== undefined ? { url: start.url } : {}),
          ...(event.additionalData !== undefined
            ? { additionalData: truncate(event.additionalData, 1500) }
            : {}),
        });
      }
      continue;
    }

    if (event.type === 'tool_call_complete') {
      const toolNameRaw = event.additionalData?.toolName;
      const toolName = typeof toolNameRaw === 'string' ? toolNameRaw : 'tool';
      const toolOutput = event.additionalData?.toolOutput;
      const toolSuccess = !(
        isRecord(toolOutput) && toolOutput.success === false
      );
      toolCalls.push({
        toolName,
        success: toolSuccess,
        emptyOutput: toolSuccess && isEmptyPayload(primaryPayload(toolOutput)),
        outputDigest:
          toolOutput !== undefined ? truncate(toolOutput, 600) : null,
      });
      if (!toolSuccess) {
        const reason =
          isRecord(toolOutput) && typeof toolOutput.error === 'string'
            ? toolOutput.error
            : 'the tool reported a failure';
        signals.push({
          source: 'tool',
          label: 'FAILED TOOL',
          message: `Nested tool "${toolName}" failed: ${reason}`,
          toolName,
          ...(toolOutput !== undefined
            ? { additionalData: truncate(toolOutput, 1500) }
            : {}),
        });
      }
      continue;
    }

    if (event.type === 'execution_complete') {
      const data = event.additionalData as { success?: boolean } | undefined;
      finalResult =
        event.additionalData !== undefined
          ? truncate(event.additionalData, 4000)
          : (event.message ?? null);
      if (data?.success === false) {
        signals.push({
          source: 'run',
          label: 'RUN FAILED',
          message: event.message || 'The run did not complete successfully',
          ...(event.additionalData !== undefined
            ? { additionalData: truncate(event.additionalData, 1500) }
            : {}),
        });
      }
    }
  }

  return { signals, stepOutcomes, toolCalls, finalResult };
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

  // PATCH /bubble-flow/:id/name — body {name} per
  // bubble-shared-schemas updateBubbleFlowNameSchema (min 1, max 100 chars).
  renameFlow(flowId: number, name: string): Promise<RenameFlowResponse> {
    return this.json(renameFlowResponseSchema, `/bubble-flow/${flowId}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  }

  // PATCH /bubble-flow/:id/primary-output — register the flow's headline
  // output on bubble_flows.metadata.primaryOutput (server-side MERGE into the
  // metadata jsonb; bubble-flows.ts updatePrimaryOutputRoute).
  setPrimaryOutput(
    flowId: number,
    primaryOutput: PrimaryOutput
  ): Promise<SetPrimaryOutputResponse> {
    return this.json(
      setPrimaryOutputResponseSchema,
      `/bubble-flow/${flowId}/primary-output`,
      {
        method: 'PATCH',
        body: JSON.stringify(primaryOutput),
      }
    );
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

  // GET /bubble-flow/:id/credential-state — grounded per-slot credential
  // state for the fixer's triage (S6). Thin wrapper; all classification
  // (SYSTEM-ness, platform-env presence, clone skipping, oauth health) is
  // computed server-side.
  getFlowCredentialState(flowId: number): Promise<FlowCredentialState> {
    return this.json(
      flowCredentialStateSchema,
      `/bubble-flow/${flowId}/credential-state`
    );
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
  // executeWithStreaming). Consumes the SSE, buffers every StreamingLogEvent,
  // and reduces the run through reduceRunEvents (the studio-collector mirror,
  // plus stepOutcomes/toolCalls for the fulfillment gate). No parallel
  // executor: the server runs executeBubbleFlowWithTracking exactly as it
  // does for the button. Emits a best-effort `sidecar.self_test.run`
  // telemetry event to the API ring buffer so every self-test outcome is
  // assertable from logged events (Pillar 2).
  async executeFlowStream(
    flowId: number,
    payload: Record<string, unknown>,
    timeoutMs = 240_000
  ): Promise<FlowRunSummary> {
    const startedAt = Date.now();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    const events: RunStreamEvent[] = [];
    let streamCompleted = false;

    const consumeEvent = (raw: string) => {
      const parsed = runStreamEventSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      const event = parsed.data;
      events.push(event);
      if (event.type === 'stream_complete') {
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
      // Transport failures become synthetic fatal events so the one reducer
      // sees every failure class.
      if (abort.signal.aborted) {
        events.push({
          type: 'fatal',
          message: `Run exceeded the ${Math.round(timeoutMs / 1000)}s self-test timeout and was aborted; the flow may still be running server-side.`,
        });
      } else if (error instanceof GluuApiError) {
        throw error;
      } else {
        events.push({
          type: 'fatal',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    const { signals, stepOutcomes, toolCalls, finalResult } =
      reduceRunEvents(events);
    const summary: FlowRunSummary = {
      success: streamCompleted && signals.length === 0,
      streamCompleted,
      signals,
      stepOutcomes,
      toolCalls,
      finalResult,
      eventCount: events.length,
      durationMs: Date.now() - startedAt,
    };

    // Pillar-2 self-event: the self-test outcome lands in the API telemetry
    // ring buffer (apps/bubblelab-api/src/routes/telemetry.ts), queryable via
    // GET /telemetry?type=sidecar.self_test.run&flowId=N. Best-effort.
    try {
      await this.request('/telemetry', {
        method: 'POST',
        body: JSON.stringify({
          event: 'sidecar.self_test.run',
          ts: new Date().toISOString(),
          flowId,
          success: summary.success,
          streamCompleted,
          signalCount: signals.length,
          signalSources: signals.map((signal) => signal.source),
          failedSteps: stepOutcomes.filter((step) => !step.success).length,
          failedToolCalls: toolCalls.filter((call) => !call.success).length,
          emptyOutputs: stepOutcomes.filter((step) => step.emptyOutput).length,
          eventCount: summary.eventCount,
          durationMs: summary.durationMs,
        }),
      });
    } catch {
      /* telemetry sink is best-effort; never fail the self-test over it */
    }

    return summary;
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
