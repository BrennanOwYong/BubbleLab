import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@/hooks/useAuth';
import { BuildChatPage } from '@/pages/BuildChatPage';

export const Route = createFileRoute('/build-page/$pageId')({
  component: BuildPageRoute,
});

function BuildPageRoute() {
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const { pageId } = Route.useParams();
  const parsedPageId = parseInt(pageId, 10);

  if (!isSignedIn) {
    navigate({ to: '/home', replace: true });
    return null;
  }
  if (isNaN(parsedPageId)) {
    navigate({ to: '/build-page', replace: true });
    return null;
  }

  return (
    <div className="h-screen flex flex-col bg-[#1a1a1a] text-gray-100">
      <BuildChatPage subjectId={parsedPageId} kind="page" />
    </div>
  );
}
