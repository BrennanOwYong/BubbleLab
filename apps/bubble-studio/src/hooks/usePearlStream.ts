/**
 * Claude-harness transport for the flow-page conversation panel.
 *
 * The panel UI (PearlChat + pearlChatStore) is the pre-effba78 editor pane;
 * this module replaces its deleted Pearl/Coffee backend (`/ai/pearl`,
 * `/bubble-flow/generate`) with the builder-agent sidecar reached through the
 * API's /build/:flowId/{message,thread} proxy. Harness SSE frames are
 * translated into the same pearlChatStore timeline events the old UI
 * rendered (thinking indicator, tool_start/tool_complete cards, streaming
 * token block, final assistant message).
 */
import { useQuery } from '@tanstack/react-query';
import { getPearlChatStore } from '../stores/pearlChatStore';
import { useUIStore } from '../stores/uiStore';
import {
  fetchBuildThread,
  streamBuildMessage,
  streamBuildSubscribe,
} from '../services/buildAgentApi';
import { queryClient } from '../providers/query-client';
import { api } from '../lib/api';
import { setEditorCode } from './useEditor';
import type { AssistantChatMessage, ChatMessage } from '../components/ai/type';
import { getPrimaryOutput } from '../components/flow_visualizer/resultNodeValue';
import { ClarificationQuestionSchema } from '../types/conversation';
import { z } from 'zod';

/** Kept name from the Pearl era: the shape of the end-of-build callback. */
export interface HandleStreamingEventOptions {
  /** Called when the initial build turn finishes (refetch flow, sound, etc.) */
  onGenerationComplete?: (data: {
    generatedCode: string;
    summary: string;
    bubbleParameters?: Record<string, unknown>;
  }) => void;
}

let harnessCallSeq = 0;

function refreshFlowQueries(flowId: number): void {
  void queryClient.invalidateQueries({ queryKey: ['bubbleFlow', flowId] });
  void queryClient.invalidateQueries({ queryKey: ['bubbleFlowList'] });
  void queryClient.invalidateQueries({
    queryKey: ['build-thread-status', flowId],
  });
}

/** Message shown when a harness turn ends in an error result. */
export const BUILD_FAILED_MESSAGE =
  'Build failed: the agent session ended with an error before the flow was saved. Retry, or send a message describing what to change.';

/**
 * After a harness turn that saved the flow, the open Monaco buffer still
 * holds the pre-fix code; the next Run would validate that stale buffer with
 * syncInputsWithFlow and silently overwrite the agent's fix (observed live on
 * the flow-70 fixer test). Pull the server truth and reset the editor.
 */
async function syncEditorFromServer(flowId: number): Promise<void> {
  try {
    const flow = await api.get<{ code?: string }>(`/bubble-flow/${flowId}`);
    if (typeof flow.code === 'string' && flow.code.trim() !== '') {
      setEditorCode(flow.code);
    }
  } catch {
    // Query invalidation already queued; the editor keeps its buffer.
  }
}

/**
 * The one place a raw SSE frame becomes a pearlChatStore change. Shared by
 * every way of watching a build turn — sending one directly (sendBuildMessage)
 * or rejoining an in-flight one (subscribeToBuildThread) — so there is
 * exactly one implementation of "what does this frame mean," never two that
 * can silently drift apart (that drift was F0.8c: the rehydration path had
 * its own copy of this logic and quietly fell behind the live one).
 */
function createFrameHandler(
  flowId: number,
  store: ReturnType<typeof getPearlChatStore>,
  options: { initialGeneration: boolean }
) {
  const s = () => store.getState();
  let pendingText = '';
  const runningCallIds: string[] = [];
  let finalStatus: string | null = null;
  let sawError = false;
  let sawSaveFlow = false;
  let sawClarifyingQuestion = false;

  const closeOldestRunningTool = (isError: boolean) => {
    const callId = runningCallIds.shift();
    if (!callId) return;
    s().removeToolCall(callId);
    s().updateTimelineEventByCallId(callId, (e) => ({
      type: 'tool_complete' as const,
      tool: e.type === 'tool_start' ? e.tool : 'tool',
      // The proxy's tool_result frames carry only success/failure, not the
      // tool output payload.
      output: isError
        ? { error: 'Tool reported an error' }
        : { status: 'completed' },
      duration: e.type === 'tool_start' ? Date.now() - e.startTime : 0,
      callId,
      timestamp: e.timestamp,
    }));
  };

  const flushAssistantText = () => {
    if (pendingText.trim() !== '') {
      s().removeLastTimelineEventIf((e) => e.type === 'token');
      const assistantMessage: AssistantChatMessage = {
        id: `harness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'assistant',
        content: pendingText,
        resultType: 'answer',
        timestamp: new Date(),
      };
      s().addMessage(assistantMessage);
    }
    pendingText = '';
  };

  const onFrame = (frame: { event: string; data: unknown }) => {
    switch (frame.event) {
      case 'stream_event': {
        const ev = frame.data as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (
          ev.type === 'content_block_delta' &&
          ev.delta?.type === 'text_delta' &&
          typeof ev.delta.text === 'string'
        ) {
          s().removeLastTimelineEventIf((e) => e.type === 'llm_thinking');
          pendingText += ev.delta.text;
          s().appendToLastTokenOrAdd(ev.delta.text);
        }
        break;
      }
      case 'assistant': {
        const data = frame.data as {
          blocks?: Array<{ type: string; name?: string; input?: unknown }>;
        };
        for (const block of data.blocks ?? []) {
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            if (block.name === 'mcp__builder__save_flow') {
              sawSaveFlow = true;
            }
            // A missing-credential report becomes an inline "Connect"
            // affordance so the user can add the credential without leaving
            // the conversation.
            if (block.name === 'mcp__builder__report_missing_credential') {
              const credInput = block.input as
                | { credentialType?: string }
                | undefined;
              if (credInput?.credentialType) {
                flushAssistantText();
                s().addMessage({
                  id: `cred-req-${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2, 8)}`,
                  type: 'credential_request',
                  credentialType: credInput.credentialType,
                  timestamp: new Date(),
                });
              }
            }
            // F0.8: a structured clarifying-question call becomes the same
            // clarification_request message the pre-effba78 Coffee UI
            // rendered (ClarificationWidget) — the studio already knows how
            // to show and answer it (usePearlChatStore.ts
            // submitClarificationAnswers), this is just the missing
            // producer on the harness side.
            if (block.name === 'mcp__builder__ask_clarifying_questions') {
              const parsed = z
                .object({
                  questions: z.array(ClarificationQuestionSchema).min(1),
                })
                .safeParse(block.input);
              if (parsed.success) {
                sawClarifyingQuestion = true;
                flushAssistantText();
                s().addMessage({
                  id: `clarify-req-${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2, 8)}`,
                  type: 'clarification_request',
                  questions: parsed.data.questions,
                  timestamp: new Date(),
                });
              }
            }
            // U2: the agent registered the flow's headline output after a
            // successful self-test — the conversation shows the result
            // widget (link and/or stated outcomes) inline, mirroring the
            // credential_request wiring above. getPrimaryOutput validates
            // the tool input shape without casting.
            if (block.name === 'mcp__builder__set_primary_output') {
              const primaryOutput = getPrimaryOutput({
                primaryOutput: block.input,
              });
              if (primaryOutput !== null) {
                flushAssistantText();
                s().addMessage({
                  id: `result-ready-${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2, 8)}`,
                  type: 'result_ready',
                  primaryOutput,
                  timestamp: new Date(),
                });
              }
            }
            // A tool call closes the current text segment.
            flushAssistantText();
            s().removeLastTimelineEventIf((e) => e.type === 'llm_thinking');
            const callId = `harness-call-${++harnessCallSeq}`;
            runningCallIds.push(callId);
            s().addToolCall(callId);
            s().addEvent({
              type: 'tool_start',
              tool: block.name.replace('mcp__builder__', ''),
              input: block.input,
              callId,
              startTime: Date.now(),
            });
          }
        }
        break;
      }
      case 'tool_result': {
        // Assistant frames carry no tool_use ids, so each result closes
        // the oldest running tool (results arrive in call order).
        const data = frame.data as {
          results?: Array<{ is_error?: boolean }>;
        };
        for (const result of data.results ?? []) {
          closeOldestRunningTool(result.is_error === true);
        }
        // The tool may have saved code or provisioned resources.
        refreshFlowQueries(flowId);
        break;
      }
      case 'result':
        flushAssistantText();
        break;
      case 'done': {
        const data = frame.data as { status?: string };
        if (typeof data.status === 'string') finalStatus = data.status;
        // The sidecar reports 'error' when the SDK turn ended with an
        // error result; without surfacing it the flow page shows a
        // permanent "still being built" state for a 0-code flow.
        if (data.status === 'error' && !sawError) {
          sawError = true;
          s().addEvent({
            type: 'generation_error',
            message: BUILD_FAILED_MESSAGE,
          });
        }
        break;
      }
      case 'error': {
        const data = frame.data as { message?: string };
        sawError = true;
        s().addEvent({
          type: 'generation_error',
          message: data.message ?? 'Build stream failed',
        });
        break;
      }
      default:
        // session / heartbeat / rate_limit / deferred_setup frames carry
        // no timeline content.
        break;
    }
  };

  // Only runs when the stream ended without throwing.
  const settleClean = () => {
    flushAssistantText();
    while (runningCallIds.length > 0) closeOldestRunningTool(false);
    s().removeLastTimelineEventIf((e) => e.type === 'llm_thinking');
    // F0.7: finalStatus defaults to 'ready' the moment the SDK turn ends
    // without an error — that's true of a turn that only asked a clarifying
    // question or wrote a prose question, not just a turn that saved code.
    // Require sawSaveFlow so "Code generation complete" only fires when code
    // actually exists, never when the agent is sitting there waiting on you.
    if (
      options.initialGeneration &&
      !sawError &&
      !sawClarifyingQuestion &&
      sawSaveFlow &&
      finalStatus === 'ready'
    ) {
      s().addEvent({ type: 'generation_complete', summary: '', code: '' });
    }
  };

  // Always runs, however the stream ended (mirrors a finally block).
  const settleAlways = () => {
    s().clearToolCalls();
    s().setGenerationCompleted(true);
    s().setIsGenerating(false);
    s().setIsCoffeeLoading(false);
    refreshFlowQueries(flowId);
    if (sawSaveFlow) {
      // The agent saved new code this turn; a stale Monaco buffer must not
      // survive it (the next Run would write the old code back).
      void syncEditorFromServer(flowId);
    }
    // Same F0.7 gate as settleClean's generation_complete above —
    // onGenerationComplete plays the completion sound and tracks a
    // success:true analytics event; it must not fire for a turn that
    // errored, asked a clarifying question, or otherwise ended without
    // saving code. Deliberately in "always", not "clean": a save that
    // happened before a later network hiccup still counts.
    if (
      options.initialGeneration &&
      !sawError &&
      !sawClarifyingQuestion &&
      sawSaveFlow
    ) {
      s().onGenerationComplete?.({ generatedCode: '', summary: '' });
    }
  };

  return { onFrame, settleClean, settleAlways };
}

/**
 * Send one user message to the flow-builder harness session and mirror the
 * streamed frames into the flow's pearl store timeline. Resolves when the
 * turn's SSE stream ends. The caller is responsible for having added the
 * user message to the store (so display and transcript stay symmetric).
 */
export async function sendBuildMessage(
  flowId: number,
  message: string,
  options?: { initialGeneration?: boolean }
): Promise<void> {
  const store = getPearlChatStore(flowId);
  const s = () => store.getState();
  if (s().hasActiveGenerationStream()) {
    console.log(`[sendBuildMessage] Stream already active for flow ${flowId}`);
    return;
  }

  const abortController = new AbortController();
  s().registerGenerationStream(abortController);
  s().setIsGenerating(true);
  s().addEvent({ type: 'llm_thinking' });

  const handler = createFrameHandler(flowId, store, {
    initialGeneration: options?.initialGeneration ?? false,
  });

  try {
    await streamBuildMessage(
      'flow',
      flowId,
      message,
      (frame) => {
        if (abortController.signal.aborted) return;
        handler.onFrame(frame);
      },
      { signal: abortController.signal }
    );
    handler.settleClean();
  } catch (error) {
    if (!abortController.signal.aborted) {
      s().addEvent({
        type: 'generation_error',
        message:
          error instanceof Error ? error.message : 'Build request failed',
      });
    }
  } finally {
    handler.settleAlways();
  }
}

/**
 * Populate the store from a thread snapshot's transcript — the same shape
 * both GET /thread and GET /subscribe's `history` frame return, so a
 * rejoined conversation renders identically to a plain one-shot fetch.
 * Returns whether save_flow ever appeared in this history, so a live
 * continuation (subscribeToBuildThread) can tell whether it's still within
 * the flow's own first build or a later, ordinary turn.
 */
function applyHistoryToStore(
  store: ReturnType<typeof getPearlChatStore>,
  transcript: Array<{
    role: 'user' | 'assistant';
    blocks: Array<Record<string, unknown>>;
  }>
): boolean {
  let sawSaveFlow = false;
  store.getState().clearMessages();
  for (const entry of transcript) {
    let segmentText = '';
    const flushSegment = () => {
      if (segmentText.trim() === '') {
        segmentText = '';
        return;
      }
      const message: ChatMessage =
        entry.role === 'user'
          ? {
              id: `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'user',
              content: segmentText,
              timestamp: new Date(),
            }
          : {
              id: `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'assistant',
              content: segmentText,
              resultType: 'answer',
              timestamp: new Date(),
            };
      store.getState().addMessage(message);
      segmentText = '';
    };
    for (const block of entry.blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        segmentText += (segmentText === '' ? '' : '\n') + block.text;
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        flushSegment();
        if (block.name === 'mcp__builder__save_flow') sawSaveFlow = true;
        // Mirror the live frame handler's special-casing (F0.8c): a
        // reloaded/revisited/rejoined page must reconstruct the same inline
        // widgets a live turn shows, not just a generic "completed" chip —
        // the structured data (credential type, questions, primary output)
        // is already durable in the stored transcript, only the UI
        // reconstruction was missing it.
        if (block.name === 'mcp__builder__report_missing_credential') {
          const credInput = block.input as
            | { credentialType?: string }
            | undefined;
          if (credInput?.credentialType) {
            store.getState().addMessage({
              id: `thread-cred-req-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
              type: 'credential_request',
              credentialType: credInput.credentialType,
              timestamp: new Date(),
            });
          }
        } else if (block.name === 'mcp__builder__ask_clarifying_questions') {
          const parsed = z
            .object({ questions: z.array(ClarificationQuestionSchema).min(1) })
            .safeParse(block.input);
          if (parsed.success) {
            store.getState().addMessage({
              id: `thread-clarify-req-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
              type: 'clarification_request',
              questions: parsed.data.questions,
              timestamp: new Date(),
            });
          }
        } else if (block.name === 'mcp__builder__set_primary_output') {
          const primaryOutput = getPrimaryOutput({
            primaryOutput: block.input,
          });
          if (primaryOutput !== null) {
            store.getState().addMessage({
              id: `thread-result-ready-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
              type: 'result_ready',
              primaryOutput,
              timestamp: new Date(),
            });
          }
        }
        store.getState().addEvent({
          type: 'tool_complete',
          tool: block.name.replace('mcp__builder__', ''),
          output: { status: 'completed' },
          duration: 0,
          callId: `thread-call-${++harnessCallSeq}`,
        });
      }
    }
    flushSegment();
  }
  return sawSaveFlow;
}

/**
 * Build-thread status for a flow ('building' | 'ready' | 'error' |
 * 'blocked_on_credential', or null when the flow has no build thread). Used
 * by the canvas to distinguish "still being built" from "build failed" for a
 * flow with no code: a failed build must show an error state, never an
 * eternal building overlay.
 */
export function useBuildThreadStatus(
  flowId: number | null,
  enabled: boolean
): string | null {
  const { data } = useQuery({
    queryKey: ['build-thread-status', flowId],
    enabled: enabled && flowId !== null,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    // Aligned with the flow record's own pending poll (10s) so an externally
    // failed build surfaces without a manual refresh.
    refetchInterval: 10_000,
    queryFn: async (): Promise<string | null> => {
      if (!flowId) return null;
      try {
        const thread = await fetchBuildThread('flow', flowId);
        return thread.status;
      } catch {
        // No thread yet (or transient proxy error): treat as unknown.
        return null;
      }
    },
  });
  return data ?? null;
}

// Synchronous re-entry guard for subscribeToBuildThread: the async gap
// before the first frame arrives means hasActiveGenerationStream() alone
// can't stop a concurrent second call (e.g. React StrictMode's double
// invoke) from opening a second /subscribe connection and double-applying
// every frame to the store.
const subscribeInFlight = new Set<number>();

/**
 * Rejoin a flow's thread via GET /subscribe: apply the history snapshot,
 * then — if and only if the thread is still building — continue exactly
 * like a live turn, through the same frame handler sendBuildMessage uses.
 * The caller only needs to know a thread exists (see useFlowConversation);
 * this function handles both "it already finished" and "it's still going"
 * transparently, since the server — not the caller — decides which one
 * happens.
 *
 * `fallbackPrompt` covers a real, narrow window: the SDK's session store
 * flushes in batches, not per-message, so a thread that started building
 * moments ago can report status:'building' with a genuinely empty
 * transcript — the first turn's own prompt hasn't landed in session_entries
 * yet. Rejoining in that exact window would otherwise show live progress
 * (tool calls, "Thinking…") with no visible context for what's even being
 * built. Seeding the flow's own already-known prompt only when history
 * comes back truly empty closes that gap without misrepresenting a later
 * turn (by the time a second turn starts, the first has long since flushed,
 * so this never fires then).
 */
export async function subscribeToBuildThread(
  flowId: number,
  fallbackPrompt?: string
): Promise<void> {
  const store = getPearlChatStore(flowId);
  const s = () => store.getState();
  if (s().hasActiveGenerationStream() || subscribeInFlight.has(flowId)) {
    return;
  }
  subscribeInFlight.add(flowId);

  const abortController = new AbortController();
  // A plain `let` reassigned only inside the frame callback confuses TS's
  // cross-closure narrowing (it infers `never` at the later read sites); an
  // object holder sidesteps that entirely.
  const ref: { handler: ReturnType<typeof createFrameHandler> | null } = {
    handler: null,
  };

  try {
    await streamBuildSubscribe(
      'flow',
      flowId,
      (frame) => {
        if (abortController.signal.aborted) return;
        if (frame.event === 'history') {
          const data = frame.data as {
            status?: string;
            transcript?: Array<{
              role: 'user' | 'assistant';
              blocks: Array<Record<string, unknown>>;
            }>;
          };
          const transcript = data.transcript ?? [];
          const sawSaveFlowInHistory = applyHistoryToStore(store, transcript);
          if (data.status === 'building') {
            // Session-store flush lag (see docstring): the first turn's own
            // prompt can genuinely not be in session_entries yet.
            if (transcript.length === 0 && fallbackPrompt) {
              s().addMessage({
                id: `subscribe-fallback-user-${Date.now()}`,
                type: 'user',
                content: fallbackPrompt,
                timestamp: new Date(),
              });
            }
            // Only now does this tab look "live" to the rest of the UI —
            // a thread that already finished never registers a generation
            // stream, so it renders identically to a plain fetch.
            s().registerGenerationStream(abortController);
            s().setIsGenerating(true);
            s().addEvent({ type: 'llm_thinking' });
            ref.handler = createFrameHandler(flowId, store, {
              // Still within the flow's own first build only if nothing in
              // the history just applied already saved it.
              initialGeneration: !sawSaveFlowInHistory,
            });
          } else {
            // A stored thread whose last turn errored must rejoin WITH its
            // error (message + Retry button), not as a silently truncated
            // conversation.
            if (data.status === 'error') {
              s().addEvent({
                type: 'generation_error',
                message: BUILD_FAILED_MESSAGE,
              });
            }
            s().setGenerationCompleted(true);
          }
          return;
        }
        ref.handler?.onFrame(frame);
      },
      { signal: abortController.signal }
    );
    ref.handler?.settleClean();
  } catch (error) {
    if (!abortController.signal.aborted && ref.handler) {
      s().addEvent({
        type: 'generation_error',
        message:
          error instanceof Error ? error.message : 'Build request failed',
      });
    }
  } finally {
    subscribeInFlight.delete(flowId);
    ref.handler?.settleAlways();
  }
}

/**
 * The single, self-contained entry point for a flow page's conversation.
 * Query the thread first, unconditionally, regardless of how the page was
 * reached (fresh creation, reload, a shared link, browser back — all
 * identical here): no session yet means nothing has ever been sent, so send
 * the flow's own stored prompt; a session already existing means there's
 * real history, so always rejoin via subscribeToBuildThread, which itself
 * decides — from the server's state, not this hook's — whether that rejoin
 * also continues live.
 */
export function useFlowConversation(
  flowId: number | null,
  opts: {
    /** The flow's own stored prompt — sent only when no thread exists yet. */
    prompt?: string;
    enabled: boolean;
    onGenerationComplete?: HandleStreamingEventOptions['onGenerationComplete'];
  }
) {
  return useQuery({
    queryKey: ['flow-conversation', flowId],
    enabled: opts.enabled && flowId !== null,
    queryFn: async (): Promise<boolean> => {
      if (!flowId) return false;
      const store = getPearlChatStore(flowId);
      const state = store.getState();
      if (
        state.hasActiveGenerationStream() ||
        state.generationCompleted ||
        state.messages.length > 0
      ) {
        return state.generationCompleted;
      }
      if (opts.onGenerationComplete) {
        state.setOnGenerationComplete(opts.onGenerationComplete);
      }

      const thread = await fetchBuildThread('flow', flowId);
      // 'none' means no build_threads row exists at all — genuinely never
      // started. NOT the same as sessionId === null: a turn that has just
      // started has a row (status:'building') before the SDK's system/init
      // message attaches its sessionId a moment later. Checking sessionId
      // here would misfire "nothing sent yet" during that exact window and
      // send a second, colliding turn (409: a build is already running).
      // subscribeToBuildThread doesn't need sessionId anyway — it registers
      // by (kind, subjectId), and picks up the session id live once it
      // arrives.
      if (thread.status === 'none') {
        // No thread yet: nothing to rejoin. Send the flow's own prompt —
        // atomically adding the user's own message here (not a separate,
        // independently-gated effect) so it can never drift out of sync
        // with the decision to send.
        if (opts.prompt) {
          useUIStore.getState().openConsolidatedPanelWith('pearl');
          state.addMessage({
            id: `gen-user-${Date.now()}`,
            type: 'user',
            content: opts.prompt,
            timestamp: new Date(),
          });
          sendBuildMessage(flowId, opts.prompt, {
            initialGeneration: true,
          }).catch((err) => {
            console.error('[useFlowConversation] send error:', err);
          });
        }
      } else {
        subscribeToBuildThread(flowId, opts.prompt).catch((err) => {
          console.error('[useFlowConversation] subscribe error:', err);
        });
      }

      return store.getState().generationCompleted;
    },
    refetchInterval: () => {
      if (!flowId) return false;
      const store = getPearlChatStore(flowId);
      return store.getState().hasActiveGenerationStream() ? 100 : false;
    },
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/**
 * Continue after a plan approval. The harness has no separate building
 * phase; the approval (and any plan context) rides as a normal message on
 * the same session.
 */
export async function startBuildingPhase(
  flowId: number,
  _prompt: string,
  planContext?: string
): Promise<void> {
  const message = planContext
    ? `The plan is approved. Proceed with the build.\n\n${planContext}`
    : 'The plan is approved. Proceed with the build.';
  await sendBuildMessage(flowId, message);
}

/**
 * Submit clarification answers as a message on the harness session. Adds the
 * clarification_response record to the store, then sends the answers as
 * plain text.
 */
export async function submitClarificationAndContinue(
  flowId: number,
  _prompt: string,
  answers: Record<string, string[]>
): Promise<void> {
  const { getPendingClarificationRequest } = await import(
    '../components/ai/type'
  );
  const store = getPearlChatStore(flowId);
  const storeState = store.getState();
  const pending = getPendingClarificationRequest(storeState.messages);

  storeState.addMessage({
    id: `clarification-response-${Date.now()}`,
    type: 'clarification_response',
    answers,
    originalQuestions: pending?.questions,
    timestamp: new Date(),
  });

  const lines: string[] = ['Answers to your questions:'];
  for (const [questionId, choiceIds] of Object.entries(answers)) {
    const question = pending?.questions.find((q) => q.id === questionId);
    const labels = choiceIds.map(
      (choiceId) =>
        question?.choices.find((c) => c.id === choiceId)?.label ?? choiceId
    );
    lines.push(`- ${question?.question ?? questionId}: ${labels.join(', ')}`);
  }
  await sendBuildMessage(flowId, lines.join('\n'));
}
