/**
 * Flow-page conversation panel: the in-IDE chat with the Claude builder
 * harness (the Phase-4 sidecar), presented in the pre-pivot PearlChat slot
 * and styling. Text streams as markdown; each tool call renders as a status
 * card (running -> completed/failed) so the research -> provision ->
 * validate -> save progression is visible while the canvas updates.
 *
 * Data layer is useBuildChat over the /build/:flowId message/thread proxy;
 * the studio never talks to the sidecar directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import {
  AlertCircle,
  ArrowUp,
  Check,
  Loader2,
  MessageSquare,
  Sparkles,
} from 'lucide-react';
import AutoResizeTextarea from '../AutoResizeTextarea';
import { sharedMarkdownComponents } from '../shared/MarkdownComponents';
import { useBuildChat, type ToolCallChip } from '../../hooks/useBuildChat';

function ToolCallCard({ chip }: { chip: ToolCallChip }) {
  if (chip.status === 'running') {
    return (
      <div className="p-2 bg-blue-900/20 border border-blue-800/30 rounded-lg">
        <div className="flex items-center gap-2">
          <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
          <span className="text-xs text-blue-300">Calling {chip.name}...</span>
        </div>
      </div>
    );
  }
  if (chip.status === 'error') {
    return (
      <div className="p-2 bg-red-900/20 border border-red-800/30 rounded-lg">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-3 h-3 text-red-400" />
          <span className="text-xs text-red-300">{chip.name} failed</span>
        </div>
      </div>
    );
  }
  return (
    <div className="p-2 bg-green-900/20 border border-green-800/30 rounded-lg">
      <div className="flex items-center gap-2">
        <Check className="w-3 h-3 text-green-400" />
        <span className="text-xs text-green-300">{chip.name} completed</span>
      </div>
    </div>
  );
}

function AssistantTurn({
  text,
  toolCalls,
  streaming = false,
}: {
  text: string;
  toolCalls: ToolCallChip[];
  streaming?: boolean;
}) {
  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-2">
        <MessageSquare className="w-4 h-4 text-white" />
        <span className="text-xs font-medium text-gray-400">Gluu</span>
      </div>
      {toolCalls.length > 0 && (
        <div className="space-y-1 mb-2">
          {toolCalls.map((chip, index) => (
            <ToolCallCard key={index} chip={chip} />
          ))}
        </div>
      )}
      {text.trim() !== '' && (
        <div className="prose prose-invert prose-sm max-w-none [&_*]:text-[13px]">
          <ReactMarkdown components={sharedMarkdownComponents}>
            {text}
          </ReactMarkdown>
        </div>
      )}
      {streaming && <span className="text-gray-300 animate-pulse">▍</span>}
    </div>
  );
}

export function BuilderChat({
  flowId,
  initialPrompt,
  onInitialPromptSent,
}: {
  flowId: number;
  /** Auto-sent as the first message once the (empty) thread has loaded. */
  initialPrompt?: string;
  /** Called when the initial prompt is consumed, so the caller can clear it. */
  onInitialPromptSent?: () => void;
}) {
  const queryClient = useQueryClient();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');

  // The agent saves code / provisions resources mid-turn; refresh the flow
  // queries so the canvas reflects the built flow as it lands.
  const onAgentActivity = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['bubbleFlow', flowId] });
    void queryClient.invalidateQueries({ queryKey: ['bubbleFlowList'] });
  }, [queryClient, flowId]);

  const { items, liveText, liveTools, busy, sendMessage } = useBuildChat({
    kind: 'flow',
    subjectId: flowId,
    initialMessage: initialPrompt,
    onInitialMessageSent: onInitialPromptSent,
    onAgentActivity,
  });

  // Auto-scroll to bottom when the conversation changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, liveText, liveTools, busy]);

  const send = () => {
    const message = input.trim();
    if (message === '' || busy) return;
    setInput('');
    void sendMessage(message);
  };

  return (
    <div className="h-full flex flex-col bg-[#1a1a1a]">
      {/* Scrollable content area for messages/results */}
      <div className="flex-1 overflow-y-auto thin-scrollbar p-4 space-y-3 min-h-0">
        {items.length === 0 && !busy && (
          <div className="flex flex-col items-center px-4 py-8">
            <div className="mb-6 text-center">
              <Sparkles className="w-8 h-8 mx-auto mb-3 text-gray-500" />
              <h3 className="text-base font-medium text-gray-200 mb-1">
                Chat with Gluu
              </h3>
              <p className="text-xs text-gray-500">
                Describe the automation you want; the builder agent researches,
                sets things up, and builds the flow here.
              </p>
            </div>
          </div>
        )}

        {items.map((item, index) =>
          item.role === 'user' ? (
            <div key={index} className="p-3 flex justify-end">
              <div className="bg-gray-100 rounded-lg px-3 py-2 max-w-[80%]">
                <div className="text-[13px] text-gray-900 whitespace-pre-wrap">
                  {item.text}
                </div>
              </div>
            </div>
          ) : (
            <AssistantTurn
              key={index}
              text={item.text}
              toolCalls={item.toolCalls}
            />
          )
        )}

        {/* Live streaming turn */}
        {(liveText !== '' || liveTools.length > 0) && (
          <AssistantTurn text={liveText} toolCalls={liveTools} streaming />
        )}

        {/* Loading indicator when actively processing but nothing streamed yet */}
        {busy && liveText === '' && liveTools.length === 0 && (
          <div className="p-1">
            <div className="text-sm text-gray-400 p-2 bg-gray-800/30 rounded border-l-2 border-gray-600">
              <div className="flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Thinking...</span>
              </div>
            </div>
          </div>
        )}

        {/* Scroll anchor */}
        <div ref={messagesEndRef} />
      </div>

      {/* Compact chat input at bottom */}
      <div className="flex-shrink-0 p-4 pt-2">
        <div className="bg-[#252525] border border-gray-700 rounded-xl p-3 shadow-lg relative">
          <AutoResizeTextarea
            value={input}
            placeholder="Ask Gluu to build, modify, or debug your workflow..."
            className="bg-transparent text-gray-100 text-sm w-full placeholder-gray-400 resize-none focus:outline-none focus:ring-0 p-0"
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />

          {/* Bottom action bar - send button on the right */}
          <div className="flex items-center justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={send}
              disabled={input.trim() === '' || busy}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 ${
                input.trim() === '' || busy
                  ? 'bg-gray-700/40 border border-gray-700/60 cursor-not-allowed text-gray-500'
                  : 'bg-white text-gray-900 border border-white/80 hover:bg-gray-100 hover:border-gray-300 shadow-lg hover:scale-105'
              }`}
            >
              {busy ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <ArrowUp className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
