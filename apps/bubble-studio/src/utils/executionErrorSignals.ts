/**
 * Unified run-error detection for the console (execution logs) UI.
 *
 * A run can fail without ever emitting a top-level `error`/`fatal` event:
 * a bubble that fails (e.g. Google Sheets "Requested entity was not found.")
 * produces only a `bubble_execution_complete` event whose result carries
 * success:false, plus a `warn` — and `execution_complete` still reports
 * success:true. The "Explain with Gluu" affordance must fire on ANY of these
 * signals, so every consumer derives them through this one collector.
 */
import type { StreamingLogEvent } from '@bubblelab/shared-schemas';

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
  /** Human-readable description of what went wrong. */
  message: string;
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

/**
 * Collect every error signal a run produced, in event order:
 * - `error` / `fatal` events (the pre-existing trigger),
 * - `bubble_execution_complete` events whose result has success === false,
 * - bubble results whose HTTP status is >= 400 (non-2xx response the flow
 *   may not have surfaced as an error),
 * - `execution_complete` with success === false (run-level failure).
 */
export function collectRunErrorSignals(
  events: StreamingLogEvent[]
): RunErrorSignal[] {
  const signals: RunErrorSignal[] = [];

  for (const event of events) {
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
      const result = event.additionalData?.result as
        | BubbleResultShape
        | undefined;
      if (!result) continue;
      const stepName =
        event.bubbleName ||
        event.variableName ||
        `step ${event.variableId ?? '?'}`;
      if (result.success === false) {
        const reason =
          result.error || result.data?.error || 'the step reported a failure';
        signals.push({
          source: 'bubble',
          label: 'FAILED STEP',
          message: `Step "${stepName}" failed: ${reason}`,
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
          message: `Step "${stepName}" received HTTP ${result.data.status}${
            result.data.statusText ? ` (${result.data.statusText})` : ''
          }`,
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
 * makes the sidecar load its fix-mode prompt module for the turn.
 */
export function composeFixRequestMessage(
  events: StreamingLogEvent[],
  issueDetails?: string
): string {
  let details = issueDetails;
  let signalCount = 0;
  if (!details) {
    const signals = collectRunErrorSignals(events);
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
