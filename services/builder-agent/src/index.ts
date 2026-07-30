/**
 * Builder-agent sidecar HTTP server (Node, not Bun).
 *
 * Flow builder (agentKind 'flow'):
 *   POST /build/:flowId/message  {message} -> SSE build stream
 *   POST /build/:flowId/resume   {message?} -> SSE, continues the stored session
 *   GET  /build/:flowId/thread   stored transcript + thread status for rehydration
 *
 * Page builder (agentKind 'page') — same harness, second personality:
 *   POST /build-page/:pageId/message  |  /resume  |  GET /thread   (same shapes)
 *   GET  /page/:pageId/render    stored spec with every read widget's live data resolved
 *   POST /page/:pageId/submit    {widgetId, values} -> run a form widget's write action
 *
 *   GET  /health
 *
 * Runs on BUILDER_PORT (default 3010) — never 3000/3001, which belong to the
 * live studio and API.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { runBuildTurn } from './builder.ts';
import { getBuildThread } from './tools.ts';
import { renderPage, submitPageForm } from './page-data.ts';
import { GluuClient } from './gluu-client.ts';
import type { AgentKind } from './prompts.ts';
import { loadTranscript } from './session-store.ts';
import { config } from './config.ts';

const app = new Hono();

const messageBodySchema = z.object({
  message: z.string().min(1),
});

const resumeBodySchema = z.object({
  message: z.string().min(1).default('Continue where you left off.'),
});

const submitBodySchema = z.object({
  widgetId: z.string().min(1),
  values: z.record(z.string(), z.string()),
});

/** One build per subject at a time, across both agent kinds. */
const activeBuilds = new Set<string>();

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

type TranscriptItem = {
  role: 'user' | 'assistant';
  blocks: Array<Record<string, unknown>>;
};

/**
 * Reduce stored JSONL transcript entries (opaque CLI format; see
 * SessionStoreEntry docs) to the chat items the studio renders. Tolerant by
 * design: unknown entry shapes are skipped, never thrown on.
 */
function simplifyTranscript(
  entries: Array<Record<string, unknown>>
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const message = entry.message;
    if (typeof message !== 'object' || message === null) continue;
    const content = (message as Record<string, unknown>).content;
    const blocks: Array<Record<string, unknown>> = [];
    if (typeof content === 'string') {
      if (content.trim() !== '') blocks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        if (typeof raw !== 'object' || raw === null) continue;
        const block = raw as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') {
          blocks.push({ type: 'text', text: block.text });
        } else if (
          block.type === 'tool_use' &&
          typeof block.name === 'string'
        ) {
          blocks.push({
            type: 'tool_use',
            name: block.name,
            input: block.input,
          });
        } else if (block.type === 'tool_result') {
          blocks.push({
            type: 'tool_result',
            is_error: block.is_error === true,
          });
        }
      }
    }
    if (blocks.length > 0) {
      items.push({ role: entry.type, blocks });
    }
  }
  return items;
}

app.get('/health', (c) =>
  c.json({ ok: true, service: 'builder-agent', port: config.port })
);

async function threadResponse(c: Context, kind: AgentKind, idParam: string) {
  const subjectId = parseId(c.req.param(idParam) ?? '');
  if (subjectId === null) return c.json({ error: `Invalid ${idParam}` }, 400);
  const thread = await getBuildThread(subjectId, kind);
  if (thread === null) {
    return c.json({
      subjectId,
      // Legacy field name the studio's flow chat reads.
      flowId: subjectId,
      sessionId: null,
      status: 'none',
      agentKind: null,
      deferredSetup: null,
      transcript: [],
    });
  }
  const entries =
    thread.sessionId !== null ? await loadTranscript(thread.sessionId) : [];
  return c.json({
    subjectId,
    flowId: subjectId,
    sessionId: thread.sessionId,
    status: thread.status,
    agentKind: thread.agentKind,
    deferredSetup: thread.deferredSetup ?? null,
    transcript: simplifyTranscript(entries),
  });
}

app.get('/build/:flowId/thread', (c) => threadResponse(c, 'flow', 'flowId'));
app.get('/build-page/:pageId/thread', (c) =>
  threadResponse(c, 'page', 'pageId')
);

async function handleBuildRequest(
  c: Context,
  kind: AgentKind,
  idParam: string,
  message: string,
  requireExistingSession: boolean
) {
  const subjectId = parseId(c.req.param(idParam) ?? '');
  if (subjectId === null) return c.json({ error: `Invalid ${idParam}` }, 400);
  const buildKey = `${kind}:${subjectId}`;
  if (activeBuilds.has(buildKey)) {
    return c.json(
      { error: `A build for ${kind} ${subjectId} is already running` },
      409
    );
  }
  if (requireExistingSession) {
    const thread = await getBuildThread(subjectId, kind);
    if (thread?.sessionId == null) {
      return c.json(
        { error: `${kind} ${subjectId} has no build session to resume` },
        404
      );
    }
  }

  activeBuilds.add(buildKey);
  return streamSSE(
    c,
    async (stream) => {
      let sequence = 0;
      const emit = async (event: string, data: unknown) => {
        await stream.writeSSE({
          event,
          data: JSON.stringify(data),
          id: String(sequence++),
        });
      };
      // Keepalive comments so intermediaries never idle-close the stream
      // (the studio SSE 45s read-timeout lesson).
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'heartbeat', data: '{}' });
      }, 15000);
      try {
        const outcome = await runBuildTurn({
          subjectId,
          agentKind: kind,
          message,
          emit,
        });
        await emit('done', outcome);
      } catch (error) {
        await emit('error', {
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearInterval(heartbeat);
        activeBuilds.delete(buildKey);
      }
    },
    async (error) => {
      activeBuilds.delete(buildKey);
      console.error('[builder-agent] SSE stream error:', error);
    }
  );
}

function registerBuildRoutes(prefix: string, kind: AgentKind, idParam: string) {
  app.post(`${prefix}/:${idParam}/message`, async (c) => {
    const parsed = messageBodySchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) {
      return c.json({ error: 'Body must be {message: string}' }, 400);
    }
    return handleBuildRequest(c, kind, idParam, parsed.data.message, false);
  });

  app.post(`${prefix}/:${idParam}/resume`, async (c) => {
    const parsed = resumeBodySchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return c.json({ error: 'Body must be {message?: string}' }, 400);
    }
    return handleBuildRequest(c, kind, idParam, parsed.data.message, true);
  });
}

registerBuildRoutes('/build', 'flow', 'flowId');
registerBuildRoutes('/build-page', 'page', 'pageId');

// --- Page data plane: render (reads resolved server-side) + form submit ----

app.get('/page/:pageId/render', async (c) => {
  const pageId = parseId(c.req.param('pageId'));
  if (pageId === null) return c.json({ error: 'Invalid pageId' }, 400);
  try {
    const client = new GluuClient(config.gluuApiUrl);
    return c.json(await renderPage(client, pageId));
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      400
    );
  }
});

app.post('/page/:pageId/submit', async (c) => {
  const pageId = parseId(c.req.param('pageId'));
  if (pageId === null) return c.json({ error: 'Invalid pageId' }, 400);
  const parsed = submitBodySchema.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!parsed.success) {
    return c.json(
      {
        error: 'Body must be {widgetId: string, values: Record<string,string>}',
      },
      400
    );
  }
  try {
    const client = new GluuClient(config.gluuApiUrl);
    const result = await submitPageForm(
      client,
      pageId,
      parsed.data.widgetId,
      parsed.data.values
    );
    return c.json({ status: 'submitted', ...result });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      400
    );
  }
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `builder-agent listening on :${info.port} (API: ${config.gluuApiUrl}, CLAUDE_CONFIG_DIR: ${config.claudeConfigDir})`
  );
});
