/**
 * Standalone builder chat page, used by the page-builder routes
 * (/build-page/:pageId). Flow builds converse inside the flow editor's
 * conversation panel (PearlChat, harness-backed) instead.
 *
 * The user messages the embedded builder agent; the agent's streamed thread
 * renders live (text deltas + tool-call chips). Opening an in-progress build
 * rehydrates the stored transcript from GET .../thread and further messages
 * continue the same session (the sidecar resumes it).
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { BuilderKind } from '../services/buildAgentApi';
import { useBuildChat, type ToolCallChip } from '../hooks/useBuildChat';

function chipClass(chip: ToolCallChip): string {
  switch (chip.status) {
    case 'running':
      return 'bg-blue-900/50 text-blue-300 animate-pulse';
    case 'error':
      return 'bg-red-900/50 text-red-300';
    default:
      return 'bg-blue-900/50 text-blue-300';
  }
}

export function BuildChatPage({
  subjectId,
  kind,
}: {
  subjectId: number;
  kind: BuilderKind;
}) {
  const { items, liveText, liveTools, status, busy, sendMessage } =
    useBuildChat({ kind, subjectId });
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, liveText, liveTools]);

  const send = () => {
    const message = input.trim();
    if (message === '' || busy) return;
    setInput('');
    void sendMessage(message);
  };

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
                {item.toolCalls.map((chip, i) => (
                  <span
                    key={i}
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${chipClass(chip)}`}
                  >
                    {chip.name}
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
                {liveTools.map((chip, i) => (
                  <span
                    key={i}
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${chipClass(chip)}`}
                  >
                    {chip.name}
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
              send();
            }
          }}
        />
        <button
          className="px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 rounded-lg text-sm text-white"
          disabled={busy || input.trim() === ''}
          onClick={send}
        >
          Send
        </button>
      </div>
    </div>
  );
}
