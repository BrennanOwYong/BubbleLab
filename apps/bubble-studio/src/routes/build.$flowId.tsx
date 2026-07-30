import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@/hooks/useAuth';
import { BuildChatPage } from '@/pages/BuildChatPage';

interface BuildFlowSearch {
  /** Prompt carried from the create-flow box; auto-sent as the first agent message. */
  prompt?: string;
}

export const Route = createFileRoute('/build/$flowId')({
  component: BuildRoute,
  validateSearch: (search: Record<string, unknown>): BuildFlowSearch => {
    return {
      prompt:
        typeof search.prompt === 'string' && search.prompt.trim() !== ''
          ? search.prompt
          : undefined,
    };
  },
});

function BuildRoute() {
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const { flowId } = Route.useParams();
  const { prompt } = Route.useSearch();
  const parsedFlowId = parseInt(flowId, 10);

  if (!isSignedIn) {
    navigate({ to: '/home', replace: true });
    return null;
  }
  if (isNaN(parsedFlowId)) {
    navigate({ to: '/flows', replace: true });
    return null;
  }

  return (
    <div className="h-screen flex flex-col bg-[#1a1a1a] text-gray-100">
      <BuildChatPage
        subjectId={parsedFlowId}
        kind="flow"
        initialMessage={prompt}
        onInitialMessageSent={() =>
          // Strip the prompt from the URL so a refresh does not re-send it.
          navigate({
            to: '/build/$flowId',
            params: { flowId },
            search: {},
            replace: true,
          })
        }
      />
    </div>
  );
}
