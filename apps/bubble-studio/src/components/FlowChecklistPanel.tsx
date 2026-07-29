/**
 * Plain-language checklist of a flow — the primary view in the slot the raw
 * Code tab used to occupy. Four sections only (B3): when it runs, what you
 * need to provide, what it does, and what happens on failure. Items derive
 * from the flow's parsed `workflow` step graph (falling back to the approved
 * plan in the saved conversation), the inputSchema, and the trigger config.
 * Raw code is never displayed in the flow editor.
 */
import { useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileInput,
  ListChecks,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useBubbleFlow } from '../hooks/useBubbleFlow';
import {
  deriveChecklistSections,
  deriveFlowSummary,
  parseConversationMessages,
  type ChecklistItem,
} from '../utils/flowChecklist';

function ChecklistSection({
  title,
  icon: Icon,
  items,
  numbered = false,
}: {
  title: string;
  icon: LucideIcon;
  items: ChecklistItem[];
  numbered?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-gray-300 mb-2">
        <Icon className="w-3.5 h-3.5 text-gray-500" />
        {title}
      </h4>
      <ol className="space-y-2">
        {items.map((item, index) => (
          <li
            key={item.id}
            className="flex items-start gap-3 rounded-lg border border-[#30363d] bg-[#0f1115] px-3 py-2.5"
          >
            <CheckCircle2 className="w-4 h-4 text-green-400/80 mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm text-gray-200 leading-relaxed">
                {numbered && (
                  <span className="text-gray-500 mr-1.5">{index + 1}.</span>
                )}
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
    </section>
  );
}

export function FlowChecklistPanel({ flowId }: { flowId: number | null }) {
  const { data: currentFlow } = useBubbleFlow(flowId);

  const messages = useMemo(
    () => parseConversationMessages(currentFlow?.metadata),
    [currentFlow?.metadata]
  );

  const sections = useMemo(
    () =>
      deriveChecklistSections({
        workflow: currentFlow?.workflow,
        conversationMessages: messages,
        inputSchema: currentFlow?.inputSchema,
        eventType: currentFlow?.eventType,
        cron: currentFlow?.cron,
        cronActive: currentFlow?.cronActive,
      }),
    [
      currentFlow?.workflow,
      messages,
      currentFlow?.inputSchema,
      currentFlow?.eventType,
      currentFlow?.cron,
      currentFlow?.cronActive,
    ]
  );

  const summary = deriveFlowSummary(messages, currentFlow?.description);
  const hasContent =
    sections.outcomes.length > 0 ||
    sections.requiredInputs.length > 0 ||
    sections.trigger.length > 0;

  if (!flowId || !currentFlow || !hasContent) {
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
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#1a1a1a]">
      <div className="px-4 py-3 border-b border-[#30363d] flex-shrink-0">
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
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">
        <ChecklistSection
          title="When it runs"
          icon={Clock}
          items={sections.trigger}
        />
        <ChecklistSection
          title="What you need to provide"
          icon={FileInput}
          items={sections.requiredInputs}
        />
        <ChecklistSection
          title="What it does"
          icon={ListChecks}
          items={sections.outcomes}
          numbered
        />
        <ChecklistSection
          title="If something goes wrong"
          icon={AlertTriangle}
          items={sections.errorResponses}
        />
      </div>
    </div>
  );
}
