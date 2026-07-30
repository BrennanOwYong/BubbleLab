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
import {
  fetchBuildThread,
  streamBuildMessage,
} from '../services/buildAgentApi';
import { queryClient } from '../providers/query-client';
import type { AssistantChatMessage, ChatMessage } from '../components/ai/type';

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

  let pendingText = '';
  const runningCallIds: string[] = [];
  let finalStatus: string | null = null;
  let sawError = false;

  s().addEvent({ type: 'llm_thinking' });

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

  try {
    await streamBuildMessage(
      'flow',
      flowId,
      message,
      (frame) => {
        if (abortController.signal.aborted) return;
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
      },
      { signal: abortController.signal }
    );

    flushAssistantText();
    while (runningCallIds.length > 0) closeOldestRunningTool(false);
    s().removeLastTimelineEventIf((e) => e.type === 'llm_thinking');
    if (options?.initialGeneration && !sawError && finalStatus === 'done') {
      s().addEvent({ type: 'generation_complete', summary: '', code: '' });
    }
  } catch (error) {
    if (!abortController.signal.aborted) {
      s().addEvent({
        type: 'generation_error',
        message:
          error instanceof Error ? error.message : 'Build request failed',
      });
    }
  } finally {
    s().clearToolCalls();
    s().setGenerationCompleted(true);
    s().setIsCoffeeLoading(false);
    refreshFlowQueries(flowId);
    if (options?.initialGeneration) {
      s().onGenerationComplete?.({ generatedCode: '', summary: '' });
    }
  }
}

/**
 * Rebuild the pearl store timeline from the harness's stored transcript so a
 * refreshed page shows the conversation that built the flow.
 *
 * Returns 'empty' when there is no stored turn yet (caller may auto-send the
 * flow prompt), 'active' when a stream is already running in this tab.
 */
async function rehydrateFromThread(
  flowId: number
): Promise<'empty' | 'rehydrated' | 'active'> {
  const store = getPearlChatStore(flowId);
  if (store.getState().hasActiveGenerationStream()) return 'active';

  const thread = await fetchBuildThread('flow', flowId);
  const transcript = thread.transcript ?? [];
  if (transcript.length === 0) return 'empty';

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
  store.getState().setGenerationCompleted(true);
  return 'rehydrated';
}

export interface GenerateCodeParams {
  prompt: string;
  flowId?: number;
  enabled?: boolean;
}

/**
 * Hook to initiate the initial flow build for a flow that has a stored
 * prompt but no code yet. Rehydrates the stored harness thread first; only
 * an empty thread triggers the auto-send (so a refresh never re-sends).
 */
export const useGenerateInitialFlow = (
  params: GenerateCodeParams & {
    onGenerationComplete?: HandleStreamingEventOptions['onGenerationComplete'];
  }
) => {
  return useQuery({
    queryKey: ['generate-code', params.prompt, params.flowId],
    enabled: params.enabled,
    queryFn: async (): Promise<boolean> => {
      const { flowId } = params;
      if (!flowId) return false;

      const store = getPearlChatStore(flowId);
      const state = store.getState();
      if (state.hasActiveGenerationStream() || state.generationCompleted) {
        return state.generationCompleted;
      }
      if (params.onGenerationComplete) {
        state.setOnGenerationComplete(params.onGenerationComplete);
      }

      const disposition = await rehydrateFromThread(flowId);
      if (disposition === 'empty') {
        sendBuildMessage(flowId, params.prompt, {
          initialGeneration: true,
        }).catch((err) => {
          console.error('[useGenerateInitialFlow] Stream error:', err);
        });
      }

      return store.getState().generationCompleted;
    },
    refetchInterval: () => {
      const flowId = params.flowId;
      if (!flowId) return false;
      const store = getPearlChatStore(flowId);
      if (store.getState().hasActiveGenerationStream()) {
        return 100;
      }
      return false;
    },
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
};

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
