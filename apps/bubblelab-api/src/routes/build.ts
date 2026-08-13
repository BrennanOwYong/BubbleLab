/**
 * Phase-4 builder-agent routes.
 *
 * The studio talks ONLY to this API; these routes keep flow/credential
 * ownership here and forward build traffic to the Node sidecar
 * (services/builder-agent). The per-request target comes from the FE5 builder
 * runtime manager (services/builder-runtime.ts: external url, managed child,
 * or null=off -> 503 builder_disabled):
 *
 *   POST /build/:flowId/message   -> sidecar SSE stream, passed through
 *   POST /build/:flowId/resume    -> sidecar SSE stream, passed through
 *   GET  /build/:flowId/thread    -> stored transcript + thread status
 *   GET  /build/:flowId/subscribe -> sidecar SSE stream, passed through:
 *                                    history frame then live frames if the
 *                                    thread is still building, else closes
 *                                    right after history
 *
 * Session id / status persist on the flow's build-thread record
 * (build_threads, keyed by flow_id) which both this API and the sidecar read
 * from the shared Postgres.
 */
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, bubbleFlows } from '../db/index.js';
import { getUserId } from '../middleware/auth.js';
import {
  builderDisabledResponse,
  builderAuthHeaders,
  getBuilderTarget,
} from '../services/builder-runtime.js';

const app = new Hono();

async function ownsFlow(userId: string, flowId: number): Promise<boolean> {
  const flow = await db.query.bubbleFlows.findFirst({
    where: and(eq(bubbleFlows.id, flowId), eq(bubbleFlows.userId, userId)),
    columns: { id: true },
  });
  return flow !== undefined;
}

function parseFlowId(raw: string): number | null {
  const flowId = Number(raw);
  return Number.isInteger(flowId) && flowId > 0 ? flowId : null;
}

async function forward(
  flowIdRaw: string,
  userId: string,
  path: 'message' | 'resume' | 'thread' | 'subscribe',
  init: { method: 'GET' | 'POST'; body?: string }
): Promise<Response> {
  const flowId = parseFlowId(flowIdRaw);
  if (flowId === null) {
    return Response.json({ error: 'Invalid flowId' }, { status: 400 });
  }
  if (!(await ownsFlow(userId, flowId))) {
    return Response.json({ error: 'BubbleFlow not found' }, { status: 404 });
  }
  // FE5: the builder runtime manager owns the target per request — external
  // sidecar url, the API's own managed child, or null when the builder is off
  // (clean 503 + logged event instead of an opaque fetch failure).
  const target = getBuilderTarget();
  if (target === null) {
    return builderDisabledResponse(`/build/${flowId}/${path}`, flowId, userId);
  }
  // FE2: forward the authenticated user so the sidecar scopes its silent
  // user-default memory (x-user-id is the only supported identity channel;
  // direct sidecar hits fall back to the dev user).
  const upstream = await fetch(`${target}/build/${flowId}/${path}`, {
    method: init.method,
    ...(init.body !== undefined ? { body: init.body } : {}),
    headers: {
      ...(init.body !== undefined
        ? { 'content-type': 'application/json' }
        : {}),
      'x-user-id': userId,
      ...builderAuthHeaders(),
    },
  });
  // Pass the sidecar body through untouched (SSE for message/resume, JSON for
  // thread); copying the content-type keeps EventSource clients working.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-cache',
    },
  });
}

app.post('/:flowId/message', async (c) => {
  const body = await c.req.text();
  return forward(c.req.param('flowId'), getUserId(c), 'message', {
    method: 'POST',
    body,
  });
});

app.post('/:flowId/resume', async (c) => {
  const body = await c.req.text();
  return forward(c.req.param('flowId'), getUserId(c), 'resume', {
    method: 'POST',
    body,
  });
});

app.get('/:flowId/thread', async (c) => {
  return forward(c.req.param('flowId'), getUserId(c), 'thread', {
    method: 'GET',
  });
});

app.get('/:flowId/subscribe', async (c) => {
  return forward(c.req.param('flowId'), getUserId(c), 'subscribe', {
    method: 'GET',
  });
});

export default app;
