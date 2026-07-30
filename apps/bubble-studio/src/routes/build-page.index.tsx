/**
 * /build-page — start a new page build: creates an empty page row, then opens
 * its build chat at /build-page/$pageId (page-builder MVP).
 */
import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@/hooks/useAuth';
import { createPage } from '@/services/pageApi';

export const Route = createFileRoute('/build-page/')({
  component: BuildPageIndexRoute,
});

function BuildPageIndexRoute() {
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');

  if (!isSignedIn) {
    navigate({ to: '/home', replace: true });
    return null;
  }

  const start = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const created = await createPage(
        title.trim() === '' ? undefined : title.trim()
      );
      navigate({
        to: '/build-page/$pageId',
        params: { pageId: String(created.id) },
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-[#1a1a1a] text-gray-100">
      <div className="w-full max-w-md space-y-3 px-6">
        <h1 className="text-lg font-semibold">Build a page</h1>
        <p className="text-sm text-gray-400">
          Describe a dashboard over your connected integrations; the agent
          designs it and wires the data.
        </p>
        <input
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
          placeholder="Page title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button
          className="w-full px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 rounded-lg text-sm text-white"
          disabled={creating}
          onClick={() => void start()}
        >
          {creating ? 'Creating…' : 'Create page and open chat'}
        </button>
      </div>
    </div>
  );
}
