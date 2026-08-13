/**
 * The agent harness: one build turn = one `query()` run against the Claude
 * Agent SDK, streaming SDK messages out as SSE frames and persisting the
 * transcript through the Postgres SessionStore.
 *
 * Agent-config-driven: `agentKind` selects the system prompt + tool server
 * ('flow' today; 'page' is a reserved seam — see prompts.ts).
 *
 * Auth: keyless via the machine's Claude Max login. CLAUDE_CONFIG_DIR is
 * pointed at a clean dir whose .credentials.json is a SYMLINK to the canonical
 * source (claude-auth.ts), so the dev box's global ~/.claude hooks/settings
 * never fire inside SDK sessions while the CLI always refreshes the one live
 * token file. Every turn preflights ensureClaudeAuth() (emitting an `auth`
 * frame); a classified auth failure repairs + retries the turn once on the
 * same session, then emits `auth_error` (BACKLOG S8).
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { isFixRequest, systemPromptFor, type AgentKind } from './prompts.ts';
import { ensureClaudeAuth, type ClaudeAuthRepair } from './claude-auth.ts';
import { tryResolveDeferredSetup } from './deferred.ts';
import {
  createBuilderServer,
  createPageServer,
  getBuildThread,
  REMEMBER_USER_DEFAULT_TOOL_QUALIFIED,
  ASK_CLARIFYING_QUESTIONS_TOOL_QUALIFIED,
} from './tools.ts';
import { loadUserDefaults } from './memory.ts';
import { createPostgresSessionStore } from './session-store.ts';
import { buildThreads, db, type BuildThreadServedBy } from './db.ts';
import { config } from './config.ts';

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * FE5 serve-identity: which exact process served a build turn. Computed once
 * per process; stamped on every thread write (last-writer-wins answers "which
 * process served the most recent turn") and emitted as the `served_by` SSE
 * frame at turn start — the Pillar-2 logged event the FE5 acceptance test
 * asserts on.
 */
export const SERVED_BY: BuildThreadServedBy = {
  pid: process.pid,
  port: config.port,
  mode: config.serveMode,
  hostname: hostname(),
  startedAt: new Date().toISOString(),
};

export type EmitFn = (event: string, data: unknown) => Promise<void>;

/**
 * F0.8 hard stop (KIV superseded): a PostToolUse hook, not a rendering
 * filter. The SDK calls this synchronously right after
 * ask_clarifying_questions returns and, on continue:false, ends the turn
 * there — the model is never invoked again this turn, so no trailing text
 * is ever generated (compute or otherwise), unlike the earlier
 * suppress-on-render approach the user explicitly rejected. Native
 * AskUserQuestion was ruled out first: zero references in the SDK's own
 * bundled runtime (sdk.mjs) — its execution lives entirely inside the
 * spawned Claude Code CLI binary's own interactive terminal loop, with no
 * hook/callback exposed to a headless query() embedder to supply an
 * answer. canUseTool is a pre-execution allow/deny/modify-input gate
 * (PermissionResult), not an answer-supply channel, so it cannot stand in
 * either. Full interactive-session/hooks harness (skills, subagent
 * dispatch, "company brain") stays a KIV — this fix needs none of that.
 */
const ASK_CLARIFYING_QUESTIONS_HOOKS: NonNullable<
  Parameters<typeof query>[0]['options']
>['hooks'] = {
  PostToolUse: [
    {
      matcher: ASK_CLARIFYING_QUESTIONS_TOOL_QUALIFIED,
      hooks: [
        async (input) => {
          if (
            input.hook_event_name === 'PostToolUse' &&
            input.tool_name === ASK_CLARIFYING_QUESTIONS_TOOL_QUALIFIED
          ) {
            return {
              continue: false,
              stopReason:
                "Awaiting the user's answer to the question just asked.",
            };
          }
          return {};
        },
      ],
    },
  ],
};

async function upsertThread(
  subjectId: number,
  agentKind: AgentKind,
  patch: { sessionId?: string; status?: string }
): Promise<void> {
  await db
    .insert(buildThreads)
    .values({
      subjectId,
      agentKind,
      sessionId: patch.sessionId ?? null,
      status: patch.status ?? 'building',
      servedBy: SERVED_BY,
    })
    .onConflictDoUpdate({
      target: [buildThreads.subjectId, buildThreads.agentKind],
      set: {
        ...(patch.sessionId !== undefined
          ? { sessionId: patch.sessionId }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        servedBy: SERVED_BY,
        updatedAt: new Date(),
      },
    });
}

/**
 * Reduce an SDK message to the JSON frame the studio chat renders.
 *
 * FE2 invisibility: hidden-tool (remember_user_default) tool_use blocks are
 * dropped from `assistant` frames, their ids recorded in hiddenToolUseIds, and
 * the matching tool_result entries dropped from `tool_result` frames. The
 * studio closes tool chips by ORDER-matching results to uses
 * (usePearlStream.ts), so the pair must always be suppressed together — never
 * one alone. The raw session_entries transcript keeps both (Pillar 2).
 */
function frameFor(
  msg: SDKMessage,
  hiddenToolUseIds: Set<string>
): { event: string; data: unknown } | null {
  switch (msg.type) {
    case 'stream_event':
      return { event: 'stream_event', data: msg.event };
    case 'assistant': {
      const blocks: Array<Record<string, unknown>> = [];
      let suppressed = false;
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          blocks.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          if (block.name === REMEMBER_USER_DEFAULT_TOOL_QUALIFIED) {
            hiddenToolUseIds.add(block.id);
            suppressed = true;
            continue;
          }
          blocks.push({
            type: 'tool_use',
            name: block.name,
            input: block.input,
          });
        }
      }
      if (suppressed && blocks.length === 0) return null;
      return { event: 'assistant', data: { uuid: msg.uuid, blocks } };
    }
    case 'user': {
      const content = msg.message.content;
      if (!Array.isArray(content)) return null;
      const results: Array<Record<string, unknown>> = [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          if (hiddenToolUseIds.has(block.tool_use_id)) continue;
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
    case 'auth_status':
      // CLI-side auth activity (e.g. mid-run token refresh) surfaced as its
      // own frame so auth trouble is distinguishable from build failures (S8).
      return {
        event: 'auth_status',
        data: {
          isAuthenticating: msg.isAuthenticating,
          error: msg.error ?? null,
        },
      };
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
  subjectId: number;
  agentKind: AgentKind;
  message: string;
  emit: EmitFn;
  /**
   * FE2: the authenticated user this build belongs to, forwarded by the API
   * build proxy as x-user-id (falls back to the dev user for direct sidecar
   * hits — see index.ts). Scopes the silent user-default memory: the turn's
   * system prompt is injected with this user's stored defaults, and the
   * hidden remember_user_default tool writes under this id.
   */
  userId: string;
  /**
   * FE1 credential-gap auto-run: when true the turn is a headless kick from
   * the sidecar's /internal/credentials-changed endpoint. Behave exactly as a
   * normal turn through the deferred-setup resolution attempt, but if the
   * gap does not resolve, return WITHOUT invoking the agent SDK — the cost
   * guard that keeps an unrelated credential add from burning an agent turn
   * on every blocked thread. On success the turn proceeds as a normal resume.
   */
  autoUnblockOnly?: boolean;
}): Promise<{ sessionId: string | null; status: string }> {
  const {
    subjectId,
    agentKind,
    message,
    emit,
    userId,
    autoUnblockOnly = false,
  } = opts;

  const existing = await getBuildThread(subjectId, agentKind);
  const resume = existing?.sessionId ?? undefined;

  if (autoUnblockOnly && existing?.status !== 'blocked_on_credential') {
    // Thread already unblocked (or absent) by the time the kick landed:
    // no-op, leave the row untouched.
    await emit('deferred_setup', {
      resolved: false,
      reason: `thread is ${existing?.status ?? 'absent'}, not blocked_on_credential; auto-unblock is a no-op`,
      credentialType: null,
      results: [],
      trigger: 'credential-added',
    });
    return { sessionId: resume ?? null, status: existing?.status ?? 'none' };
  }

  // Blocked-state invariant: blocked_on_credential is sticky. A turn may
  // only transition OUT of blocked when the deferred setup resolves (missing
  // credential now connected + deferred script completed); every other turn
  // leaves the status and deferred_setup untouched (failed attempts only
  // annotate deferred_setup.lastAttempt).
  let blockedNow = existing?.status === 'blocked_on_credential';
  let prompt = message;
  if (blockedNow && existing) {
    const resolution = await tryResolveDeferredSetup(
      existing,
      autoUnblockOnly ? 'credential-added' : 'turn-start'
    );
    await emit('deferred_setup', resolution);
    blockedNow = !resolution.resolved;
    if (resolution.resolved) {
      // Without this note the resumed session re-runs the setup it remembers
      // as pending, provisioning duplicate resources (observed live: a second
      // Standup Log sheet). Tell the agent the deferred work already ran.
      prompt =
        `[Automatic setup notice — not from the user] The previously deferred setup for ${resolution.credentialType ?? 'the missing credential'} has ALREADY been executed automatically before this turn. Results: ${JSON.stringify(resolution.results)}. Produced resource ids are already stored in the flow's default_inputs. Do NOT provision or seed again; reuse these ids.\n\n` +
        message;
    }
  }
  if (autoUnblockOnly && blockedNow) {
    // Cost guard: the credential change did not close this thread's gap
    // (wrong type, missing scope, or a deferred step failed — the reason is
    // persisted on deferred_setup.lastAttempt). No SDK query, no status write.
    return { sessionId: resume ?? null, status: 'blocked_on_credential' };
  }
  // FE5: this process is now serving the turn — emit the identity frame and
  // stamp the thread row (upsertThread carries SERVED_BY on every write).
  await emit('served_by', SERVED_BY);
  await upsertThread(subjectId, agentKind, {
    ...(blockedNow ? {} : { status: 'building' }),
  });

  // Sticky-blocked: the row stays blocked either because
  // report_missing_credential / ask_clarifying_questions (F0.8) fired mid-run,
  // or because the thread entered the turn blocked and the deferred setup did
  // not resolve (turn start never clears it). Either way the marker outlives
  // the turn's own outcome — the SDK's own "no error" result must never
  // overwrite a tool's mid-turn "actually, I'm blocked/waiting" write.
  const STICKY_STATUSES = new Set([
    'blocked_on_credential',
    'blocked_on_clarification',
  ]);
  const persistFinalStatus = async (finalStatus: string): Promise<string> => {
    const after = await getBuildThread(subjectId, agentKind);
    const status =
      after?.status && STICKY_STATUSES.has(after.status)
        ? after.status
        : finalStatus;
    await db
      .update(buildThreads)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(buildThreads.subjectId, subjectId),
          eq(buildThreads.agentKind, agentKind)
        )
      );
    return status;
  };

  // --- S8 auth preflight: self-heal the credential link, surface the state.
  // Failure texts the spawned CLI emits on dead auth: HTTP 401s, OAuth token
  // expiry/revocation, and the missing-credential "Invalid API key · Please
  // run /login" message.
  const AUTH_FAILURE_PATTERN =
    /401|unauthoriz|OAuth|token.*(expired|revoked)|authentication|invalid api key|please run \/login/i;
  const authFrame = (repair: ClaudeAuthRepair, phase: string) => ({
    phase,
    mode: repair.state.mode,
    linked: repair.state.linked,
    expired: repair.state.expired,
    expiresAt: repair.state.expiresAt,
    repaired: repair.repaired,
    actions: repair.actions,
  });

  // When routed through OpenRouter (a stable API key, not a rotating OAuth
  // token — see config.ts), there is no Claude-Max credential file to link,
  // heal, or expire. Skip ensureClaudeAuth() entirely and report a
  // synthesized always-live state so the `auth` frame stays consistent for
  // callers watching it.
  const usingOpenRouter = config.openrouterApiKey !== null;

  // When the preflight already knows the credential is dead (expired source,
  // unreadable source), ANY turn failure is classified as auth — the CLI's
  // message text varies but the cause does not.
  let authSuspect = false;
  if (usingOpenRouter) {
    await emit('auth', {
      phase: 'preflight',
      mode: 'openrouter-api-key',
      linked: true,
      expired: false,
      expiresAt: null,
      repaired: false,
      actions: [],
    });
  } else {
    try {
      const repair = ensureClaudeAuth();
      authSuspect =
        repair.state.mode === 'credentials-file' &&
        (repair.state.expired || !repair.state.sourceReadable);
      await emit('auth', authFrame(repair, 'preflight'));
    } catch (error) {
      const reason = `credential provisioning failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await emit('auth_error', { reason });
      const status = await persistFinalStatus('error');
      return { sessionId: resume ?? null, status };
    }
  }

  // FE2: read this user's stored defaults once per turn and inject them into
  // the system prompt — the invisible channel (system prompts never appear in
  // frames or the transcript, unlike prompt-prefixing, which leaks).
  const userDefaults = await loadUserDefaults(userId).catch(
    (error: unknown) => {
      console.warn(
        `[builder-agent] loadUserDefaults(${userId}) failed, injecting none: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return [];
    }
  );

  // FE2 invisibility state: tool_use ids of hidden remember_user_default
  // calls, shared across attempts so a repair-retry keeps pairs aligned.
  const hiddenToolUseIds = new Set<string>();

  const runAttempt = async (
    resumeId: string | undefined
  ): Promise<{
    sessionId: string | null;
    finalStatus: string;
    authFailure: string | null;
  }> => {
    const q = query({
      prompt,
      options: {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: config.claudeConfigDir,
          ...(usingOpenRouter
            ? {
                ANTHROPIC_BASE_URL: config.openrouterBaseUrl,
                ANTHROPIC_API_KEY: config.openrouterApiKey as string,
                // Force the key path; a stray ANTHROPIC_AUTH_TOKEN in the
                // inherited env would otherwise take precedence.
                ANTHROPIC_AUTH_TOKEN: '',
              }
            : {}),
        },
        cwd: serviceRoot,
        model: config.model,
        // Fix-mode turns (message carries the studio's run-error marker) load
        // the FIXING skill on the SAME session — same agent, same thread; only
        // this turn's system prompt gains the fix-mode module.
        systemPrompt: systemPromptFor(agentKind, {
          fixMode: agentKind === 'flow' && isFixRequest(message),
          userDefaults,
        }),
        includePartialMessages: true,
        tools: [],
        mcpServers: {
          builder:
            agentKind === 'flow'
              ? createBuilderServer(subjectId, userId)
              : createPageServer(subjectId, userId),
        },
        allowedTools: ['mcp__builder__*'],
        maxTurns: 120,
        sessionStore: createPostgresSessionStore(),
        hooks: ASK_CLARIFYING_QUESTIONS_HOOKS,
        ...(resumeId !== undefined ? { resume: resumeId } : {}),
      },
    });

    let sessionId: string | null = resumeId ?? null;
    let finalStatus = 'ready';
    let authFailure: string | null = null;

    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id;
          await upsertThread(subjectId, agentKind, {
            sessionId: msg.session_id,
          });
        }
        if (msg.type === 'result') {
          finalStatus = msg.is_error ? 'error' : 'ready';
          if (msg.is_error) {
            const errorText =
              msg.subtype === 'success' ? msg.result : msg.errors.join('; ');
            if (authSuspect || AUTH_FAILURE_PATTERN.test(errorText)) {
              authFailure = errorText;
            }
          }
        }
        const frame = frameFor(msg, hiddenToolUseIds);
        if (frame !== null) {
          await emit(frame.event, frame.data);
        }
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (authSuspect || AUTH_FAILURE_PATTERN.test(text)) {
        return { sessionId, finalStatus: 'error', authFailure: text };
      }
      throw error;
    }
    return { sessionId, finalStatus, authFailure };
  };

  let attempt = await runAttempt(resume);

  if (attempt.authFailure !== null) {
    // Classified auth failure: repair once and retry the SAME session so the
    // thread is unbroken. Retry only when the repair left a live credential;
    // otherwise a second identical failure is certain and skipped.
    // OpenRouter uses a static API key — a failure there is a bad/rejected
    // key, not an expired token, so there is nothing to repair and no retry.
    let retryable = false;
    if (!usingOpenRouter) {
      try {
        const repair = ensureClaudeAuth();
        await emit('auth', authFrame(repair, 'retry'));
        retryable =
          repair.state.mode === 'oauth-token-env' ||
          (repair.state.sourceReadable && !repair.state.expired);
      } catch (error) {
        await emit('auth', {
          phase: 'retry',
          repaired: false,
          actions: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (retryable) {
      authSuspect = false;
      attempt = await runAttempt(attempt.sessionId ?? resume);
    }
    if (attempt.authFailure !== null) {
      await emit('auth_error', { reason: attempt.authFailure });
      attempt = { ...attempt, finalStatus: 'error' };
    }
  }

  const status = await persistFinalStatus(attempt.finalStatus);
  return { sessionId: attempt.sessionId, status };
}
