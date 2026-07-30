/**
 * Home route: the restored DashboardPage (big "What do you want to automate?"
 * prompt). Submit creates an empty flow on the server (POST /bubble-flow/empty
 * via useCreateBubbleFlow so the flow list cache updates immediately), then
 * opens /flow/:id where the conversation panel auto-sends the stored prompt
 * to the builder harness.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'react-toastify';
import { DashboardPage } from '@/pages/DashboardPage';
import { useAuth } from '@/hooks/useAuth';
import { useCreateBubbleFlow } from '@/hooks/useCreateBubbleFlow';
import { useAffiliateTracking } from '@/hooks/useAffiliateTracking';

interface HomeRouteSearch {
  showSignIn?: boolean;
  prompt?: string;
  ref?: string;
}

export const Route = createFileRoute('/home')({
  component: NewFlowPage,
  validateSearch: (search: Record<string, unknown>): HomeRouteSearch => {
    return {
      showSignIn: search.showSignIn === true || search.showSignIn === 'true',
      prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
      ref: typeof search.ref === 'string' ? search.ref : undefined,
    };
  },
});

function deriveFlowName(prompt: string): string {
  return prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
}

function NewFlowPage() {
  const { showSignIn, prompt: urlPrompt, ref } = Route.useSearch();
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const createEmptyFlowMutation = useCreateBubbleFlow({ isEmpty: true });
  const [generationPrompt, setGenerationPrompt] = useState(urlPrompt ?? '');
  const [isCreating, setIsCreating] = useState(false);

  // Handle affiliate referral tracking
  useAffiliateTracking({ ref });

  const generateCode = async () => {
    const trimmed = generationPrompt.trim();
    if (trimmed === '' || isCreating) return;
    setIsCreating(true);
    try {
      const created = await createEmptyFlowMutation.mutateAsync({
        name: deriveFlowName(trimmed),
        eventType: 'webhook/http',
        prompt: trimmed,
      });
      navigate({
        to: '/flow/$flowId',
        params: { flowId: String(created.id) },
        search: { prompt: trimmed },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create flow';
      toast.error(`Failed to create flow: ${message}`);
      setIsCreating(false);
    }
  };

  return (
    <DashboardPage
      isStreaming={isCreating}
      generationPrompt={generationPrompt}
      setGenerationPrompt={setGenerationPrompt}
      onGenerateCode={() => void generateCode()}
      autoShowSignIn={showSignIn || (!!urlPrompt && !isSignedIn)}
    />
  );
}
