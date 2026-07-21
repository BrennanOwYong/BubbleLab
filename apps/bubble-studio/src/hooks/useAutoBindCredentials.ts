/**
 * Applies the default credential bindings (lib/credentialBinding.ts) to the
 * flow's execution store: every required-credential slot with no selection is
 * bound to the user's connected credential of that type (or, with none of the
 * exact type, to a credential whose stored derived-credential records cover
 * the type) as soon as flow details and credentials load.
 *
 * The effect subscribes to pendingCredentials and RE-ASSERTS: a slot emptied
 * by an external wipe (a validation round-trip that lost bindings, a flow
 * cache replace) is re-filled on the next run. Only slots the store marks
 * suppressed (user cleared the chooser, suite scope-probe rolled back) stay
 * empty — deliberate emptiness is respected, accidental emptiness is not.
 *
 * Runs after FlowIDEView's saved-credential extraction (hook call order), so
 * saved bindings win and only genuinely-missing slots are filled. Emits one
 * `setup.credential_autobound` telemetry event per (slot, credential) pair —
 * re-assertions of the same pair stay silent.
 */
import { useEffect, useRef } from 'react';
import { useBubbleFlow } from './useBubbleFlow';
import { useCredentials } from './useCredentials';
import { getExecutionStore, useExecutionStore } from '../stores/executionStore';
import { computeAutoBindings } from '../lib/credentialBinding';
import type { AutoBinding } from '../lib/credentialBinding';
import { emitTelemetry } from '../lib/telemetry';
import { API_BASE_URL } from '../env';

export function useAutoBindCredentials(flowId: number | null): void {
  const { data: flow } = useBubbleFlow(flowId);
  const { data: credentials = [] } = useCredentials(API_BASE_URL);
  const pendingCredentials = useExecutionStore(
    flowId,
    (state) => state.pendingCredentials
  );
  const suppressedSlots = useExecutionStore(
    flowId,
    (state) => state.suppressedAutoBindSlots
  );
  const emittedTelemetryRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!flowId || !flow || credentials.length === 0) return;

    const store = getExecutionStore(flowId);
    const bindings = computeAutoBindings({
      bubbleParameters: flow.bubbleParameters ?? {},
      requiredCredentials: flow.requiredCredentials ?? {},
      pendingCredentials: store.pendingCredentials,
      credentials,
    }).filter(
      (binding) =>
        !store.suppressedAutoBindSlots.has(
          `${binding.bubbleKey}:${binding.credentialType}`
        )
    );
    if (bindings.length === 0) return;

    for (const binding of bindings) {
      store.setCredential(
        binding.bubbleKey,
        binding.credentialType,
        binding.credentialId
      );
    }

    const byType = new Map<string, AutoBinding[]>();
    for (const binding of bindings) {
      const telemetryKey = `${flowId}:${binding.bubbleKey}:${binding.credentialType}:${binding.credentialId}`;
      if (emittedTelemetryRef.current.has(telemetryKey)) continue;
      emittedTelemetryRef.current.add(telemetryKey);
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
  }, [flowId, flow, credentials, pendingCredentials, suppressedSlots]);
}
