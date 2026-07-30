import {
  Activity,
  Clock,
  KeyRound,
  ListChecks,
  MessageSquare,
  Sparkles,
} from 'lucide-react';
import { useMemo } from 'react';
import { PearlChat } from './ai/PearlChat';
import { FlowSetupPanel } from './FlowSetupPanel';
import { FlowChecklistPanel } from './FlowChecklistPanel';
import { FlowConversationPanel } from './FlowConversationPanel';
import { MonacoEditor } from './MonacoEditor';
import LiveOutput from './execution_logs/LiveOutput';
import { ExecutionHistory } from './execution_logs/ExecutionHistory';
import { useExecutionStore } from '../stores/executionStore';
import { useUIStore } from '../stores/uiStore';
import { useBubbleFlow } from '../hooks/useBubbleFlow';
import { useExecutionHistory } from '../hooks/useExecutionHistory';
import {
  deriveChecklistItems,
  parseConversationMessages,
  parseConversationThread,
} from '../utils/flowChecklist';
import { shallow } from 'zustand/shallow';

export function ConsolidatedSidePanel() {
  const flowId = useUIStore((state) => state.selectedFlowId);
  const activeTab = useUIStore((state) => state.consolidatedPanelTab);
  const setConsolidatedPanelTab = useUIStore(
    (state) => state.setConsolidatedPanelTab
  );
  const { data: currentFlow } = useBubbleFlow(flowId);

  const conversationMessages = useMemo(
    () => parseConversationMessages(currentFlow?.metadata),
    [currentFlow?.metadata]
  );
  // Full thread (Coffee messages + programmatic workflow-status messages)
  // drives the Conversation tab badge so "needs info" messages count too.
  const conversationThreadLength = useMemo(
    () => parseConversationThread(currentFlow?.metadata).length,
    [currentFlow?.metadata]
  );
  const checklistItems = useMemo(
    () => deriveChecklistItems(currentFlow?.workflow, conversationMessages),
    [currentFlow?.workflow, conversationMessages]
  );

  // Use selector to only subscribe to specific fields and prevent unnecessary re-renders
  // This prevents FlowVisualizer from re-rendering when tabs switch
  const executionState = useExecutionStore(
    flowId ?? 0,
    (state) => ({
      isRunning: state.isRunning,
      events: state.events,
      currentLine: state.currentLine,
      getExecutionStats: state.getExecutionStats,
    }),
    shallow
  );
  const { total: executionTotal } = useExecutionHistory(flowId, { limit: 10 });

  const tabs = [
    {
      id: 'pearl' as const,
      label: 'Gluu',
      icon: Sparkles,
      badge: null,
    },
    {
      // Replaces the raw Code tab: plain-language checklist of what the
      // flow does. Raw code is not displayed anywhere in the flow editor.
      id: 'checklist' as const,
      label: 'Checklist',
      icon: ListChecks,
      badge: checklistItems.length > 0 ? checklistItems.length : null,
    },
    {
      id: 'conversation' as const,
      label: 'Conversation',
      icon: MessageSquare,
      badge: conversationThreadLength > 0 ? conversationThreadLength : null,
    },
    {
      id: 'output' as const,
      label: 'Console',
      icon: Activity,
      badge: executionState.isRunning ? 'running' : null,
    },
    {
      id: 'history' as const,
      label: 'History',
      icon: Clock,
      badge: executionTotal ?? null,
    },
    {
      id: 'setup' as const,
      label: 'Setup',
      icon: KeyRound,
      badge: null,
    },
  ];

  return (
    <div className="h-full flex flex-col bg-[#1a1a1a] border-l border-[#30363d]">
      {/* Tab Bar — horizontally scrollable; each tab is icon-only and expands
          to show its word only while active (clicking one collapses the rest). */}
      <div className="flex overflow-x-auto thin-scrollbar border-b border-[#30363d] bg-[#0f1115]">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              type="button"
              title={tab.label}
              aria-label={tab.label}
              onClick={() => setConsolidatedPanelTab(tab.id)}
              className={`flex-shrink-0 flex items-center justify-center px-3 py-3 text-sm font-medium transition-all duration-200 border-b-2 whitespace-nowrap ${
                isActive
                  ? 'border-white text-white bg-[#1a1a1a]'
                  : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-[#161b22]'
              }`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {/* Label collapses to zero width when inactive; expands when active */}
              <span
                className={`overflow-hidden transition-all duration-200 ${
                  isActive
                    ? 'max-w-[140px] opacity-100 ml-2'
                    : 'max-w-0 opacity-0'
                }`}
              >
                {tab.label}
              </span>
              {tab.badge !== null && (
                <span
                  className={`ml-1.5 flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${
                    tab.badge === 'running'
                      ? 'bg-gray-700 text-white animate-pulse'
                      : 'bg-gray-700/50 text-gray-400'
                  }`}
                >
                  {tab.badge === 'running' ? '●' : tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content - Monaco is always mounted for useEditor to work */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {/* Pearl Chat Tab - Only render when active */}
        <div className="absolute inset-0">
          <PearlChat />
        </div>

        {/* Checklist Tab - plain-language view of what the flow does */}
        {activeTab === 'checklist' && (
          <div className="absolute inset-0">
            <FlowChecklistPanel flowId={flowId} />
          </div>
        )}

        {/* Conversation Tab - the saved thread that built this flow */}
        {activeTab === 'conversation' && (
          <div className="absolute inset-0">
            <FlowConversationPanel flowId={flowId} />
          </div>
        )}

        {/* Monaco stays mounted but permanently hidden: useEditor reads and
            writes flow code through the live editor instance (param editing,
            validation, cron updates), so the instance must exist even though
            raw code is never displayed in the flow editor. */}
        <div className="hidden" aria-hidden="true">
          <MonacoEditor />
        </div>

        {/* Live Output Tab - Only render when active */}
        {activeTab === 'output' && (
          <div className="absolute inset-0">
            {flowId ? (
              <LiveOutput
                flowId={flowId}
                events={executionState.events}
                currentLine={executionState.currentLine}
                executionStats={executionState.getExecutionStats()}
                isRunning={executionState.isRunning}
              />
            ) : (
              <div className="h-full flex items-center justify-center">
                <div className="text-center text-gray-500">
                  <Activity className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">No flow selected</p>
                  <p className="text-xs text-gray-600 mt-1">
                    Select a flow to view execution output
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* History Tab - Only render when active */}
        {activeTab === 'history' && (
          <div className="absolute inset-0">
            <ExecutionHistory flowId={flowId} />
          </div>
        )}

        {/* Setup Tab (FU-9) - credential -> step manifest */}
        {activeTab === 'setup' && (
          <div className="absolute inset-0">
            <FlowSetupPanel />
          </div>
        )}
      </div>
    </div>
  );
}
