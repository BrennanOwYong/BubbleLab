/**
 * The agent harness: one build turn = one `query()` run against the Claude
 * Agent SDK, streaming SDK messages out as SSE frames and persisting the
 * transcript through the Postgres SessionStore.
 *
 * Agent-config-driven: `agentKind` selects the system prompt + tool server
 * ('flow' today; 'page' is a reserved seam — see prompts.ts).
 *
 * Auth: keyless via the machine's Claude Max login. CLAUDE_CONFIG_DIR is
 * pointed at a clean dir holding ONLY .credentials.json so the dev box's
 * global ~/.claude hooks/settings never fire inside SDK sessions.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { systemPromptFor, type AgentKind } from './prompts.ts';
import { createBuilderServer, getBuildThread } from './tools.ts';
import { createPostgresSessionStore } from './session-store.ts';
import { buildThreads, db } from './db.ts';
import { config } from './config.ts';

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export type EmitFn = (event: string, data: unknown) => Promise<void>;

async function upsertThread(
  flowId: number,
  patch: { sessionId?: string; status?: string; agentKind?: AgentKind }
): Promise<void> {
  await db
    .insert(buildThreads)
    .values({
      flowId,
      sessionId: patch.sessionId ?? null,
      agentKind: patch.agentKind ?? 'flow',
      status: patch.status ?? 'building',
    })
    .onConflictDoUpdate({
      target: buildThreads.flowId,
      set: {
        ...(patch.sessionId !== undefined
          ? { sessionId: patch.sessionId }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.agentKind !== undefined
          ? { agentKind: patch.agentKind }
          : {}),
        updatedAt: new Date(),
      },
    });
}

/** Reduce an SDK message to the JSON frame the studio chat renders. */
function frameFor(msg: SDKMessage): { event: string; data: unknown } | null {
  switch (msg.type) {
    case 'stream_event':
      return { event: 'stream_event', data: msg.event };
    case 'assistant': {
      const blocks: Array<Record<string, unknown>> = [];
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          blocks.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          blocks.push({
            type: 'tool_use',
            name: block.name,
            input: block.input,
          });
        }
      }
      return { event: 'assistant', data: { uuid: msg.uuid, blocks } };
    }
    case 'user': {
      const content = msg.message.content;
      if (!Array.isArray(content)) return null;
      const results: Array<Record<string, unknown>> = [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          results.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            is_error: block.is_error ?? false,
          });
        }
      }
      return results.length > 0
        ? { event: 'tool_result', data: { results } }
        : null;
    }
    case 'result':
      return {
        event: 'result',
        data: {
          subtype: msg.subtype,
          is_error: msg.is_error,
          session_id: msg.session_id,
          num_turns: msg.num_turns,
          result: msg.subtype === 'success' ? msg.result : undefined,
        },
      };
    case 'rate_limit_event':
      return { event: 'rate_limit', data: msg.rate_limit_info };
    case 'system':
      if (msg.subtype === 'init') {
        return { event: 'session', data: { session_id: msg.session_id } };
      }
      // system/status and the rest of the system family: surface minimally.
      return { event: 'system', data: { subtype: msg.subtype } };
    default:
      // The SDKMessage union is large (task/hook/notification members);
      // everything unrecognized is dropped from the UI stream by design.
      return null;
  }
}

export async function runBuildTurn(opts: {
  flowId: number;
  agentKind: AgentKind;
  message: string;
  emit: EmitFn;
}): Promise<{ sessionId: string | null; status: string }> {
  const { flowId, agentKind, message, emit } = opts;

  const existing = await getBuildThread(flowId);
  const resume = existing?.sessionId ?? undefined;

  await upsertThread(flowId, { status: 'building', agentKind });

  const q = query({
    prompt: message,
    options: {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config.claudeConfigDir },
      cwd: serviceRoot,
      model: config.model,
      systemPrompt: systemPromptFor(agentKind),
      includePartialMessages: true,
      tools: [],
      mcpServers: { builder: createBuilderServer(flowId) },
      allowedTools: ['mcp__builder__*'],
      maxTurns: 120,
      sessionStore: createPostgresSessionStore(),
      ...(resume !== undefined ? { resume } : {}),
    },
  });

  let sessionId: string | null = resume ?? null;
  let finalStatus = 'ready';

  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id;
      await upsertThread(flowId, { sessionId: msg.session_id });
    }
    if (msg.type === 'result') {
      finalStatus = msg.is_error ? 'error' : 'ready';
    }
    const frame = frameFor(msg);
    if (frame !== null) {
      await emit(frame.event, frame.data);
    }
  }

  // report_missing_credential marks the thread blocked mid-run; that status
  // outlives the turn's own success so the gap stays visible.
  const after = await getBuildThread(flowId);
  const status =
    after?.status === 'blocked_on_credential'
      ? 'blocked_on_credential'
      : finalStatus;
  await db
    .update(buildThreads)
    .set({ status, updatedAt: new Date() })
    .where(eq(buildThreads.flowId, flowId));

  return { sessionId, status };
}
