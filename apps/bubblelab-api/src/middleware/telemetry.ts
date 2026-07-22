/**
 * Centralized API request/event telemetry middleware.
 *
 * Registered once in src/index.ts (app.use('*', telemetryMiddleware)) BEFORE the
 * auth middleware so it wraps every route. Additive only: no route logic changes.
 *
 * Every request emits one structured `api.request` event:
 *   { event, ts, method, path, status, durationMs, ok, userId }
 * Thrown errors additionally emit `api.error` with the error message, then
 * rethrow so the existing app.onError handler behaves unchanged.
 *
 * Sinks:
 * 1. Structured console sink: `[TELEMETRY] {json}` — always on, works without
 *    PostHog configured, greppable by log monitors.
 * 2. PostHog server client (src/services/posthog.ts) — no-ops unless
 *    POSTHOG_ENABLED=true and POSTHOG_API_KEY are set (off-by-default safe).
 *
 * Note on streaming (SSE) routes: durationMs measures time until the response
 * is created (headers), not until the stream closes.
 */
import type { Context, Next } from 'hono';
import { posthog } from '../services/posthog.js';

export const TELEMETRY_TAG = '[TELEMETRY]';

/** Emit one structured telemetry event to the server console. */
export function emitApiTelemetry(
  event: string,
  data: Record<string, unknown> = {}
): void {
  console.info(
    TELEMETRY_TAG,
    JSON.stringify({ event, ts: new Date().toISOString(), ...data })
  );
}

export async function telemetryMiddleware(
  c: Context,
  next: Next
): Promise<void> {
  const start = performance.now();
  const method = c.req.method;
  const path = c.req.path;

  try {
    await next();
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    const userId: string | undefined = c.get('userId');
    const message = error instanceof Error ? error.message : String(error);
    emitApiTelemetry('api.error', {
      method,
      path,
      durationMs,
      userId,
      error: message,
    });
    posthog.captureErrorEvent(
      error,
      { userId, requestPath: path, requestMethod: method, durationMs },
      'api_error'
    );
    throw error;
  }

  const durationMs = Math.round(performance.now() - start);
  const userId: string | undefined = c.get('userId');
  const status = c.res.status;
  emitApiTelemetry('api.request', {
    method,
    path,
    status,
    durationMs,
    ok: status < 400,
    userId,
  });
  posthog.captureEvent(
    {
      userId,
      requestPath: path,
      requestMethod: method,
      status,
      durationMs,
      ok: status < 400,
    },
    'api_request'
  );
}
