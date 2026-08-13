import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { CredentialsPage } from '@/pages/CredentialsPage';
import { useAuth } from '@/hooks/useAuth';
import { useUIStore } from '@/stores/uiStore';
import { API_BASE_URL } from '@/env';

export const Route = createFileRoute('/credentials')({
  component: CredentialsRoute,
});

function CredentialsRoute() {
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();

  // Redirect if not signed in
  if (!isSignedIn) {
    // Flag /home to auto-open the sign-in modal (in-memory, not a URL param)
    useUIStore.getState().requestShowSignIn();
    navigate({ to: '/home', replace: true });
    return null;
  }

  return (
    <div className="h-screen flex flex-col bg-[#1a1a1a] text-gray-100">
      <div className="flex-1 min-h-0">
        <CredentialsPage apiBaseUrl={API_BASE_URL} />
      </div>
    </div>
  );
}
