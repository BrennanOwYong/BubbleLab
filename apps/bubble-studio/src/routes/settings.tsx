import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { SettingsPage } from '@/pages/SettingsPage';
import { useAuth } from '@/hooks/useAuth';
import { useUIStore } from '@/stores/uiStore';

export const Route = createFileRoute('/settings')({
  component: SettingsRoute,
});

function SettingsRoute() {
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
        <SettingsPage />
      </div>
    </div>
  );
}
