/**
 * Page-builder build routes: the /build proxy's twin for agentKind 'page'.
 * Ownership is verified against the pages table here, then traffic streams
 * through to the builder-agent sidecar untouched:
 *
 *   POST /build-page/:pageId/message   -> sidecar SSE stream, passed through
 *   POST /build-page/:pageId/resume    -> sidecar SSE stream, passed through
 *   GET  /build-page/:pageId/thread    -> stored transcript + thread status
 *   GET  /build-page/:pageId/subscribe -> sidecar SSE stream, passed through
 *                                         (see build.ts's flow twin for the
 *                                         history+live-rejoin contract)
 *
 * Session id / status persist on the (pageId, agent_kind='page') build-thread
 * record shared with the sidecar over Postgres.
 */
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, pages } from '../db/index.js';
import { getUserId } from '../middleware/auth.js';
import {
  builderDisabledResponse,
  builderAuthHeaders,
  getBuilderTarget,
} from '../services/builder-runtime.js';

const app = new Hono();

async function ownsPage(userId: string, pageId: number): Promise<boolean> {
  const page = await db.query.pages.findFirst({
    where: and(eq(pages.id, pageId), eq(pages.userId, userId)),
    columns: { id: true },
  });
  return page !== undefined;
}

function parsePageId(raw: string): number | null {
  const pageId = Number(raw);
  return Number.isInteger(pageId) && pageId > 0 ? pageId : null;
}

async function forward(
  pageIdRaw: string,
  userId: string,
  path: 'message' | 'resume' | 'thread' | 'subscribe',
  init: RequestInit
): Promise<Response> {
  const pageId = parsePageId(pageIdRaw);
  if (pageId === null) {
    return Response.json({ error: 'Invalid pageId' }, { status: 400 });
  }
  if (!(await ownsPage(userId, pageId))) {
    return Response.json({ error: 'Page not found' }, { status: 404 });
  }
  // FE5: per-request target from the builder runtime manager (null = off).
  const target = getBuilderTarget();
  if (target === null) {
    return builderDisabledResponse(
      `/build-page/${pageId}/${path}`,
      pageId,
      userId
    );
  }
  const upstream = await fetch(`${target}/build-page/${pageId}/${path}`, {
    ...init,
    headers: { ...init.headers, ...builderAuthHeaders() },
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

app.post('/:pageId/message', async (c) => {
  const body = await c.req.text();
  return forward(c.req.param('pageId'), getUserId(c), 'message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
});

app.post('/:pageId/resume', async (c) => {
  const body = await c.req.text();
  return forward(c.req.param('pageId'), getUserId(c), 'resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
});

app.get('/:pageId/thread', async (c) => {
  return forward(c.req.param('pageId'), getUserId(c), 'thread', {
    method: 'GET',
  });
});

app.get('/:pageId/subscribe', async (c) => {
  return forward(c.req.param('pageId'), getUserId(c), 'subscribe', {
    method: 'GET',
  });
});

export default app;
