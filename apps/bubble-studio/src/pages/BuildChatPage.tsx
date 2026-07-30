/**
 * Phase-4 builder chat panel (rough vertical slice), shared by both agent
 * kinds: 'flow' (/build/:flowId) and 'page' (/build-page/:pageId).
 *
 * The user messages the embedded builder agent; the agent's streamed thread
 * renders live (text deltas + tool-call labels). Opening an in-progress build
 * rehydrates the stored transcript from GET .../thread and further messages
 * continue the same session (the sidecar resumes it).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  fetchBuildThread,
  streamBuildMessage,
  type BuilderKind,
  type BuildTranscriptItem,
} from '../services/buildAgentApi';

interface ChatItem {
  role: 'user' | 'assistant';
  text: string;
  toolCalls: string[];
}

function transcriptToChat(transcript: BuildTranscriptItem[]): ChatItem[] {
  const items: ChatItem[] = [];
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
      .map((block) => (block.name as string).replace('mcp__builder__', ''));
    if (text.trim() === '' && toolCalls.length === 0) continue;
    items.push({ role: entry.role, text, toolCalls });
  }
  return items;
}

export function BuildChatPage({
  subjectId,
  kind = 'flow',
  initialMessage,
  onInitialMessageSent,
}: {
  subjectId: number;
  kind?: BuilderKind;
  /** Auto-sent as the first message once the (empty) thread has loaded. */
  initialMessage?: string;
  /** Called when the initial message is consumed, so the caller can clear it. */
  onInitialMessageSent?: () => void;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [liveText, setLiveText] = useState('');
  const [liveTools, setLiveTools] = useState<string[]>([]);
  const [status, setStatus] = useState<string>('loading');
  const [threadLoaded, setThreadLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, liveText, liveTools]);

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
      let pendingTools: string[] = [];
      const flushAssistant = () => {
        if (pendingText.trim() !== '' || pendingTools.length > 0) {
          const text = pendingText;
          const toolCalls = pendingTools;
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
                  block.name.replace('mcp__builder__', ''),
                ];
                setLiveTools(pendingTools);
              }
            }
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
      }
    },
    [busy, kind, subjectId]
  );

  const send = useCallback(() => {
    const message = input.trim();
    if (message === '') return;
    setInput('');
    void sendMessage(message);
  }, [input, sendMessage]);

  // Auto-send the initial prompt (from the create-flow box) once the thread
  // has loaded and only when the conversation is still empty.
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

  return (
    <div className="h-full flex flex-col max-w-3xl mx-auto w-full">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h1 className="text-sm font-semibold text-gray-200">
          {kind === 'page' ? 'Build page' : 'Build flow'} #{subjectId}
        </h1>
        <div className="flex items-center gap-3">
          {kind === 'page' && (
            <Link
              to="/page/$pageId"
              params={{ pageId: String(subjectId) }}
              className="text-xs text-purple-400 hover:text-purple-300 underline"
            >
              View page
            </Link>
          )}
          <span className="text-xs text-gray-500">
            {busy ? 'building…' : status}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {items.map((item, index) => (
          <div
            key={index}
            className={
              item.role === 'user'
                ? 'ml-auto max-w-[80%] bg-purple-900/40 rounded-lg px-3 py-2'
                : 'mr-auto max-w-[85%] bg-gray-800/70 rounded-lg px-3 py-2'
            }
          >
            {item.toolCalls.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1">
                {item.toolCalls.map((name, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 font-mono"
                  >
                    {name}
                  </span>
                ))}
              </div>
            )}
            {item.text.trim() !== '' && (
              <p className="text-sm text-gray-200 whitespace-pre-wrap">
                {item.text}
              </p>
            )}
          </div>
        ))}

        {(liveText !== '' || liveTools.length > 0) && (
          <div className="mr-auto max-w-[85%] bg-gray-800/40 rounded-lg px-3 py-2 border border-gray-700/50">
            {liveTools.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1">
                {liveTools.map((name, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 font-mono"
                  >
                    {name}
                  </span>
                ))}
              </div>
            )}
            <p className="text-sm text-gray-300 whitespace-pre-wrap">
              {liveText}
              <span className="animate-pulse">▍</span>
            </p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="p-3 border-t border-gray-800 flex gap-2">
        <textarea
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 resize-none focus:outline-none focus:border-purple-500"
          rows={2}
          placeholder={
            kind === 'page'
              ? 'Describe the page or dashboard you want built…'
              : 'Describe the flow you want built…'
          }
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 rounded-lg text-sm text-white"
          disabled={busy || input.trim() === ''}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
