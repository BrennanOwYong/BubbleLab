import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { FlowIDEView } from '@/components/FlowIDEView';

interface FlowSearch {
  /**
   * Prompt carried from the create-flow box. The flow page itself reads the
   * prompt persisted on the flow record (the conversation panel auto-sends
   * it on first load), so the search param is display-only and stripped
   * immediately to keep the URL clean.
   */
  prompt?: string;
}

export const Route = createFileRoute('/flow/$flowId')({
  component: FlowRoute,
  validateSearch: (search: Record<string, unknown>): FlowSearch => {
    return {
      prompt:
        typeof search.prompt === 'string' && search.prompt.trim() !== ''
          ? search.prompt
          : undefined,
    };
  },
});

function FlowRoute() {
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const { flowId } = Route.useParams();
  const { prompt } = Route.useSearch();
  const parsedFlowId = parseInt(flowId, 10);

  // Strip the carried prompt from the URL; the flow record holds it.
  useEffect(() => {
    if (prompt) {
      navigate({
        to: '/flow/$flowId',
        params: { flowId },
        search: {},
        replace: true,
      });
    }
  }, [prompt, flowId, navigate]);

  // Redirect if not signed in
  if (!isSignedIn) {
    navigate({ to: '/home', replace: true });
    return null;
  }

  // Validate flowId is a number
  if (isNaN(parsedFlowId)) {
    navigate({ to: '/flows', replace: true });
    return null;
  }

  return <FlowIDEView flowId={parsedFlowId} />;
}
