/**
 * Shared chat state machine for the Claude builder harness (both agent
 * kinds). Rehydrates the stored transcript from GET .../thread, streams new
 * turns through POST .../message, and tracks per-tool-call progress so the
 * UI can render tool chips (running -> completed/failed).
 *
 * Consumed by BuilderChat (flow-page conversation panel) and BuildChatPage
 * (page builder).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchBuildThread,
  streamBuildMessage,
  type BuilderKind,
  type BuildTranscriptItem,
} from '../services/buildAgentApi';

export type ToolCallStatus = 'running' | 'done' | 'error';

export interface ToolCallChip {
  name: string;
  status: ToolCallStatus;
}

export interface BuildChatItem {
  role: 'user' | 'assistant';
  text: string;
  toolCalls: ToolCallChip[];
}

function transcriptToChat(transcript: BuildTranscriptItem[]): BuildChatItem[] {
  const items: BuildChatItem[] = [];
  for (const entry of transcript) {
    const text = entry.blocks
      .filter(
        (block) => block.type === 'text' && typeof block.text === 'string'
      )
      .map((block) => block.text as string)
      .join('\n');
    const toolCalls = entry.blocks
      .filter(
        (block) => block.type === 'tool_use' && typeof block.name === 'string'
      )
      .map(
        (block): ToolCallChip => ({
          // Historical tool calls all finished by the time the transcript
          // was stored.
          name: (block.name as string).replace('mcp__builder__', ''),
          status: 'done',
        })
      );
    if (text.trim() === '' && toolCalls.length === 0) continue;
    items.push({ role: entry.role, text, toolCalls });
  }
  return items;
}

export interface UseBuildChatOptions {
  kind: BuilderKind;
  subjectId: number;
  /** Auto-sent as the first message once the (empty) thread has loaded. */
  initialMessage?: string;
  /** Called when the initial message is consumed, so the caller can clear it. */
  onInitialMessageSent?: () => void;
  /**
   * Called after each completed tool call and at end of turn: the agent may
   * have saved code / provisioned resources, so callers refresh flow queries
   * here to keep the canvas current.
   */
  onAgentActivity?: () => void;
}

export function useBuildChat({
  kind,
  subjectId,
  initialMessage,
  onInitialMessageSent,
  onAgentActivity,
}: UseBuildChatOptions) {
  const [items, setItems] = useState<BuildChatItem[]>([]);
  const [liveText, setLiveText] = useState('');
  const [liveTools, setLiveTools] = useState<ToolCallChip[]>([]);
  const [status, setStatus] = useState<string>('loading');
  const [threadLoaded, setThreadLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const initialSentRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchBuildThread(kind, subjectId)
      .then((thread) => {
        if (cancelled) return;
        setItems(transcriptToChat(thread.transcript));
        setStatus(thread.status);
        setThreadLoaded(true);
      })
      .catch(() => {
        setStatus('none');
        setThreadLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, subjectId]);

  const sendMessage = useCallback(
    async (message: string) => {
      if (message === '' || busy) return;
      setBusy(true);
      setItems((prev) => [
        ...prev,
        { role: 'user', text: message, toolCalls: [] },
      ]);
      setLiveText('');
      setLiveTools([]);

      let pendingText = '';
      let pendingTools: ToolCallChip[] = [];
      const flushAssistant = () => {
        if (pendingText.trim() !== '' || pendingTools.length > 0) {
          const text = pendingText;
          // A flushed turn is over; anything still marked running finished
          // without a surfaced result frame.
          const toolCalls = pendingTools.map(
            (chip): ToolCallChip =>
              chip.status === 'running' ? { ...chip, status: 'done' } : chip
          );
          setItems((prev) => [...prev, { role: 'assistant', text, toolCalls }]);
        }
        pendingText = '';
        pendingTools = [];
        setLiveText('');
        setLiveTools([]);
      };

      try {
        await streamBuildMessage(kind, subjectId, message, (frame) => {
          if (frame.event === 'stream_event') {
            const ev = frame.data as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (
              ev.type === 'content_block_delta' &&
              ev.delta?.type === 'text_delta' &&
              typeof ev.delta.text === 'string'
            ) {
              pendingText += ev.delta.text;
              setLiveText(pendingText);
            }
          } else if (frame.event === 'assistant') {
            const data = frame.data as {
              blocks?: Array<{ type: string; text?: string; name?: string }>;
            };
            for (const block of data.blocks ?? []) {
              if (block.type === 'tool_use' && typeof block.name === 'string') {
                pendingTools = [
                  ...pendingTools,
                  {
                    name: block.name.replace('mcp__builder__', ''),
                    status: 'running',
                  },
                ];
                setLiveTools(pendingTools);
              }
            }
          } else if (frame.event === 'tool_result') {
            // Results arrive in call order; the assistant frames carry no
            // tool_use ids, so each result closes the oldest running chip.
            const data = frame.data as {
              results?: Array<{ is_error?: boolean }>;
            };
            for (const result of data.results ?? []) {
              const index = pendingTools.findIndex(
                (chip) => chip.status === 'running'
              );
              if (index === -1) break;
              pendingTools = pendingTools.map((chip, i) =>
                i === index
                  ? { ...chip, status: result.is_error ? 'error' : 'done' }
                  : chip
              );
            }
            setLiveTools(pendingTools);
            // The tool may have saved code or provisioned resources.
            onAgentActivity?.();
          } else if (frame.event === 'result') {
            flushAssistant();
          } else if (frame.event === 'done') {
            const data = frame.data as { status?: string };
            if (typeof data.status === 'string') setStatus(data.status);
          } else if (frame.event === 'error') {
            const data = frame.data as { message?: string };
            setItems((prev) => [
              ...prev,
              {
                role: 'assistant',
                text: `Build error: ${data.message ?? 'unknown'}`,
                toolCalls: [],
              },
            ]);
          }
        });
        flushAssistant();
      } catch (error) {
        setItems((prev) => [
          ...prev,
          {
            role: 'assistant',
            text: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
            toolCalls: [],
          },
        ]);
      } finally {
        setBusy(false);
        onAgentActivity?.();
      }
    },
    [busy, kind, subjectId, onAgentActivity]
  );

  // Auto-send the initial prompt (from the create-flow box) once the thread
  // has loaded and only when the conversation is still empty. The ref guards
  // StrictMode's double-fired effects.
  useEffect(() => {
    if (initialSentRef.current) return;
    if (!initialMessage || !threadLoaded || busy) return;
    if (items.length > 0) return;
    initialSentRef.current = true;
    onInitialMessageSent?.();
    void sendMessage(initialMessage);
  }, [
    initialMessage,
    threadLoaded,
    busy,
    items.length,
    sendMessage,
    onInitialMessageSent,
  ]);

  return {
    items,
    liveText,
    liveTools,
    status,
    threadLoaded,
    busy,
    sendMessage,
  };
}
