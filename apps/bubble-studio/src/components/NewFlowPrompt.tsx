/**
 * Big create-a-flow prompt box. The user describes the automation they want;
 * submit creates an empty flow (POST /bubble-flow/empty) and opens its
 * builder chat at /build/$flowId with the prompt carried in the search
 * params, where BuildChatPage auto-sends it as the first agent message.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUp } from 'lucide-react';
import { api } from '../lib/api';

const PROMPT_PLACEHOLDER =
  'Describe the automation you want built, e.g. "Every morning, read the new rows in my leads sheet and send me a Slack summary."';

function deriveFlowName(prompt: string): string {
  return prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
}

export function NewFlowPrompt({ autoFocus = false }: { autoFocus?: boolean }) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = prompt.trim();
    if (trimmed === '' || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.post<{ id: number }>('/bubble-flow/empty', {
        name: deriveFlowName(trimmed),
        eventType: 'webhook/http',
        prompt: trimmed,
      });
      navigate({
        to: '/build/$flowId',
        params: { flowId: String(created.id) },
        search: { prompt: trimmed },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-[#1a1a1a] p-4 focus-within:border-purple-500/50 transition-colors">
      <textarea
        className="w-full bg-transparent text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none"
        rows={4}
        autoFocus={autoFocus}
        placeholder={PROMPT_PLACEHOLDER}
        value={prompt}
        disabled={creating}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-red-400">{error ?? ''}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 rounded-lg text-sm text-white transition-colors"
          disabled={creating || prompt.trim() === ''}
          onClick={() => void submit()}
        >
          {creating ? (
            'Creating…'
          ) : (
            <>
              Build flow
              <ArrowUp className="w-3.5 h-3.5" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
