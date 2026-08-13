/**
 * ResultRevealWidget (U2) — inline result surface shown in the flow
 * conversation when the builder agent registers the headline output
 * (set_primary_output) after its successful first self-test run.
 *
 * Renders per kind (F0.5: formatted, plain language, never raw JSON):
 * - artefact -> the labelled link with an Open action (never auto-opens)
 * - process  -> the stated outcomes as a short list
 * - both     -> the link and the list
 *
 * Uses the SAME pure derivation as the canvas ResultNode
 * (flow_visualizer/resultNodeValue.ts), so the two surfaces cannot diverge.
 * The value comes from the retained execution events when a run happened in
 * this tab, else from the newest persisted successful execution (the agent's
 * self-test runs server-side, so on the first build the persisted row is the
 * source).
 */
import { useEffect, useRef } from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';
import { useExecutionStore } from '../../stores/executionStore';
import { useExecutionHistory } from '../../hooks/useExecutionHistory';
import { track } from '../../lib/telemetry';
import {
  deriveResultNodeValue,
  resultHasValue,
  type PrimaryOutput,
} from '../flow_visualizer/resultNodeValue';

export function ResultRevealWidget({
  flowId,
  primaryOutput,
}: {
  flowId: number | null;
  primaryOutput: PrimaryOutput;
}) {
  const events = useExecutionStore(flowId, (s) => s.events);
  const { data: executions } = useExecutionHistory(flowId, { limit: 1 });
  const latestSuccess = executions?.find(
    (execution) => execution.status === 'success'
  );
  const value = deriveResultNodeValue(
    primaryOutput,
    events,
    latestSuccess?.result ?? null
  );
  const hasValue = resultHasValue(value);

  // Pillar 2: the conversation reveal emits the same telemetry event as the
  // canvas node, once per widget (re-emitted only if hasValue flips true).
  const emittedWithValueRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (flowId === null) return;
    if (emittedWithValueRef.current === true) return;
    if (emittedWithValueRef.current === hasValue) return;
    emittedWithValueRef.current = hasValue;
    track('result_node_reveal', {
      flowId,
      kind: primaryOutput.kind,
      hasValue,
      surface: 'conversation',
    });
  }, [flowId, hasValue, primaryOutput.kind]);

  return (
    <div className="p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-lg">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-emerald-400" />
        <div className="text-[13px] font-medium text-gray-200">
          {primaryOutput.label}
        </div>
      </div>
      {!hasValue && (
        <div className="text-xs text-gray-400">
          The result will appear here after the flow runs.
        </div>
      )}
      {value?.artefactUrl !== undefined && (
        <a
          href={value.artefactUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30 text-[13px] font-medium transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Open
        </a>
      )}
      {value?.outcomes !== undefined && (
        <ul className="space-y-1 mt-2">
          {value.outcomes.map((outcome, index) => (
            <li
              key={index}
              className="text-[13px] text-gray-300 flex items-start gap-1.5"
            >
              <span className="text-emerald-400 mt-0.5">•</span>
              <span className="break-words min-w-0">{outcome}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
