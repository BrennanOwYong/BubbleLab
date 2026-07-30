import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@/hooks/useAuth';
import { FlowIDEView } from '@/components/FlowIDEView';

interface FlowSearch {
  /**
   * Prompt carried from the create-flow box; the flow page opens its
   * conversation panel and auto-sends it as the first builder-agent message.
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

  return (
    <FlowIDEView
      flowId={parsedFlowId}
      initialBuildPrompt={prompt}
      onInitialBuildPromptSent={() =>
        // Strip the prompt from the URL so a refresh does not re-send it.
        navigate({
          to: '/flow/$flowId',
          params: { flowId },
          search: {},
          replace: true,
        })
      }
    />
  );
}
