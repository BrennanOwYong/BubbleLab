/**
 * Unified run-error detection for the console (execution logs) UI.
 *
 * A run can fail without ever emitting a top-level `error`/`fatal` event:
 * a bubble that fails (e.g. Google Sheets "Requested entity was not found.")
 * produces only a `bubble_execution_complete` event whose result carries
 * success:false, plus a `warn` — and `execution_complete` still reports
 * success:true. The "Explain with Gluu" affordance must fire on ANY of these
 * signals, so every consumer derives them through this one collector.
 *
 * Signal identity (S5): the emit layer sends `bubbleName === variableName`
 * ("http") on every completion event, and the HTTP result omits the request
 * URL, so two failing HTTP steps used to produce byte-identical messages and
 * the fixer conflated them. The collector therefore joins each failure back
 * to its `bubble_execution` START event (which carries the sanitized call
 * parameters, including `url`) and, when the caller passes the flow's
 * bubbleParameters, resolves the real variable name. Every failure signal
 * carries a machine-readable identity (`variableId`, joined `url`) and the
 * message embeds it as `(<bubbleName>#<variableId>, url: <url>)` AHEAD of any
 * truncatable additional data, so two distinct failing call sites can never
 * collapse into one.
 *
 * NOTE: scripts/event-test/lib/signals.mjs is a 1:1 JS port of this module
 * (F0.1 rule) — any change here updates that port in the same PR.
 */
import type { StreamingLogEvent } from '@bubblelab/shared-schemas';
import { findBubbleByVariableId } from './bubbleUtils';

/**
 * Marker prefix for fix-request messages sent to the flow-builder session.
 * The builder sidecar (services/builder-agent/src/prompts.ts) matches this
 * exact string to load its FIX-MODE prompt module — keep the two in sync.
 */
export const FIX_REQUEST_MARKER = '[RUN ERROR REPORT]';

export interface RunErrorSignal {
  /** Where the signal came from: a raw error/fatal event, a failed bubble
   * result, an HTTP >= 400 response inside a bubble result, or the run
   * summary itself. */
  source: 'event' | 'bubble' | 'http' | 'run';
  /** Short uppercase tag rendered before the message (ERROR, FAILED STEP …). */
  label: string;
  /** Human-readable description of what went wrong. Carries the step identity
   * (`variableName`/`bubbleName#variableId`, joined URL) inline so two
   * identical failures from different call sites never read the same. */
  message: string;
  /** Unique per-call-site id from the event stream (the only identity the
   * emit layer preserves — bubbleName/variableName are both the class name). */
  variableId?: number;
  /** Real variable name from the flow's bubbleParameters, when provided. */
  variableName?: string;
  /** Request URL joined from the step's `bubble_execution` start event. */
  url?: string;
  /** Operation joined from the step's `bubble_execution` start event. */
  operation?: string;
  additionalData?: Record<string, unknown>;
  timestamp: string;
  event: StreamingLogEvent;
}

interface BubbleResultShape {
  success?: boolean;
  error?: string;
  data?: { status?: number; statusText?: string; error?: string };
}

interface ExecutionCompleteShape {
  success?: boolean;
  summary?: { errors?: Array<{ message?: string }> };
}

interface StartEventIdentity {
  url?: string;
  operation?: string;
}

/** variableId lives on the event or inside additionalData depending on the
 * logger path; accept either. */
function resolveVariableId(event: StreamingLogEvent): number | undefined {
  if (typeof event.variableId === 'number') return event.variableId;
  const fromData = (
    event.additionalData as { variableId?: unknown } | undefined
  )?.variableId;
  return typeof fromData === 'number' ? fromData : undefined;
}

/** Pull url/operation out of a `bubble_execution` start event's sanitized
 * parameters (`additionalData.parameters`). */
function startEventIdentity(event: StreamingLogEvent): StartEventIdentity {
  const params = (
    event.additionalData as { parameters?: Record<string, unknown> } | undefined
  )?.parameters;
  const identity: StartEventIdentity = {};
  if (params && typeof params === 'object') {
    if (typeof params.url === 'string') identity.url = params.url;
    if (typeof params.operation === 'string')
      identity.operation = params.operation;
  }
  return identity;
}

/** `(<bubbleName>#<variableId>, url: <url>)` — present whenever the event
 * carried a variableId; the url part only when a start event was joined. */
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

/**
 * Collect every error signal a run produced, in event order:
 * - `error` / `fatal` events (the pre-existing trigger),
 * - `bubble_execution_complete` events whose result has success === false,
 * - bubble results whose HTTP status is >= 400 (non-2xx response the flow
 *   may not have surfaced as an error),
 * - `execution_complete` with success === false (run-level failure).
 *
 * @param bubbleParameters optional — the flow's bubbleParameters record; when
 * given, each failure signal resolves its real variable name. The collector
 * stays fully functional event-only (identity falls back to
 * `bubbleName#variableId` plus the joined URL).
 */
export function collectRunErrorSignals(
  events: StreamingLogEvent[],
  bubbleParameters?: Record<string | number, unknown>
): RunErrorSignal[] {
  const signals: RunErrorSignal[] = [];
  // Per-variableId FIFO of unconsumed start events: sequential loop
  // iterations of one call site each pair with their own start. EVERY
  // completion (success or failure) consumes its start so a later failure
  // never joins an earlier iteration's URL.
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
        message: event.message || 'Unknown error',
        additionalData: event.additionalData,
        timestamp: event.timestamp,
        event,
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
      if (!result) continue;

      const resolvedName =
        bubbleParameters && variableId !== undefined
          ? findBubbleByVariableId(bubbleParameters, variableId)?.variableName
          : undefined;
      const stepName =
        resolvedName ||
        event.bubbleName ||
        event.variableName ||
        `step ${variableId ?? '?'}`;
      const identity = identitySegment(event.bubbleName, variableId, start.url);

      if (result.success === false) {
        const reason =
          result.error || result.data?.error || 'the step reported a failure';
        signals.push({
          source: 'bubble',
          label: 'FAILED STEP',
          message: `Step "${stepName}"${identity} failed: ${reason}`,
          variableId,
          variableName: resolvedName ?? undefined,
          url: start.url,
          operation: start.operation,
          additionalData: event.additionalData,
          timestamp: event.timestamp,
          event,
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
          variableId,
          variableName: resolvedName ?? undefined,
          url: start.url,
          operation: start.operation,
          additionalData: event.additionalData,
          timestamp: event.timestamp,
          event,
        });
      }
      continue;
    }

    if (event.type === 'execution_complete') {
      const data = event.additionalData as ExecutionCompleteShape | undefined;
      if (data?.success === false) {
        signals.push({
          source: 'run',
          label: 'RUN FAILED',
          message: event.message || 'The run did not complete successfully',
          additionalData: event.additionalData,
          timestamp: event.timestamp,
          event,
        });
      }
    }
  }

  return signals;
}

/**
 * Compose the fix-request message the "Explain with Gluu" button posts to the
 * flow's builder session. The harness agent has no execution-log tool, so the
 * latest run's error signals ride inside the message text; the marker prefix
 * makes the sidecar load its fix-mode prompt module for the turn. Each
 * numbered line carries its step identity inline (variable name,
 * bubbleName#variableId, failing URL) ahead of the 1500-char additionalData
 * slice, so truncation can never strip the identity and the fixer can tell
 * two same-shaped failures apart.
 */
export function composeFixRequestMessage(
  events: StreamingLogEvent[],
  issueDetails?: string,
  bubbleParameters?: Record<string | number, unknown>
): string {
  let details = issueDetails;
  let signalCount = 0;
  if (!details) {
    const signals = collectRunErrorSignals(events, bubbleParameters);
    signalCount = signals.length;
    details = signals
      .map((signal, idx) => {
        const extra = signal.additionalData
          ? `\n   Additional info: ${JSON.stringify(signal.additionalData).slice(0, 1500)}`
          : '';
        return `${idx + 1}. ${signal.label}: ${signal.message}${extra}`;
      })
      .join('\n');
  }

  const countNote =
    signalCount > 0
      ? `the following ${signalCount} error signal${signalCount === 1 ? '' : 's'}`
      : 'the following error(s)';
  const body = details
    ? `My latest run of this flow failed with ${countNote}:\n\n${details}`
    : `My latest run of this flow failed, but no error events were captured.`;

  return `${FIX_REQUEST_MARKER}\n${body}\n\nHandle EVERY error above in this turn per your fixing procedure — do not stop after the first.`;
}
