/**
 * Builder-agent sidecar HTTP server (Node, not Bun).
 *
 * Flow builder (agentKind 'flow'):
 *   POST /build/:flowId/message   {message} -> SSE build stream
 *   POST /build/:flowId/resume    {message?} -> SSE, continues the stored session
 *   GET  /build/:flowId/thread    stored transcript + thread status, one-shot
 *   GET  /build/:flowId/subscribe SSE: history frame then live frames if the
 *                                  thread is still building, else closes
 *                                  right after history — the flow page always
 *                                  calls this to rejoin, never a plain fetch
 *
 * Page builder (agentKind 'page') — same harness, second personality:
 *   POST /build-page/:pageId/message  |  /resume  |  GET /thread | /subscribe   (same shapes)
 *   GET  /page/:pageId/render    stored spec with every read widget's live data resolved
 *   POST /page/:pageId/submit    {widgetId, values} -> run a form widget's write action
 *
 *   GET  /health
 *   GET  /health/auth   secret-free Claude auth state (S8: linked/expired/
 *                       expiresAt) so tests and stack tooling poll auth
 *                       without opening a build
 *   POST /internal/credentials-changed  {userId, credentialType} — FE1: the
 *                       API notifies on every credential write; this scans
 *                       blocked_on_credential build threads and kicks each in
 *                       the background as a headless autoUnblockOnly turn
 *                       (202 {kicked, skipped} immediately)
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
import type { EmitFn } from './builder.ts';
import { ensureClaudeAuth, readAuthState } from './claude-auth.ts';
import {
  getBuildThread,
  listBlockedThreads,
  REMEMBER_USER_DEFAULT_TOOL_QUALIFIED,
} from './tools.ts';
import {
  deleteUserDefault,
  FALLBACK_USER_ID,
  loadUserDefaults,
} from './memory.ts';
import { postBuilderTelemetry } from './telemetry.ts';
import { renderPage, submitPageForm } from './page-data.ts';
import { GluuClient } from './gluu-client.ts';
import type { AgentKind } from './prompts.ts';
import { loadTranscript } from './session-store.ts';
import { config } from './config.ts';
import { broadcast, buildKeyFor, subscribe } from './subscribers.ts';

const app = new Hono();

// Shared-secret gate, only enforced when BUILDER_AGENT_SECRET is actually
// set. This service is deployed as a genuinely public web service on
// Render's free plan (private services have no free tier) — this header
// check is the entire substitute for real network isolation, so it must
// cover every route except /health, which Render's own platform prober
// hits with no custom headers and would otherwise mark the service
// unhealthy and restart it. Unset locally (dev, tests) -> no-op, matching
// the API-side builderAuthHeaders() contract exactly (both sides silent
// when the secret isn't configured).
app.use('*', async (c, next) => {
  const secret = process.env.BUILDER_AGENT_SECRET;
  if (!secret || c.req.path === '/health') {
    return next();
  }
  if (c.req.header('x-builder-secret') !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
});

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
 *
 * FE2 invisibility on rehydration: hidden-tool (remember_user_default)
 * tool_use blocks and their paired tool_result blocks (matched by tool_use_id
 * across entries) are filtered out, mirroring builder.ts frameFor so the
 * studio's order-matched chip pairing stays aligned. The raw session_entries
 * rows stay untouched — the Pillar-2 logged event the acceptance test reads.
 */
function simplifyTranscript(
  entries: Array<Record<string, unknown>>
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const hiddenToolUseIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const message = entry.message;
    if (typeof message !== 'object' || message === null) continue;
    const content = (message as Record<string, unknown>).content;
    const blocks: Array<Record<string, unknown>> = [];
    if (typeof content === 'string') {
      if (content.trim() !== '') {
        blocks.push({ type: 'text', text: content });
      }
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
          if (block.name === REMEMBER_USER_DEFAULT_TOOL_QUALIFIED) {
            if (typeof block.id === 'string') hiddenToolUseIds.add(block.id);
            continue;
          }
          blocks.push({
            type: 'tool_use',
            name: block.name,
            input: block.input,
          });
        } else if (block.type === 'tool_result') {
          if (
            typeof block.tool_use_id === 'string' &&
            hiddenToolUseIds.has(block.tool_use_id)
          ) {
            continue;
          }
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

// FE5: pid + activeBuilds + serveMode let the API's builder runtime manager
// drain before killing a managed child, and let tests correlate serve
// identity without shelling out.
app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'builder-agent',
    port: config.port,
    pid: process.pid,
    activeBuilds: activeBuilds.size,
    serveMode: config.serveMode,
  })
);

// S8: secret-free auth observation (mode/linked/expired/expiresAt), pollable
// without opening a build turn.
app.get('/health/auth', (c) => {
  try {
    return c.json(readAuthState());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
});

/**
 * The single source of truth for "what does this thread look like right
 * now" — used by both GET /thread and GET /subscribe's initial history
 * frame, so the two paths can never diverge on what a snapshot contains.
 */
async function getThreadSnapshot(subjectId: number, kind: AgentKind) {
  const thread = await getBuildThread(subjectId, kind);
  if (thread === null) {
    return {
      subjectId,
      // Legacy field name the studio's flow chat reads.
      flowId: subjectId,
      sessionId: null as string | null,
      status: 'none',
      agentKind: null as AgentKind | null,
      deferredSetup: null,
      servedBy: null,
      transcript: [] as TranscriptItem[],
    };
  }
  const entries =
    thread.sessionId !== null ? await loadTranscript(thread.sessionId) : [];
  return {
    subjectId,
    flowId: subjectId,
    sessionId: thread.sessionId,
    status: thread.status,
    agentKind: thread.agentKind as AgentKind | null,
    deferredSetup: thread.deferredSetup ?? null,
    // FE5: which process served the most recent turn (additive; existing
    // readers ignore it).
    servedBy: thread.servedBy ?? null,
    transcript: simplifyTranscript(entries),
  };
}

async function threadResponse(c: Context, kind: AgentKind, idParam: string) {
  const subjectId = parseId(c.req.param(idParam) ?? '');
  if (subjectId === null) return c.json({ error: `Invalid ${idParam}` }, 400);
  return c.json(await getThreadSnapshot(subjectId, kind));
}

app.get('/build/:flowId/thread', (c) => threadResponse(c, 'flow', 'flowId'));
app.get('/build-page/:pageId/thread', (c) =>
  threadResponse(c, 'page', 'pageId')
);

/**
 * FE2 identity intake: the API build proxy forwards the authenticated user as
 * x-user-id on every forwarded route. Direct sidecar hits (tests, curl) fall
 * back to the dev user — logged so prod-auth drift is visible (FE2 risk 5).
 */
function resolveUserId(c: Context): string {
  const header = c.req.header('x-user-id');
  if (header !== undefined && header.trim() !== '') return header.trim();
  console.warn(
    `[builder-agent] no x-user-id header on ${c.req.method} ${c.req.path}; falling back to '${FALLBACK_USER_ID}'`
  );
  return FALLBACK_USER_ID;
}

async function handleBuildRequest(
  c: Context,
  kind: AgentKind,
  idParam: string,
  message: string,
  requireExistingSession: boolean
) {
  const subjectId = parseId(c.req.param(idParam) ?? '');
  if (subjectId === null) return c.json({ error: `Invalid ${idParam}` }, 400);
  const userId = resolveUserId(c);
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
        // Fan out to any /subscribe connections rejoining this turn.
        broadcast(buildKey, event, data);
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
          userId,
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

  /**
   * Rejoin a thread regardless of whether it's mid-turn: register as a live
   * listener FIRST, then take the snapshot — so nothing emitted from the
   * moment of registration onward can be missed (a snapshot-then-listen
   * order would risk a real gap; listen-then-snapshot risks at most a rare
   * duplicate, which is the far safer failure). Sends the snapshot as one
   * `history` frame, then relays whatever the turn-owning request emits, in
   * the exact same event/data shape it uses — until the turn ends (a `done`/
   * `error` frame arrives) or the client disconnects. If the thread isn't
   * `building` at snapshot time, there is nothing left to relay, so the
   * stream closes right after `history` — indistinguishable from a plain
   * one-shot fetch from the caller's side.
   */
  app.get(`${prefix}/:${idParam}/subscribe`, async (c) => {
    const subjectId = parseId(c.req.param(idParam) ?? '');
    if (subjectId === null) return c.json({ error: `Invalid ${idParam}` }, 400);
    const buildKey = buildKeyFor(kind, subjectId);

    return streamSSE(c, async (stream) => {
      let sequence = 0;
      const emitLocal = async (event: string, data: unknown) => {
        await stream.writeSSE({
          event,
          data: JSON.stringify(data),
          id: String(sequence++),
        });
      };

      let resolveWait: (() => void) | null = null;
      const unsubscribe = subscribe(buildKey, (event, data) => {
        void emitLocal(event, data);
        if (event === 'done' || event === 'error') resolveWait?.();
      });
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'heartbeat', data: '{}' });
      }, 15000);

      try {
        const snapshot = await getThreadSnapshot(subjectId, kind);
        await emitLocal('history', snapshot);

        if (snapshot.status !== 'building') return;

        await new Promise<void>((resolve) => {
          resolveWait = resolve;
          stream.onAbort(() => resolve());
        });
      } finally {
        unsubscribe();
        clearInterval(heartbeat);
      }
    });
  });
}

registerBuildRoutes('/build', 'flow', 'flowId');
registerBuildRoutes('/build-page', 'page', 'pageId');

// --- FE1: credential-gap auto-run ------------------------------------------
// The API fires this on every credential write (see
// apps/bubblelab-api/src/services/builder-notify.ts). Each blocked thread is
// kicked as a headless autoUnblockOnly turn: tryResolveDeferredSetup decides
// whether the gap closed; when it did not, no agent turn is burned.

const credentialsChangedSchema = z.object({
  userId: z.string().min(1),
  credentialType: z.string().min(1),
});

// postBuilderTelemetry moved to telemetry.ts (FE2) so tools.ts can emit
// events without an import cycle; same fire-and-forget contract.

/**
 * One headless auto-unblock turn. Caller has already claimed buildKey in
 * activeBuilds (so a kick never races a live user turn); released here.
 * Emit sink is logging-only: there is no SSE consumer, and durability is
 * covered elsewhere (transcript via SessionStore, state via build_threads).
 */
async function runAutoUnblock(
  kind: AgentKind,
  subjectId: number,
  buildKey: string
): Promise<void> {
  const label = `[builder-agent] auto-unblock ${buildKey}`;
  const emit: EmitFn = async (event, data) => {
    if (event === 'stream_event') return; // token-level spam
    console.log(`${label} ${event}: ${JSON.stringify(data)?.slice(0, 500)}`);
  };
  try {
    const outcome = await runBuildTurn({
      subjectId,
      agentKind: kind,
      message: 'Continue where you left off.',
      emit,
      // Headless kick: no request context carries the owner, so the dev
      // fallback scopes any memory access (FE2; acceptable until prod auth).
      userId: FALLBACK_USER_ID,
      autoUnblockOnly: true,
    });
    console.log(`${label} done: ${JSON.stringify(outcome)}`);
    postBuilderTelemetry('builder.auto_unblock', {
      subjectId,
      agentKind: kind,
      status: outcome.status,
      resolved: outcome.status !== 'blocked_on_credential',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${label} failed: ${message}`);
    postBuilderTelemetry('builder.auto_unblock', {
      subjectId,
      agentKind: kind,
      status: 'error',
      error: message,
    });
  } finally {
    activeBuilds.delete(buildKey);
  }
}

app.post('/internal/credentials-changed', async (c) => {
  const parsed = credentialsChangedSchema.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!parsed.success) {
    return c.json(
      { error: 'Body must be {userId: string, credentialType: string}' },
      400
    );
  }
  const { userId, credentialType } = parsed.data;
  // No credential-type pre-filtering: tryResolveDeferredSetup is the single
  // authority on whether a gap is satisfied (it owns the suite-credential
  // matching); duplicating that matching here is how the two would drift.
  const blocked = await listBlockedThreads();
  const kicked: Array<{ subjectId: number; agentKind: AgentKind }> = [];
  const skipped: Array<{
    subjectId: number;
    agentKind: AgentKind;
    reason: string;
  }> = [];
  for (const thread of blocked) {
    const kind: AgentKind = thread.agentKind === 'page' ? 'page' : 'flow';
    const buildKey = `${kind}:${thread.subjectId}`;
    if (activeBuilds.has(buildKey)) {
      // A live turn owns this thread; its own turn-start resolution covers
      // the gap. Silent skip per the mutex contract.
      skipped.push({
        subjectId: thread.subjectId,
        agentKind: kind,
        reason: 'build already running',
      });
      continue;
    }
    activeBuilds.add(buildKey);
    kicked.push({ subjectId: thread.subjectId, agentKind: kind });
    void runAutoUnblock(kind, thread.subjectId, buildKey);
  }
  console.log(
    `[builder-agent] credentials-changed (${credentialType}, user ${userId}): ${blocked.length} blocked thread(s), kicked ${kicked.length}, skipped ${skipped.length}`
  );
  postBuilderTelemetry('builder.credentials_changed', {
    credentialType,
    blockedThreads: blocked.length,
    kicked,
    skipped,
  });
  return c.json({ kicked, skipped }, 202);
});

// --- FE2: user-default memory observation -----------------------------------
// The Pillar-2 "stored user-memory record" surface the acceptance test reads,
// and the future seam for a user-visible settings list. DELETE keeps test
// re-runs hermetic (and is the manual stale-value escape hatch).

app.get('/memory', async (c) => {
  const userId = c.req.query('userId') ?? resolveUserId(c);
  try {
    return c.json({ userId, defaults: await loadUserDefaults(userId) });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
});

app.delete('/memory', async (c) => {
  const userId = c.req.query('userId');
  const key = c.req.query('key');
  if (!userId || !key) {
    return c.json({ error: 'userId and key query params are required' }, 400);
  }
  try {
    const deleted = await deleteUserDefault(userId, key);
    return c.json({ userId, key, deleted });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
});

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

// S8: repair the credential link at boot so /health/auth reflects a healthy
// state before any build turn (each turn preflights again). Best-effort: a
// failure is logged and re-surfaced per-turn as auth_error, never a boot crash.
try {
  ensureClaudeAuth();
} catch (error) {
  console.error(
    '[claude-auth] startup ensure failed:',
    error instanceof Error ? error.message : String(error)
  );
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `builder-agent listening on :${info.port} (API: ${config.gluuApiUrl}, CLAUDE_CONFIG_DIR: ${config.claudeConfigDir})`
  );
});
