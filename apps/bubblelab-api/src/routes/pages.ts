/**
 * Page-builder routes (agentKind 'page' on the Phase-4 harness).
 *
 * Owned here (the pages table lives in this API's schema, ownership stamped
 * from auth):
 *   POST /page              create an empty page (the studio does this before
 *                           opening the build chat, mirroring /bubble-flow/empty)
 *   GET  /page              list the user's pages
 *   GET  /page/:pageId      one page row (title, spec, status)
 *
 * Proxied to the builder-agent sidecar (which interprets the stored spec and
 * runs its reads/writes over the bubble rails):
 *   GET  /page/:pageId/render   spec with every read widget's live data resolved
 *   POST /page/:pageId/submit   run a form widget's write action
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, pages } from '../db/index.js';
import { getUserId } from '../middleware/auth.js';
import {
  builderDisabledResponse,
  builderAuthHeaders,
  getBuilderTarget,
} from '../services/builder-runtime.js';

const app = new Hono();

const createPageBodySchema = z.object({
  title: z.string().min(1).max(200).default('Untitled page'),
});

function parsePageId(raw: string): number | null {
  const pageId = Number(raw);
  return Number.isInteger(pageId) && pageId > 0 ? pageId : null;
}

async function ownedPage(userId: string, pageId: number) {
  return db.query.pages.findFirst({
    where: and(eq(pages.id, pageId), eq(pages.userId, userId)),
  });
}

app.post('/', async (c) => {
  const parsed = createPageBodySchema.safeParse(
    await c.req.json().catch(() => ({}))
  );
  if (!parsed.success) {
    return c.json({ error: 'Body must be {title?: string}' }, 400);
  }
  const [inserted] = await db
    .insert(pages)
    .values({
      userId: getUserId(c),
      title: parsed.data.title,
      spec: null,
      status: 'draft',
    })
    .returning({ id: pages.id, title: pages.title, status: pages.status });
  return c.json(inserted, 201);
});

app.get('/', async (c) => {
  const rows = await db
    .select({
      id: pages.id,
      title: pages.title,
      status: pages.status,
      createdAt: pages.createdAt,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(eq(pages.userId, getUserId(c)))
    .orderBy(desc(pages.updatedAt));
  return c.json({ pages: rows });
});

app.get('/:pageId', async (c) => {
  const pageId = parsePageId(c.req.param('pageId'));
  if (pageId === null) return c.json({ error: 'Invalid pageId' }, 400);
  const page = await ownedPage(getUserId(c), pageId);
  if (page === undefined) return c.json({ error: 'Page not found' }, 404);
  return c.json(page);
});

async function proxyToSidecar(
  c: Context,
  path: 'render' | 'submit',
  init: RequestInit
): Promise<Response> {
  const pageId = parsePageId(c.req.param('pageId') ?? '');
  if (pageId === null) {
    return Response.json({ error: 'Invalid pageId' }, { status: 400 });
  }
  if ((await ownedPage(getUserId(c), pageId)) === undefined) {
    return Response.json({ error: 'Page not found' }, { status: 404 });
  }
  // FE5: per-request target from the builder runtime manager. Off also darkens
  // the page data plane (one switch, one meaning — brief clarifying Q2; the
  // lookup is per-route, so splitting the gate later is a two-line change).
  const target = getBuilderTarget();
  if (target === null) {
    return builderDisabledResponse(`/page/${pageId}/${path}`, pageId);
  }
  const upstream = await fetch(`${target}/page/${pageId}/${path}`, {
    ...init,
    headers: { ...init.headers, ...builderAuthHeaders() },
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-cache',
    },
  });
}

app.get('/:pageId/render', (c) =>
  proxyToSidecar(c, 'render', { method: 'GET' })
);

app.post('/:pageId/submit', async (c) => {
  const body = await c.req.text();
  return proxyToSidecar(c, 'submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
});

export default app;
