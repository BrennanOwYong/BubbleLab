import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { HomePage } from '@/pages/HomePage';
import { useAuth } from '@/hooks/useAuth';
import { useDeleteBubbleFlow } from '@/hooks/useDeleteBubbleFlow';
import { useBubbleFlowList } from '@/hooks/useBubbleFlowList';
import { toast } from 'react-toastify';

export const Route = createFileRoute('/flows')({
  component: HomeRoute,
});

function HomeRoute() {
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const deleteBubbleFlowMutation = useDeleteBubbleFlow();
  const { data: bubbleFlowList } = useBubbleFlowList();

  // Redirect to /home if not signed in
  if (!isSignedIn) {
    // Open up sign in modal by passing showSignIn param
    navigate({ to: '/home', search: { showSignIn: true }, replace: true });
    return null;
  }

  const handleFlowDelete = async (flowId: number, event: React.MouseEvent) => {
    event.stopPropagation();

    // Show confirmation dialog
    const flowName = bubbleFlowList?.bubbleFlows.find(
      (flow) => flow.id === flowId
    )?.name;
    const confirmed = window.confirm(
      `Are you sure you want to delete "${flowName}"?\n\nThis action cannot be undone.`
    );

    if (confirmed) {
      try {
        console.log('[deleteFlow] Deleting flow with ID:', flowId);

        // Use the delete mutation with optimistic updates
        await deleteBubbleFlowMutation.mutateAsync(flowId);

        console.log('[deleteFlow] Flow deletion completed successfully');
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        console.error('[deleteFlow] Error deleting flow:', error);
        toast.error(`Failed to delete flow "${flowName}": ${errorMessage}`);
      }
    }
  };

  return (
    <div className="h-screen flex flex-col bg-[#1a1a1a] text-gray-100">
      <div className="flex-1 min-h-0">
        <HomePage onFlowDelete={handleFlowDelete} />
      </div>
    </div>
  );
}
