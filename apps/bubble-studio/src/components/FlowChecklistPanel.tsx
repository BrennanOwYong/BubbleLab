/**
 * Plain-language checklist of what a flow does — the primary view in the
 * slot the raw Code tab used to occupy. Items derive from the flow's parsed
 * `workflow` step graph (falling back to the approved plan in the saved
 * conversation); the raw code stays reachable through the "View code" link.
 */
import { useMemo } from 'react';
import { CheckCircle2, Code, ListChecks } from 'lucide-react';
import { useBubbleFlow } from '../hooks/useBubbleFlow';
import { useUIStore } from '../stores/uiStore';
import {
  deriveChecklistItems,
  deriveFlowSummary,
  parseConversationMessages,
} from '../utils/flowChecklist';

export function FlowChecklistPanel({ flowId }: { flowId: number | null }) {
  const { data: currentFlow } = useBubbleFlow(flowId);
  const setConsolidatedPanelTab = useUIStore(
    (state) => state.setConsolidatedPanelTab
  );

  const messages = useMemo(
    () => parseConversationMessages(currentFlow?.metadata),
    [currentFlow?.metadata]
  );

  const items = useMemo(
    () => deriveChecklistItems(currentFlow?.workflow, messages),
    [currentFlow?.workflow, messages]
  );

  const summary = deriveFlowSummary(messages, currentFlow?.description);

  const viewCodeButton = (
    <button
      type="button"
      onClick={() => setConsolidatedPanelTab('code')}
      className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
    >
      <Code className="w-3.5 h-3.5" />
      View code
    </button>
  );

  if (!flowId || !currentFlow || items.length === 0) {
    return (
      <div className="h-full flex flex-col bg-[#1a1a1a]">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-gray-500 px-6">
            <ListChecks className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm">
              {flowId
                ? 'No steps to describe yet'
                : 'Select a flow to see what it does'}
            </p>
            {flowId && (
              <p className="text-xs text-gray-600 mt-1">
                The checklist appears once the flow has been generated
              </p>
            )}
            {flowId && (
              <div className="mt-3 flex justify-center">{viewCodeButton}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#1a1a1a]">
      <div className="px-4 py-3 border-b border-[#30363d] flex-shrink-0 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-100">
            What this flow does
          </h3>
          {summary && (
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">
              {summary}
            </p>
          )}
        </div>
        <div className="flex-shrink-0 pt-0.5">{viewCodeButton}</div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <ol className="space-y-3">
          {items.map((item, index) => (
            <li
              key={item.id}
              className="flex items-start gap-3 rounded-lg border border-[#30363d] bg-[#0f1115] px-3 py-2.5"
            >
              <CheckCircle2 className="w-4 h-4 text-green-400/80 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-sm text-gray-200 leading-relaxed">
                  <span className="text-gray-500 mr-1.5">{index + 1}.</span>
                  {item.text}
                </p>
                {item.tools.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {item.tools.map((tool) => (
                      <span
                        key={tool}
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-700/50 text-gray-400"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
