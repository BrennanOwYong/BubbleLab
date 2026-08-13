/**
 * Root route: pure redirect to /home. Forwards prompt/ref through unchanged
 * — this is still an external arrival point (someone linking at the bare
 * domain) — /home is what actually reads and strips them.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

interface IndexRouteSearch {
  prompt?: string;
  ref?: string;
}

export const Route = createFileRoute('/')({
  component: IndexRoute,
  validateSearch: (search: Record<string, unknown>): IndexRouteSearch => {
    return {
      prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
      ref: typeof search.ref === 'string' ? search.ref : undefined,
    };
  },
});

function IndexRoute() {
  const navigate = useNavigate();
  const { prompt, ref } = Route.useSearch();

  useEffect(() => {
    navigate({
      to: '/home',
      search: { prompt, ref },
      replace: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
