/**
 * Applies the default credential bindings (lib/credentialBinding.ts) to the
 * flow's execution store: every required-credential slot with no selection is
 * bound to the user's connected credential of that type (single account) or to
 * the most recently created one (several accounts) as soon as flow details and
 * credentials load. Each (flow, step, type) slot binds at most once per mount
 * so a user clearing a selection is not fought.
 *
 * Runs after FlowIDEView's saved-credential extraction (hook call order), so
 * saved bindings win and only genuinely-missing slots are filled. Emits one
 * `setup.credential_autobound` telemetry event per credential type applied.
 */
import { useEffect, useRef } from 'react';
import { useBubbleFlow } from './useBubbleFlow';
import { useCredentials } from './useCredentials';
import { getExecutionStore } from '../stores/executionStore';
import { computeAutoBindings } from '../lib/credentialBinding';
import type { AutoBinding } from '../lib/credentialBinding';
import { emitTelemetry } from '../lib/telemetry';
import { API_BASE_URL } from '../env';

export function useAutoBindCredentials(flowId: number | null): void {
  const { data: flow } = useBubbleFlow(flowId);
  const { data: credentials = [] } = useCredentials(API_BASE_URL);
  const appliedSlotsRef = useRef<Set<string>>(new Set());
  const appliedFlowRef = useRef<number | null>(null);

  useEffect(() => {
    if (!flowId || !flow || credentials.length === 0) return;
    if (appliedFlowRef.current !== flowId) {
      appliedFlowRef.current = flowId;
      appliedSlotsRef.current = new Set();
    }

    const store = getExecutionStore(flowId);
    const bindings = computeAutoBindings({
      bubbleParameters: flow.bubbleParameters ?? {},
      requiredCredentials: flow.requiredCredentials ?? {},
      pendingCredentials: store.pendingCredentials,
      credentials,
    }).filter(
      (binding) =>
        !appliedSlotsRef.current.has(
          `${binding.bubbleKey}:${binding.credentialType}`
        )
    );
    if (bindings.length === 0) return;

    for (const binding of bindings) {
      appliedSlotsRef.current.add(
        `${binding.bubbleKey}:${binding.credentialType}`
      );
      store.setCredential(
        binding.bubbleKey,
        binding.credentialType,
        binding.credentialId
      );
    }

    const byType = new Map<string, AutoBinding[]>();
    for (const binding of bindings) {
      const group = byType.get(binding.credentialType) ?? [];
      group.push(binding);
      byType.set(binding.credentialType, group);
    }
    for (const [credentialType, group] of byType) {
      emitTelemetry('setup.credential_autobound', {
        flowId,
        credentialType,
        credentialId: group[0].credentialId,
        credentialName: group[0].credentialName,
        bubbleKeys: group.map((binding) => binding.bubbleKey),
        reason: group[0].reason,
        candidateCount: group[0].candidateCount,
      });
    }
  }, [flowId, flow, credentials]);
}
