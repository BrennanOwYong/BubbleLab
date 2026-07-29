/**
 * Phase-4 builder-agent routes.
 *
 * The studio talks ONLY to this API; these routes keep flow/credential
 * ownership here and forward build traffic to the Node sidecar
 * (services/builder-agent, BUILDER_AGENT_URL, default http://localhost:3010):
 *
 *   POST /build/:flowId/message  -> sidecar SSE stream, passed through
 *   POST /build/:flowId/resume   -> sidecar SSE stream, passed through
 *   GET  /build/:flowId/thread   -> stored transcript + thread status
 *
 * Session id / status persist on the flow's build-thread record
 * (build_threads, keyed by flow_id) which both this API and the sidecar read
 * from the shared Postgres.
 */
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, bubbleFlows } from '../db/index.js';
import { getUserId } from '../middleware/auth.js';

const BUILDER_AGENT_URL =
  process.env.BUILDER_AGENT_URL ?? 'http://localhost:3010';

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
  path: 'message' | 'resume' | 'thread',
  init: RequestInit
): Promise<Response> {
  const flowId = parseFlowId(flowIdRaw);
  if (flowId === null) {
    return Response.json({ error: 'Invalid flowId' }, { status: 400 });
  }
  if (!(await ownsFlow(userId, flowId))) {
    return Response.json({ error: 'BubbleFlow not found' }, { status: 404 });
  }
  const upstream = await fetch(
    `${BUILDER_AGENT_URL}/build/${flowId}/${path}`,
    init
  );
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
    headers: { 'content-type': 'application/json' },
    body,
  });
});

app.post('/:flowId/resume', async (c) => {
  const body = await c.req.text();
  return forward(c.req.param('flowId'), getUserId(c), 'resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
});

app.get('/:flowId/thread', async (c) => {
  return forward(c.req.param('flowId'), getUserId(c), 'thread', {
    method: 'GET',
  });
});

export default app;
