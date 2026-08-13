/**
 * Home route: the restored DashboardPage (big "What do you want to automate?"
 * prompt). Submit creates an empty flow on the server (POST /bubble-flow/empty
 * via useCreateBubbleFlow so the flow list cache updates immediately), then
 * opens /flow/:id where the conversation panel auto-sends the stored prompt
 * to the builder harness.
 *
 * URL params here exist ONLY as an external arrival channel (a marketing
 * link, an affiliate link) — read exactly once into real app state
 * (component state / localStorage / uiStore), then stripped from the URL
 * immediately so nothing downstream ever depends on them being there.
 * Internal navigation (the auth-guard redirects) never uses a URL param at
 * all — they flag uiStore's pendingShowSignIn directly.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { DashboardPage } from '@/pages/DashboardPage';
import { useCreateBubbleFlow } from '@/hooks/useCreateBubbleFlow';
import { useAffiliateTracking } from '@/hooks/useAffiliateTracking';
import { useUIStore } from '@/stores/uiStore';

interface HomeRouteSearch {
  prompt?: string;
  ref?: string;
}

export const Route = createFileRoute('/home')({
  component: NewFlowPage,
  validateSearch: (search: Record<string, unknown>): HomeRouteSearch => {
    return {
      prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
      ref: typeof search.ref === 'string' ? search.ref : undefined,
    };
  },
});

function deriveFlowName(prompt: string): string {
  return prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
}

function NewFlowPage() {
  const { prompt: urlPrompt, ref } = Route.useSearch();
  const navigate = useNavigate();
  const createEmptyFlowMutation = useCreateBubbleFlow({ isEmpty: true });
  const [generationPrompt, setGenerationPrompt] = useState(urlPrompt ?? '');
  const [isCreating, setIsCreating] = useState(false);
  const pendingShowSignIn = useUIStore((s) => s.pendingShowSignIn);
  const consumeShowSignIn = useUIStore((s) => s.consumeShowSignIn);

  // Capture affiliate attribution into localStorage (first-touch), then the
  // URL is stripped below — this is the one-time arrival read, not ongoing
  // state the app depends on the URL for.
  useAffiliateTracking({ ref });

  // Consume the auth-guard redirect's flag exactly once per mount.
  useEffect(() => {
    if (pendingShowSignIn) consumeShowSignIn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prompt/ref have been read into real state above (generationPrompt,
  // localStorage via useAffiliateTracking) — strip them from the URL so
  // nothing (a reload, a bookmark, a shared link) ever re-triggers off the
  // URL itself again.
  useEffect(() => {
    if (urlPrompt || ref) {
      navigate({ to: '/home', search: {}, replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // No search param carried: the flow record's own stored prompt
      // (already set above) is what the destination page reads.
      navigate({
        to: '/flow/$flowId',
        params: { flowId: String(created.id) },
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
      autoShowSignIn={pendingShowSignIn}
    />
  );
}
