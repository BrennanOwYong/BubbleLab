/**
 * Client-telemetry ingest + query (MVP sink for the studio's track() events).
 *
 * The studio already captures window errors, unhandled rejections, api.call /
 * api.call_failed (fetch interceptor), ui.click, and error-boundary events in
 * apps/bubble-studio/src/lib/telemetry.ts, but until now the only sinks were
 * console.info + PostHog — nothing queryable without a browser attached.
 *
 *   POST /telemetry  { events: [{ event, ts?, ...props }] }  (or one bare event)
 *   GET  /telemetry  ?type=&flowId=&since=&limit=
 *
 * Storage is a bounded in-memory ring buffer (last MAX_EVENTS events) — no DB
 * table, no migration; the buffer resets on API restart. Event payloads are
 * stored verbatim (the studio taxonomy is NOT reshaped); the server only stamps
 * seq / receivedAt / userId.
 *
 * Later (not built): persist to a table + an agent-facing "get this flow's
 * recent errors as text" tool for the console/fixer agent.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getUserId } from '../middleware/auth.js';

const MAX_EVENTS = 2000;
const MAX_BATCH = 200;
const DEFAULT_LIMIT = 100;

/** One client event, stored verbatim plus server stamps. */
export interface StoredTelemetryEvent {
  /** Monotonic server-side sequence number (survives ring-buffer eviction). */
  seq: number;
  /** Server receive time, ISO. */
  receivedAt: string;
  /** Authenticated user the batch arrived under. */
  userId: string;
  /** The client payload exactly as track() emitted it ({ event, ts, ...props }). */
  event: Record<string, unknown> & { event: string };
}

const clientEventSchema = z
  .object({ event: z.string().min(1).max(200) })
  .passthrough();

const ingestBodySchema = z.union([
  z.object({ events: z.array(clientEventSchema).min(1).max(MAX_BATCH) }),
  clientEventSchema,
]);

// Ring buffer: append to tail, evict from head past MAX_EVENTS.
const buffer: StoredTelemetryEvent[] = [];
let nextSeq = 1;

function pushEvent(userId: string, event: z.infer<typeof clientEventSchema>) {
  buffer.push({
    seq: nextSeq++,
    receivedAt: new Date().toISOString(),
    userId,
    event: event as StoredTelemetryEvent['event'],
  });
  if (buffer.length > MAX_EVENTS) {
    buffer.splice(0, buffer.length - MAX_EVENTS);
  }
}

/** Test/ops hook: drop everything in the buffer. */
export function clearTelemetryBuffer(): void {
  buffer.length = 0;
}

/**
 * Server-side ingest (S3, Pillar 2): API routes record their own events into
 * the same queryable ring buffer the studio's client events land in, so new
 * server behavior is assertable via GET /telemetry without a browser.
 */
export function recordServerTelemetryEvent(
  event: Record<string, unknown> & { event: string }
): void {
  const parsed = clientEventSchema.safeParse({
    ts: new Date().toISOString(),
    ...event,
  });
  if (!parsed.success) return; // best-effort sink, never throws into a route
  pushEvent('server', parsed.data);
}

const app = new Hono();

app.post('/', async (c) => {
  const userId = getUserId(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = ingestBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Expected { events: [{ event, ... }] } or { event, ... }' },
      400
    );
  }
  const events =
    'events' in parsed.data && Array.isArray(parsed.data.events)
      ? parsed.data.events
      : [parsed.data as z.infer<typeof clientEventSchema>];
  for (const event of events) {
    pushEvent(userId, event);
  }
  return c.json({ accepted: events.length, buffered: buffer.length });
});

app.get('/', (c) => {
  const type = c.req.query('type');
  const flowIdRaw = c.req.query('flowId');
  const since = c.req.query('since');
  const limitRaw = c.req.query('limit');

  const flowId =
    flowIdRaw !== undefined && flowIdRaw !== '' ? Number(flowIdRaw) : undefined;
  if (flowId !== undefined && Number.isNaN(flowId)) {
    return c.json({ error: 'flowId must be a number' }, 400);
  }
  let limit = limitRaw ? Number(limitRaw) : DEFAULT_LIMIT;
  if (Number.isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_EVENTS);
  const sinceMs = since ? Date.parse(since) : undefined;
  if (since && Number.isNaN(sinceMs)) {
    return c.json({ error: 'since must be an ISO timestamp' }, 400);
  }

  // type= accepts a comma-separated list (e.g. type=app.error,api.call_failed).
  const types = type
    ? new Set(
        type
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      )
    : undefined;

  const matches = buffer.filter((entry) => {
    if (types && !types.has(entry.event.event)) return false;
    if (flowId !== undefined && Number(entry.event.flowId) !== flowId)
      return false;
    if (sinceMs !== undefined) {
      const ts =
        typeof entry.event.ts === 'string'
          ? Date.parse(entry.event.ts)
          : Date.parse(entry.receivedAt);
      if (!Number.isNaN(ts) && ts < sinceMs) return false;
    }
    return true;
  });

  // Chronological order, most recent `limit` events.
  const events = matches.slice(-limit);
  return c.json({
    total: matches.length,
    returned: events.length,
    buffered: buffer.length,
    events,
  });
});

export default app;
