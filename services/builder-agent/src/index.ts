/**
 * Builder-agent sidecar HTTP server (Node, not Bun).
 *
 *   POST /build/:flowId/message  {message, agentKind?} -> SSE build stream
 *   POST /build/:flowId/resume   {message?}            -> SSE, continues the stored session
 *   GET  /build/:flowId/thread   stored transcript + thread status for rehydration
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
import { loadTranscript } from './session-store.ts';
import { config } from './config.ts';

const app = new Hono();

const messageBodySchema = z.object({
  message: z.string().min(1),
  agentKind: z.literal('flow').default('flow'),
});

const resumeBodySchema = z.object({
  message: z.string().min(1).default('Continue where you left off.'),
});

/** One build per flow at a time. */
const activeFlows = new Set<number>();

function parseFlowId(raw: string): number | null {
  const flowId = Number(raw);
  return Number.isInteger(flowId) && flowId > 0 ? flowId : null;
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

app.get('/build/:flowId/thread', async (c) => {
  const flowId = parseFlowId(c.req.param('flowId'));
  if (flowId === null) return c.json({ error: 'Invalid flowId' }, 400);
  const thread = await getBuildThread(flowId);
  if (thread === null) {
    return c.json({
      flowId,
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
    flowId,
    sessionId: thread.sessionId,
    status: thread.status,
    agentKind: thread.agentKind,
    deferredSetup: thread.deferredSetup ?? null,
    transcript: simplifyTranscript(entries),
  });
});

async function handleBuildRequest(
  c: Context,
  message: string,
  requireExistingSession: boolean
) {
  const flowId = parseFlowId(c.req.param('flowId') ?? '');
  if (flowId === null) return c.json({ error: 'Invalid flowId' }, 400);
  if (activeFlows.has(flowId)) {
    return c.json(
      { error: `A build for flow ${flowId} is already running` },
      409
    );
  }
  if (requireExistingSession) {
    const thread = await getBuildThread(flowId);
    if (thread?.sessionId == null) {
      return c.json(
        { error: `Flow ${flowId} has no build session to resume` },
        404
      );
    }
  }

  activeFlows.add(flowId);
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
          flowId,
          agentKind: 'flow',
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
        activeFlows.delete(flowId);
      }
    },
    async (error) => {
      activeFlows.delete(flowId);
      console.error('[builder-agent] SSE stream error:', error);
    }
  );
}

app.post('/build/:flowId/message', async (c) => {
  const parsed = messageBodySchema.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!parsed.success) {
    return c.json({ error: 'Body must be {message: string}' }, 400);
  }
  return handleBuildRequest(c, parsed.data.message, false);
});

app.post('/build/:flowId/resume', async (c) => {
  const parsed = resumeBodySchema.safeParse(
    await c.req.json().catch(() => ({}))
  );
  if (!parsed.success) {
    return c.json({ error: 'Body must be {message?: string}' }, 400);
  }
  return handleBuildRequest(c, parsed.data.message, true);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `builder-agent listening on :${info.port} (API: ${config.gluuApiUrl}, CLAUDE_CONFIG_DIR: ${config.claudeConfigDir})`
  );
});
