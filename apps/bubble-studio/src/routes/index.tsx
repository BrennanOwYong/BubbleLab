import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

interface IndexRouteSearch {
  ref?: string;
}

export const Route = createFileRoute('/')({
  component: IndexRoute,
  validateSearch: (search: Record<string, unknown>): IndexRouteSearch => {
    return {
      ref: typeof search.ref === 'string' ? search.ref : undefined,
    };
  },
});

function IndexRoute() {
  const navigate = useNavigate();
  const { ref } = Route.useSearch();

  useEffect(() => {
    navigate({
      to: '/home',
      search: { ref },
      replace: true,
    });
  }, [navigate, ref]);

  return null;
}
