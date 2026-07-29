import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@/hooks/useAuth';
import { BuildChatPage } from '@/pages/BuildChatPage';

export const Route = createFileRoute('/build/$flowId')({
  component: BuildRoute,
});

function BuildRoute() {
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const { flowId } = Route.useParams();
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
      <BuildChatPage flowId={parsedFlowId} />
    </div>
  );
}
