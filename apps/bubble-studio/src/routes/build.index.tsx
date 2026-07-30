/**
 * /build — start a new agent build: describe the flow in the big prompt box,
 * submit creates an empty flow and opens its build chat at /build/$flowId
 * with the prompt auto-sent to the builder agent.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@/hooks/useAuth';
import { NewFlowPrompt } from '@/components/NewFlowPrompt';

export const Route = createFileRoute('/build/')({
  component: BuildIndexRoute,
});

function BuildIndexRoute() {
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();

  if (!isSignedIn) {
    navigate({ to: '/home', replace: true });
    return null;
  }

  return (
    <div className="h-screen flex items-center justify-center bg-[#1a1a1a] text-gray-100">
      <div className="w-full max-w-2xl px-6 space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">
            What do you want to automate?
          </h1>
          <p className="text-gray-400 mt-1 text-sm">
            The builder agent researches, sets up, and builds the flow for you
          </p>
        </div>
        <NewFlowPrompt autoFocus />
      </div>
    </div>
  );
}
