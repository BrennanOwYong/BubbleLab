/**
 * /build — start a new agent build: creates an empty flow, then opens its
 * build chat at /build/$flowId (rough Phase-4 slice).
 */
import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';

export const Route = createFileRoute('/build/')({
  component: BuildIndexRoute,
});

function BuildIndexRoute() {
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  if (!isSignedIn) {
    navigate({ to: '/home', replace: true });
    return null;
  }

  const start = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const created = await api.post<{ id: number }>('/bubble-flow/empty', {
        name: name.trim() === '' ? 'Agent build' : name.trim(),
        eventType: 'webhook/http',
        prompt: 'Agent build (Phase-4 builder chat)',
      });
      navigate({
        to: '/build/$flowId',
        params: { flowId: String(created.id) },
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-[#1a1a1a] text-gray-100">
      <div className="w-full max-w-md space-y-3 px-6">
        <h1 className="text-lg font-semibold">Start an agent build</h1>
        <input
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
          placeholder="Flow name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="w-full px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 rounded-lg text-sm text-white"
          disabled={creating}
          onClick={() => void start()}
        >
          {creating ? 'Creating…' : 'Create flow and open chat'}
        </button>
      </div>
    </div>
  );
}
