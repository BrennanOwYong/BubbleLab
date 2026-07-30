import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { SignInModal } from '@/components/SignInModal';
import { useAffiliateTracking } from '@/hooks/useAffiliateTracking';

interface HomeRouteSearch {
  showSignIn?: boolean;
  ref?: string;
}

export const Route = createFileRoute('/home')({
  component: LandingPage,
  validateSearch: (search: Record<string, unknown>): HomeRouteSearch => {
    return {
      showSignIn: search.showSignIn === true || search.showSignIn === 'true',
      ref: typeof search.ref === 'string' ? search.ref : undefined,
    };
  },
});

/**
 * Auth landing page. Signed-in users go straight to /flows (flow list +
 * create-a-flow prompt box); signed-out users get the sign-in modal.
 */
function LandingPage() {
  const { ref } = Route.useSearch();
  const { isSignedIn } = useAuth();
  const navigate = useNavigate();

  // Handle affiliate referral tracking
  useAffiliateTracking({ ref });

  useEffect(() => {
    if (isSignedIn) {
      navigate({ to: '/flows', replace: true });
    }
  }, [isSignedIn, navigate]);

  if (isSignedIn) {
    return null;
  }

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0a] text-gray-100 font-sans relative overflow-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-purple-900/10 rounded-[100%] blur-[100px] pointer-events-none" />
      <div className="flex-1 flex items-center justify-center relative z-10">
        <div className="text-center px-4">
          <h1 className="text-4xl md:text-5xl font-bold text-white tracking-tight pb-2">
            Your automations, ready to run
          </h1>
          <p className="text-gray-400 mt-2 text-sm">
            Sign in to view and run your flows
          </p>
        </div>
      </div>
      <SignInModal isVisible={true} onClose={() => {}} />
    </div>
  );
}
