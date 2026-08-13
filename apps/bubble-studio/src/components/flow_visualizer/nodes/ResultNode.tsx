/**
 * U2 — terminal canvas node revealing the flow's headline result.
 *
 * Rendered only when the flow has metadata.primaryOutput (FlowVisualizer
 * appends it after the last main node in both layout branches). One button
 * carrying the agent-authored label; clicking reveals the latest run's value
 * per kind (F0.5: formatted, plain-language, never raw JSON):
 * - artefact -> the link with an Open action (never auto-opens a tab)
 * - process  -> the stated outcomes as a short list
 * - both     -> the link and the list
 * The reveal emits the `result_node_reveal` telemetry event (Pillar 2).
 */
import { memo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { ExternalLink, Sparkles } from 'lucide-react';
import { useExecutionStore } from '@/stores/executionStore';
import { useExecutionHistory } from '@/hooks/useExecutionHistory';
import { track } from '@/lib/telemetry';
import {
  deriveResultNodeValue,
  resultHasValue,
  type PrimaryOutput,
} from '../resultNodeValue';

export interface ResultNodeData {
  flowId: number;
  primaryOutput: PrimaryOutput;
}

interface ResultNodeProps {
  data: ResultNodeData;
}

function ResultNode({ data }: ResultNodeProps) {
  const { flowId, primaryOutput } = data;
  const [revealed, setRevealed] = useState(false);

  // Live/restored run value: the retained event array is the primary source;
  // the newest persisted successful execution covers a fresh page with no
  // retained run.
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

  const handleReveal = () => {
    setRevealed(true);
    track('result_node_reveal', {
      flowId,
      kind: primaryOutput.kind,
      hasValue,
      surface: 'canvas',
    });
  };

  return (
    <div className="bg-neutral-800/90 rounded-[28px] border border-neutral-600 overflow-hidden transition-all duration-300 w-[320px]">
      {/* Input handle on the left, fed by the last main node */}
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        isConnectable={false}
        className="w-3 h-3 bg-emerald-400"
        style={{ left: -6 }}
      />

      <div className="px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="h-8 w-8 rounded-lg bg-emerald-600 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div className="text-sm font-medium text-gray-200">Result</div>
        </div>

        {!revealed ? (
          <button
            type="button"
            onClick={handleReveal}
            className="w-full px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-medium transition-colors"
          >
            {primaryOutput.label}
          </button>
        ) : (
          <div className="space-y-2">
            <div className="text-[13px] text-gray-300 font-medium">
              {primaryOutput.label}
            </div>
            {!hasValue && (
              <div className="text-xs text-gray-400">
                Run the flow to see its latest result here.
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
              <ul className="space-y-1">
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
        )}
      </div>
    </div>
  );
}

export default memo(ResultNode);
