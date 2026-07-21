/**
 * Persists per-step credential selections into the flow's STORED
 * bubbleParameters (PUT /bubble-flow/:id) whenever the execution store holds a
 * bound slot the stored parameters lack — auto-bound, suite-bound, and manual
 * selections alike. Before this hook, bindings reached the database only on
 * Run, so a reload (or a webhook/cron execution) of a never-run flow saw
 * unbound slots.
 *
 * Fires debounced, once per distinct diff (a failed PUT is not retried until
 * the diff changes), and never while the flow has no parameters yet (Pearl
 * generation in progress) so a stale cache cannot clobber the generated flow.
 */
import { useEffect, useRef } from 'react';
import type { ParsedBubbleWithInfo } from '@bubblelab/shared-schemas';
import { useBubbleFlow } from './useBubbleFlow';
import { useExecutionStore } from '../stores/executionStore';
import { useUpdateBubbleFlow } from './useUpdateBubbleFlow';
import { bindingKeyForBubble } from '../lib/credentialBinding';

const PERSIST_DEBOUNCE_MS = 500;

/**
 * The (bubbleKey, credentialType, credentialId) triples selected in the store
 * but absent (or different) in the stored bubbleParameters. Exported for
 * tests.
 */
export function computeUnpersistedBindings(
  bubbleParameters: Record<string, ParsedBubbleWithInfo>,
  pendingCredentials: Record<string, Record<string, number>>
): Array<{ bubbleKey: string; credentialType: string; credentialId: number }> {
  const unpersisted: Array<{
    bubbleKey: string;
    credentialType: string;
    credentialId: number;
  }> = [];
  for (const [entryKey, bubble] of Object.entries(bubbleParameters)) {
    const bubbleKey = bindingKeyForBubble(bubble, entryKey);
    const selected = pendingCredentials[bubbleKey];
    if (!selected || Object.keys(selected).length === 0) continue;
    const credentialsParam = bubble.parameters.find(
      (p) => p.name === 'credentials'
    );
    const stored =
      credentialsParam &&
      typeof credentialsParam.value === 'object' &&
      credentialsParam.value !== null
        ? (credentialsParam.value as Record<string, unknown>)
        : {};
    for (const [credentialType, credentialId] of Object.entries(selected)) {
      if (stored[credentialType] !== credentialId) {
        unpersisted.push({ bubbleKey, credentialType, credentialId });
      }
    }
  }
  return unpersisted;
}

export function usePersistCredentialBindings(flowId: number | null): void {
  const { data: flow } = useBubbleFlow(flowId);
  const pendingCredentials = useExecutionStore(
    flowId,
    (state) => state.pendingCredentials
  );
  const updateBubbleFlowMutation = useUpdateBubbleFlow(flowId);
  const lastAttemptRef = useRef<string | null>(null);

  useEffect(() => {
    if (!flowId || !flow) return;
    const bubbleParameters = flow.bubbleParameters ?? {};
    if (Object.keys(bubbleParameters).length === 0) return;

    const unpersisted = computeUnpersistedBindings(
      bubbleParameters,
      pendingCredentials
    );
    if (unpersisted.length === 0) return;

    const signature = `${flowId}:${JSON.stringify(
      unpersisted.sort((a, b) =>
        `${a.bubbleKey}:${a.credentialType}`.localeCompare(
          `${b.bubbleKey}:${b.credentialType}`
        )
      )
    )}`;
    if (lastAttemptRef.current === signature) return;

    const timer = setTimeout(() => {
      lastAttemptRef.current = signature;
      updateBubbleFlowMutation.mutate({
        flowId,
        credentials: pendingCredentials,
      });
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // updateBubbleFlowMutation is a fresh object each render; depending on it
    // would re-arm the timer every render. mutate is stable per react-query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, flow, pendingCredentials]);
}
