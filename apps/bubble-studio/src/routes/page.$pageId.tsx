import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@/hooks/useAuth';
import { PageView } from '@/pages/PageView';

export const Route = createFileRoute('/page/$pageId')({
  component: PageViewRoute,
});

function PageViewRoute() {
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
    <div className="h-screen overflow-y-auto bg-[#1a1a1a] text-gray-100">
      <PageView pageId={parsedPageId} />
    </div>
  );
}
