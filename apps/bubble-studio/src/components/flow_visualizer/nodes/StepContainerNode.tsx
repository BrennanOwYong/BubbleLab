import { memo, useMemo } from 'react';
import { Handle, Position } from '@xyflow/react';
import {
  STEP_CONTAINER_LAYOUT,
  CUSTOM_TOOL_LAYOUT,
  CUSTOM_TOOL_LIST_ROW_HEIGHT,
  calculateStepContainerHeight,
  calculateHeaderHeight,
  calculateCustomToolListHeight,
} from '@/components/flow_visualizer/stepContainerUtils';
import { useExecutionStore } from '@/stores/executionStore';
import { BUBBLE_COLORS } from '@/components/flow_visualizer/BubbleColors';
import { findLogoForBubble } from '@/lib/integrations';

/** One inner bubble call of a custom-tool step, listed statically. */
export interface StepToolCall {
  variableId: number;
  variableName?: string;
  bubbleName?: string;
  className?: string;
}

export interface StepContainerNodeData {
  flowId: number;
  stepId: string; // Node ID for tracking highlight state
  stepInfo: {
    functionName: string;
    description?: string;
    location: { startLine: number; endLine: number };
    isAsync: boolean;
  };
  bubbleIds: string[]; // IDs of bubbles inside this step
  isCustomTool?: boolean; // Whether this is a custom tool function call (rendered smaller)
  toolCalls?: StepToolCall[]; // Custom-tool steps: the inner calls, rendered as a static list
  usedHandles?: {
    top?: boolean;
    bottom?: boolean;
    left?: boolean;
    right?: boolean;
  };
}

interface StepContainerNodeProps {
  data: StepContainerNodeData;
}

function StepContainerNode({ data }: StepContainerNodeProps) {
  const {
    flowId,
    stepId,
    stepInfo,
    bubbleIds,
    isCustomTool = false,
    toolCalls = [],
    usedHandles = {},
  } = data;
  const { functionName, description } = stepInfo;

  // Use scaled layout for custom tool containers
  const layout = isCustomTool ? CUSTOM_TOOL_LAYOUT : STEP_CONTAINER_LAYOUT;

  // Get execution state from execution store
  const highlightedBubble = useExecutionStore(
    flowId,
    (s) => s.highlightedBubble
  );
  const runningBubbles = useExecutionStore(flowId, (s) => s.runningBubbles);

  const isHighlighted = highlightedBubble === stepId;

  // Check if any bubble in this step is currently executing
  const isExecuting = useMemo(() => {
    return bubbleIds.some((bubbleId) => runningBubbles.has(String(bubbleId)));
  }, [bubbleIds, runningBubbles]);

  // Calculate dynamic header height based on content
  const baseHeaderHeight = calculateHeaderHeight(functionName, description);
  // Scale header height for custom tools
  const headerHeight = isCustomTool
    ? Math.round(baseHeaderHeight * CUSTOM_TOOL_LAYOUT.SCALE)
    : baseHeaderHeight;
  const calculatedHeight = isCustomTool
    ? calculateCustomToolListHeight(toolCalls.length, baseHeaderHeight)
    : calculateStepContainerHeight(bubbleIds.length, baseHeaderHeight);

  return (
    <div
      // No backdrop-filter here: inside React Flow's transformed viewport,
      // Chromium samples stale GPU surface memory for the backdrop and renders
      // other windows / the tab strip into the card. Opaque fill instead.
      className={`relative rounded-lg border shadow-xl cursor-pointer ${
        isExecuting
          ? 'bg-neutral-800'
          : isHighlighted
            ? `${BUBBLE_COLORS.SELECTED.border} ${BUBBLE_COLORS.SELECTED.background}`
            : 'border-neutral-600/60 bg-neutral-800 hover:border-neutral-500/80'
      }`}
      style={{
        width: `${layout.WIDTH}px`,
        height: `${calculatedHeight}px`,
        ...(isExecuting && {
          animation: 'border-flash 1s ease-in-out infinite',
          borderWidth: '2px',
        }),
      }}
    >
      {/* Connection handles - only show if used */}
      {usedHandles.top && (
        <Handle
          type="target"
          position={Position.Top}
          id="top"
          className={`w-3 h-3 ${isHighlighted ? BUBBLE_COLORS.SELECTED.handle : BUBBLE_COLORS.DEFAULT.handle}`}
          style={{ top: -6 }}
        />
      )}
      {usedHandles.bottom && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="bottom"
          className={`w-3 h-3 ${isHighlighted ? BUBBLE_COLORS.SELECTED.handle : BUBBLE_COLORS.DEFAULT.handle}`}
          style={{ bottom: -6 }}
        />
      )}
      {usedHandles.left && (
        <Handle
          type="target"
          position={Position.Left}
          id="left"
          className={`w-3 h-3 ${isHighlighted ? BUBBLE_COLORS.SELECTED.handle : BUBBLE_COLORS.DEFAULT.handle}`}
          style={{ left: -6 }}
        />
      )}
      {usedHandles.right && (
        <Handle
          type="source"
          position={Position.Right}
          id="right"
          className={`w-3 h-3 ${isHighlighted ? BUBBLE_COLORS.SELECTED.handle : BUBBLE_COLORS.DEFAULT.handle}`}
          style={{ right: -6 }}
        />
      )}

      {/* Header Section */}
      <div
        className={`bg-neutral-900/80 border-b border-neutral-600/60 rounded-t-lg flex-shrink-0 pointer-events-none ${
          isCustomTool ? 'px-3 py-2' : 'px-5 py-4'
        }`}
        style={{
          height: `${headerHeight}px`,
        }}
      >
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`font-semibold text-white truncate ${
              isCustomTool ? 'text-sm' : 'text-xl'
            }`}
          >
            {functionName}()
          </span>
        </div>
        {description && (
          <p
            className={`text-neutral-200 break-words ${
              isCustomTool ? 'text-xs' : 'text-base'
            }`}
          >
            {description}
          </p>
        )}
      </div>

      {/* Content Area: custom-tool steps list their inner calls statically
          (no drag-and-drop, no interactivity — credential needs surface in
          the Setup tab); regular steps position child bubble nodes here. */}
      <div
        className="relative flex-shrink-0"
        style={{
          height: `${calculatedHeight - headerHeight}px`,
          padding: `${layout.PADDING}px`,
        }}
      >
        {isCustomTool && toolCalls.length > 0 && (
          <ul className="pointer-events-none select-none space-y-0 list-none m-0 p-0">
            {toolCalls.map((toolCall) => {
              const logo = findLogoForBubble(toolCall);
              return (
                <li
                  key={toolCall.variableId}
                  className="flex items-center gap-2 px-2"
                  style={{ height: `${CUSTOM_TOOL_LIST_ROW_HEIGHT}px` }}
                >
                  {logo ? (
                    <img
                      src={logo.file}
                      alt={`${logo.name} logo`}
                      className="w-5 h-5 object-contain flex-shrink-0"
                    />
                  ) : (
                    <span className="w-5 h-5 rounded bg-neutral-700 flex-shrink-0" />
                  )}
                  <span className="text-xs text-neutral-200 truncate">
                    {toolCall.variableName ||
                      toolCall.bubbleName ||
                      String(toolCall.variableId)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default memo(StepContainerNode);
