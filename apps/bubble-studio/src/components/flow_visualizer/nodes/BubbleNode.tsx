import { memo, useMemo, useState } from 'react';
import { Handle, Position, useNodeId } from '@xyflow/react';
import { CogIcon } from '@heroicons/react/24/outline';
import { BookOpen, ChevronDown, Cpu, Info, Layers } from 'lucide-react';
import { CredentialType, AvailableModels } from '@bubblelab/shared-schemas';
import type { CredentialResponse } from '@bubblelab/shared-schemas';
import { CreateCredentialModal } from '@/pages/CredentialsPage';
import { bindCredentialToAllSteps } from '@/lib/credentialBinding';
import { useCreateCredential } from '@/hooks/useCredentials';
import { findLogoForBubble, findDocsUrlForBubble } from '@/lib/integrations';
import {
  SYSTEM_CREDENTIALS,
  OPTIONAL_CREDENTIALS,
} from '@bubblelab/shared-schemas';
import type { ParsedBubbleWithInfo } from '@bubblelab/shared-schemas';
import BubbleExecutionBadge from '@/components/flow_visualizer/BubbleExecutionBadge';
import {
  BUBBLE_COLORS,
  BADGE_COLORS,
} from '@/components/flow_visualizer/BubbleColors';
import { SchemaParamsSection } from '@/components/flow_visualizer/param-editors/SchemaParamsSection';
import { FLOW_LAYOUT } from '@/components/flow_visualizer/flowLayoutConstants';
import { useUIStore } from '@/stores/uiStore';
import { useExecutionStore } from '@/stores/executionStore';
import { useCredentials } from '@/hooks/useCredentials';
import { API_BASE_URL } from '@/env';
import {
  getLiveOutputStore,
  useLiveOutputStore,
} from '@/stores/liveOutputStore';
import { useBubbleFlow } from '@/hooks/useBubbleFlow';
import { useEditor } from '@/hooks/useEditor';
import { extractParamValue } from '@/utils/bubbleParamEditor';
import {
  getModelParamConfig,
  getExcludedParamNames,
} from '@/config/bubbleInlineParams';
import { emitTelemetry } from '@/lib/telemetry';

export interface BubbleNodeData {
  flowId: number;
  bubble: ParsedBubbleWithInfo;
  bubbleKey: string | number;
  requiredCredentialTypes?: string[]; // Static data from flow - not execution state
  hasSubBubbles?: boolean;
  isCustomToolBubble?: boolean; // Whether this bubble is inside a custom tool container (rendered smaller)
  usedHandles?: {
    top?: boolean;
    bottom?: boolean;
    left?: boolean;
    right?: boolean;
  };
}

interface BubbleNodeProps {
  data: BubbleNodeData;
}

// Left/right handles sit at the vertical center of the collapsed plate so
// spine edges stay horizontal when the node expands downward.
const PLATE_HANDLE_TOP = FLOW_LAYOUT.EXPANDED.PLATE_HEIGHT / 2;

function BubbleNode({ data }: BubbleNodeProps) {
  const {
    flowId,
    bubble,
    bubbleKey,
    requiredCredentialTypes: propRequiredCredentialTypes = [],
    hasSubBubbles = false,
    isCustomToolBubble = false,
    usedHandles = {},
  } = data;

  // Determine the bubble ID for store lookups (prefer variableId, fallback to bubbleKey)
  const bubbleId = bubble.variableId
    ? String(bubble.variableId)
    : String(bubbleKey);

  // React Flow node id - the identity used for inline expansion (unique even
  // for dependency-graph sub-bubbles whose variableId can be -1)
  const reactFlowNodeId = useNodeId() ?? bubbleId;

  // Determine numeric root ID for expansion checks (expandedRootIds/suppressedRootIds are number[])
  const rootId =
    bubble.variableId ??
    (typeof bubbleKey === 'number'
      ? bubbleKey
      : parseInt(String(bubbleKey), 10));

  // Determine credentials key: canonical across invocation twins — a clone
  // (clonedFromVariableId set) resolves to its ORIGINAL's variableId so the
  // original entry and every clone share ONE pendingCredentials slot. Chain
  // mirrors bindingKeyForBubble (credentialBinding.ts).
  const canonicalCredentialId =
    bubble.clonedFromVariableId ?? bubble.variableId;
  const credentialsKey = String(
    canonicalCredentialId ||
      bubble.variableName ||
      bubble.bubbleName ||
      bubbleKey
  );

  // Subscribe to execution store state for this bubble (using selectors to avoid re-renders from events)
  const highlightedBubble = useExecutionStore(
    flowId,
    (s) => s.highlightedBubble
  );
  const bubbleWithError = useExecutionStore(flowId, (s) => s.bubbleWithError);
  const bubbleResults = useExecutionStore(flowId, (s) => s.bubbleResults);
  const runningBubbles = useExecutionStore(flowId, (s) => s.runningBubbles);
  const completedBubbles = useExecutionStore(flowId, (s) => s.completedBubbles);
  const pendingCredentials = useExecutionStore(
    flowId,
    (s) => s.pendingCredentials
  );

  // Get actions from store
  const setCredential = useExecutionStore(flowId, (s) => s.setCredential);
  const toggleRootExpansion = useExecutionStore(
    flowId,
    (s) => s.toggleRootExpansion
  );

  // Inline parameter-form expansion (one node at a time, global UI state)
  const expandedFlowNodeId = useUIStore((s) => s.expandedFlowNodeId);
  const toggleExpandedFlowNode = useUIStore((s) => s.toggleExpandedFlowNode);
  const isExpanded = expandedFlowNodeId === reactFlowNodeId;

  // Get flow data to find clones
  const { data: currentFlow } = useBubbleFlow(flowId);

  // Get editor functions for accessing/updating params
  const { updateBubbleParam } = useEditor(flowId);

  // Get sub-bubble visibility state from store
  const expandedRootIds = useExecutionStore(flowId, (s) => s.expandedRootIds);
  const suppressedRootIds = useExecutionStore(
    flowId,
    (s) => s.suppressedRootIds
  );

  // Compute if sub-bubbles are visible (local to this bubble node)
  const areSubBubblesVisibleLocal = useMemo(() => {
    if (!hasSubBubbles) return false;
    if (isNaN(rootId)) return false;
    const rootExpanded = expandedRootIds.includes(rootId);
    const rootSuppressed = suppressedRootIds.includes(rootId);
    return rootExpanded && !rootSuppressed;
  }, [hasSubBubbles, expandedRootIds, suppressedRootIds, rootId]);

  // Get available credentials
  const { data: availableCredentials = [] } = useCredentials(API_BASE_URL);

  // Subscribe to selected event index and tab reactively (causes re-render when changed)
  const selectedEventIndexByVariableId = useLiveOutputStore(
    flowId,
    (s) => s.selectedEventIndexByVariableId
  );
  const selectedTab = useLiveOutputStore(flowId, (s) => s.selectedTab);
  const selectedEventIndex = selectedEventIndexByVariableId[bubbleId];

  // Get total event count for this bubble to determine if we're on first/last
  const liveOutputStore = getLiveOutputStore(flowId);
  const orderedItems = liveOutputStore?.getState().getOrderedItems() || [];
  const bubbleGroup = orderedItems.find(
    (item) => item.kind === 'group' && item.name === bubbleId
  );
  const totalEvents =
    bubbleGroup && bubbleGroup.kind === 'group' ? bubbleGroup.events.length : 0;
  const lastEventIndex = Math.max(0, totalEvents - 1);

  // Check if this bubble is the one currently being viewed in console
  const activeItem =
    selectedTab.kind === 'item' ? orderedItems[selectedTab.index] : null;
  const isThisBubbleActiveInConsole =
    activeItem?.kind === 'group' && activeItem.name === bubbleId;

  // Determine if Input or Output button should be highlighted
  // Only highlight if this bubble is the active one in the console
  const isInputSelected =
    isThisBubbleActiveInConsole && selectedEventIndex === 0;
  const isOutputSelected =
    isThisBubbleActiveInConsole &&
    selectedEventIndex === lastEventIndex &&
    totalEvents > 0;

  // Determine bubble-specific state
  const isHighlighted =
    highlightedBubble === bubbleKey || highlightedBubble === bubbleId;

  // Check for errors: either fatal error OR result.success === false
  const resultSuccess = bubbleResults[bubbleId];
  const hasError =
    bubbleWithError === bubbleId ||
    (resultSuccess !== undefined && resultSuccess === false);

  const isExecuting = runningBubbles.has(bubbleId);
  const isCompleted = bubbleId in completedBubbles;
  const executionStats = completedBubbles[bubbleId];

  // Get selected credentials for this bubble
  const selectedBubbleCredentials = pendingCredentials[credentialsKey] || {};

  // Get required credential types - prefer prop (from flow.requiredCredentials), fallback to bubble parameters
  const requiredCredentialTypes = useMemo(() => {
    if (propRequiredCredentialTypes.length > 0) {
      return propRequiredCredentialTypes;
    }
    // Fallback: derive from bubble's credentials parameter
    const credParams = bubble.parameters.find((p) => p.name === 'credentials');
    if (
      !credParams ||
      typeof credParams.value !== 'object' ||
      !credParams.value
    ) {
      return [];
    }
    const credValue = credParams.value as Record<string, unknown>;
    return Object.keys(credValue);
  }, [propRequiredCredentialTypes, bubble.parameters]);

  // Check if credentials are missing (exclude system and optional credentials)
  const hasMissingRequirements = requiredCredentialTypes.some((credType) => {
    if (SYSTEM_CREDENTIALS.has(credType as CredentialType)) return false;
    if (OPTIONAL_CREDENTIALS.has(credType as CredentialType)) return false;
    const selectedId = selectedBubbleCredentials[credType];
    return selectedId === undefined || selectedId === null;
  });

  const handleCredentialChange = (credType: string, credId: number | null) => {
    const previousId = selectedBubbleCredentials[credType] ?? null;
    if (credId !== null && credId !== previousId) {
      emitTelemetry('setup.credential_switched', {
        flowId,
        credentialType: credType,
        fromCredentialId: previousId,
        toCredentialId: credId,
        bubbleKeys: [credentialsKey],
        source: 'bubble_node',
      });
    }
    // credentialsKey is canonical across invocation twins, so one write
    // covers this bubble, its original, and every sibling clone.
    setCredential(credentialsKey, credType, credId);
  };

  /**
   * One credential per tool type: a credential added from this node binds to
   * EVERY step requiring the type, not only the clicked slot. The clicked
   * slot (canonical across its invocation twins) is also bound directly,
   * covering bubbles whose keys are absent from the flow's
   * requiredCredentials (fallback-typed slots). usePersistCredentialBindings
   * persists the store changes.
   */
  const handleCredentialCreated = (
    credType: string,
    created: CredentialResponse
  ) => {
    const previousId = selectedBubbleCredentials[credType] ?? null;
    const boundKeys = new Set(
      bindCredentialToAllSteps(
        {
          bubbleParameters: currentFlow?.bubbleParameters,
          requiredCredentials: currentFlow?.requiredCredentials,
        },
        credType,
        created.id,
        setCredential
      )
    );
    if (!boundKeys.has(credentialsKey)) {
      setCredential(credentialsKey, credType, created.id);
      boundKeys.add(credentialsKey);
    }
    emitTelemetry('setup.credential_switched', {
      flowId,
      credentialType: credType,
      fromCredentialId: previousId,
      toCredentialId: created.id,
      bubbleKeys: [...boundKeys],
      source: 'bubble_node',
    });
  };

  const [logoError, setLogoError] = useState(false);
  const [createModalForType, setCreateModalForType] = useState<string | null>(
    null
  );
  const [showDocsTooltip, setShowDocsTooltip] = useState(false);

  const logo = useMemo(
    () =>
      findLogoForBubble({
        bubbleName: bubble?.bubbleName,
        className: bubble?.className,
        variableName: bubble?.variableName,
      }),
    [bubble?.bubbleName, bubble?.className, bubble?.variableName]
  );

  const docsUrl = useMemo(
    () =>
      findDocsUrlForBubble({
        bubbleName: bubble?.bubbleName,
        className: bubble?.className,
        variableName: bubble?.variableName,
      }),
    [bubble?.bubbleName, bubble?.className, bubble?.variableName]
  );

  const isSystemCredential = useMemo(() => {
    return (credType: CredentialType) => SYSTEM_CREDENTIALS.has(credType);
  }, []);

  const getCredentialsForType = (credType: string) => {
    return availableCredentials.filter(
      (cred) => cred.credentialType === credType
    );
  };

  const createCredentialMutation = useCreateCredential();

  // Model section config (same params the details popup used to surface)
  const modelConfig = getModelParamConfig(bubble.bubbleName);
  const modelParam = modelConfig
    ? bubble.parameters.find((p) => p.name === modelConfig.paramName)
    : undefined;
  const modelExtracted =
    modelParam && modelConfig
      ? extractParamValue(modelParam, modelConfig.paramPath, bubble.bubbleName)
      : undefined;
  const currentModel = modelExtracted?.value as string | undefined;
  const isModelEditable = modelExtracted?.shouldBeEditable ?? false;
  const excludedParamNames = getExcludedParamNames(bubble.bubbleName);

  const handleErrorClick = () => {
    // Navigate to the console showing this bubble's last log
    const liveOutputStore = getLiveOutputStore(flowId);
    liveOutputStore?.getState().selectBubbleInConsole(bubbleId);
  };
  // Determine if this is a sub-bubble based on variableId being negative or having a uniqueId with dots
  const isSubBubble =
    bubble.variableId < 0 ||
    (bubble.dependencyGraph?.uniqueId?.includes('.') ?? false);

  // Bubbles inside custom tool containers or sub-bubbles are rendered smaller
  const isSmallBubble = isSubBubble || isCustomToolBubble;

  return (
    <div
      className={`bg-neutral-800/90 rounded-[28px] border transition-all duration-300 ${
        isCompleted ? 'overflow-visible' : 'overflow-hidden'
      } ${
        isSmallBubble
          ? 'bg-gray-600 border-gray-500 scale-75 w-64' // Sub-bubbles and custom tool bubbles are smaller and darker
          : 'bg-gray-700 border-gray-600 w-80' // Main bubbles fixed width
      } ${
        isExecuting
          ? `${BUBBLE_COLORS.RUNNING.border} ${isHighlighted ? BUBBLE_COLORS.SELECTED.background : BUBBLE_COLORS.RUNNING.background}`
          : hasError
            ? `${BUBBLE_COLORS.ERROR.border} ${isHighlighted ? BUBBLE_COLORS.SELECTED.background : BUBBLE_COLORS.ERROR.background}`
            : isCompleted
              ? `${BUBBLE_COLORS.COMPLETED.border} ${isHighlighted ? BUBBLE_COLORS.SELECTED.background : BUBBLE_COLORS.COMPLETED.background}`
              : isHighlighted
                ? `${BUBBLE_COLORS.SELECTED.border} ${BUBBLE_COLORS.SELECTED.background}`
                : BUBBLE_COLORS.DEFAULT.border
      }`}
    >
      {/* Node handles for horizontal (main flow) and vertical (dependencies) connections */}
      {/* Left Handle - Shows "Input" button after execution - only render if used */}
      {usedHandles.left && (
        <div
          className="absolute left-0 z-10 -translate-y-1/2"
          style={{ top: PLATE_HANDLE_TOP }}
        >
          <Handle
            type="target"
            position={Position.Left}
            id="left"
            isConnectable={false}
            className={`w-3 h-3 ${hasError ? BUBBLE_COLORS.ERROR.handle : isExecuting ? BUBBLE_COLORS.RUNNING.handle : isCompleted ? BUBBLE_COLORS.COMPLETED.handle : isHighlighted ? BUBBLE_COLORS.SELECTED.handle : BUBBLE_COLORS.DEFAULT.handle}`}
            style={{ left: -6, opacity: isCompleted ? 0 : 1 }}
          />
          {isCompleted && (
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[10px] font-semibold whitespace-nowrap shadow-lg border transition-all duration-300 hover:scale-105 cursor-pointer"
              style={{
                left: '0',
                backgroundColor: hasError
                  ? 'rgba(239, 68, 68, 0.9)'
                  : 'rgba(245, 245, 244, 0.95)',
                borderColor: hasError
                  ? '#dc2626'
                  : isInputSelected
                    ? 'rgba(99, 102, 241, 0.9)'
                    : 'rgba(212, 212, 211, 0.8)',
                borderWidth: isInputSelected ? '2.5px' : '1.5px',
                color: hasError ? '#ffffff' : 'rgba(23, 23, 23, 0.95)',
                boxShadow: isInputSelected
                  ? '0 0 0 2px rgba(99, 102, 241, 0.3)'
                  : undefined,
              }}
              onClick={(e) => {
                e.stopPropagation();

                // Navigate to console with first output
                const liveOutputStore = getLiveOutputStore(flowId);
                if (liveOutputStore) {
                  liveOutputStore.getState().selectBubbleInConsole(bubbleId);
                  // Set to first event (index 0)
                  liveOutputStore.getState().setSelectedEventIndex(bubbleId, 0);
                }
              }}
            >
              Input
            </div>
          )}
        </div>
      )}

      {/* Right Handle - Shows "Output" button after execution - only render if used */}
      {usedHandles.right && (
        <div
          className="absolute right-0 z-10 -translate-y-1/2"
          style={{ top: PLATE_HANDLE_TOP }}
        >
          <Handle
            type="source"
            position={Position.Right}
            id="right"
            isConnectable={false}
            className={`w-3 h-3 ${hasError ? BUBBLE_COLORS.ERROR.handle : isExecuting ? BUBBLE_COLORS.RUNNING.handle : isCompleted ? BUBBLE_COLORS.COMPLETED.handle : isHighlighted ? BUBBLE_COLORS.SELECTED.handle : BUBBLE_COLORS.DEFAULT.handle}`}
            style={{ right: -6, opacity: isCompleted ? 0 : 1 }}
          />
          {isCompleted && (
            <div
              className="absolute top-1/2 -translate-y-1/2 translate-x-1/2 px-3 py-1 rounded-full text-[10px] font-semibold whitespace-nowrap shadow-lg border transition-all duration-300 hover:scale-105 cursor-pointer"
              style={{
                right: '0',
                backgroundColor: hasError
                  ? 'rgba(239, 68, 68, 0.9)'
                  : 'rgba(23, 23, 23, 0.95)',
                borderColor: hasError
                  ? '#dc2626'
                  : isOutputSelected
                    ? 'rgba(99, 102, 241, 0.9)'
                    : 'rgba(64, 64, 64, 0.8)',
                borderWidth: isOutputSelected ? '2.5px' : '1.5px',
                color: hasError ? '#ffffff' : 'rgba(245, 245, 244, 0.95)',
                boxShadow: isOutputSelected
                  ? '0 0 0 2px rgba(99, 102, 241, 0.3)'
                  : undefined,
              }}
              onClick={(e) => {
                e.stopPropagation();
                const liveOutputStore = getLiveOutputStore(flowId);
                if (liveOutputStore) {
                  // Navigate to console with last output
                  liveOutputStore.getState().selectBubbleInConsole(bubbleId);
                  // Get ordered items to find event count for this bubble
                  const orderedItems = liveOutputStore
                    .getState()
                    .getOrderedItems();
                  const bubbleGroup = orderedItems.find(
                    (item) => item.kind === 'group' && item.name === bubbleId
                  );
                  if (bubbleGroup && bubbleGroup.kind === 'group') {
                    // Set to last event (eventCount - 1 for 0-based index)
                    const lastIndex = Math.max(
                      0,
                      bubbleGroup.events.length - 1
                    );
                    liveOutputStore
                      .getState()
                      .setSelectedEventIndex(bubbleId, lastIndex);
                  }
                }
              }}
            >
              Output
            </div>
          )}
        </div>
      )}

      {/* Bottom handle - only render if used */}
      {usedHandles.bottom && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="bottom"
          isConnectable={false}
          className={`w-3 h-3 ${hasError ? BUBBLE_COLORS.ERROR.handle : isExecuting ? BUBBLE_COLORS.RUNNING.handle : isCompleted ? BUBBLE_COLORS.COMPLETED.handle : isHighlighted ? BUBBLE_COLORS.SELECTED.handle : BUBBLE_COLORS.DEFAULT.handle}`}
          style={{ bottom: -6 }}
        />
      )}

      {/* Top handle - only render if used */}
      {usedHandles.top && (
        <Handle
          type="target"
          position={Position.Top}
          id="top"
          isConnectable={false}
          className={`w-3 h-3 ${hasError ? BUBBLE_COLORS.ERROR.handle : isExecuting ? BUBBLE_COLORS.RUNNING.handle : isCompleted ? BUBBLE_COLORS.COMPLETED.handle : isHighlighted ? BUBBLE_COLORS.SELECTED.handle : BUBBLE_COLORS.DEFAULT.handle}`}
          style={{ top: -6 }}
        />
      )}

      {/* Collapsed name plate - click toggles the inline parameter form */}
      <div
        className="flex items-center gap-3 px-5 cursor-pointer select-none"
        style={{ height: FLOW_LAYOUT.EXPANDED.PLATE_HEIGHT }}
        onClick={() => {
          // Keep the node stable while the credential creation modal is open
          if (createModalForType) return;
          toggleExpandedFlowNode(reactFlowNodeId);
        }}
      >
        {logo && !logoError ? (
          <img
            src={logo.file}
            alt={`${logo.name} logo`}
            className="h-7 w-7 object-contain flex-shrink-0"
            loading="lazy"
            onError={() => setLogoError(true)}
          />
        ) : (
          <div
            className={`h-7 w-7 rounded-full flex-shrink-0 flex items-center justify-center ${
              isHighlighted ? 'bg-purple-600' : 'bg-blue-600'
            }`}
          >
            <CogIcon className="h-4 w-4 text-white" />
          </div>
        )}

        <h3
          className="flex-1 min-w-0 text-sm font-semibold text-neutral-100 truncate"
          title={bubble.variableName}
        >
          {bubble.variableName}
        </h3>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {hasError ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleErrorClick();
              }}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-500/20 text-red-300 border border-red-600/40 hover:bg-red-500/30 transition-colors cursor-pointer"
              title="View error in console"
            >
              <span>❌</span>
              <span>Error</span>
            </button>
          ) : (
            (isCompleted || isExecuting) && (
              <BubbleExecutionBadge
                hasError={false}
                isCompleted={isCompleted}
                isExecuting={isExecuting}
                executionStats={executionStats}
                bubbleId={bubbleId}
                flowId={flowId}
              />
            )
          )}
          {!hasError && !isExecuting && hasMissingRequirements && (
            <div
              title="Missing credentials"
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${BADGE_COLORS.MISSING.background} ${BADGE_COLORS.MISSING.text} border ${BADGE_COLORS.MISSING.border}`}
            >
              <span>⚠️</span>
              <span>Missing</span>
            </div>
          )}
          {hasSubBubbles && (
            <button
              type="button"
              title={
                areSubBubblesVisibleLocal
                  ? 'Hide sub bubbles'
                  : 'Show sub bubbles'
              }
              onClick={(event) => {
                event.stopPropagation();
                if (!isNaN(rootId)) {
                  toggleRootExpansion(rootId);
                }
              }}
              className={`inline-flex items-center justify-center p-1.5 rounded-full transition-colors ${
                areSubBubblesVisibleLocal
                  ? 'bg-purple-700/40 text-purple-200'
                  : 'text-purple-300 hover:bg-purple-900/40'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
            </button>
          )}
          {docsUrl && (
            <div className="relative">
              <a
                href={docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                onMouseEnter={() => setShowDocsTooltip(true)}
                onMouseLeave={() => setShowDocsTooltip(false)}
                className="inline-flex items-center justify-center p-1.5 rounded-full text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100 transition-colors"
              >
                <BookOpen className="w-3.5 h-3.5" />
              </a>
              {showDocsTooltip && (
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 text-xs font-medium text-white bg-neutral-900 rounded shadow-lg whitespace-nowrap border border-neutral-700 z-50">
                  See Docs
                </div>
              )}
            </div>
          )}
          <ChevronDown
            className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${
              isExpanded ? 'rotate-180' : ''
            }`}
          />
        </div>
      </div>

      {/* Inline parameter form - the node grows downward to reveal it */}
      {isExpanded && (
        <div
          // Fixed height (not max-height): layout reserves exactly
          // PANEL_HEIGHT below the plate, and sequential nodes anchor at
          // their vertical center - a content-sized panel would pull the
          // plate off the spine. Long forms scroll inside.
          className="nowheel nodrag border-t border-neutral-600 overflow-y-auto cursor-default"
          style={{ height: FLOW_LAYOUT.EXPANDED.PANEL_HEIGHT }}
          onClick={(e) => e.stopPropagation()}
        >
          {(bubble.bubbleName || bubble.description) && (
            <div className="px-5 pt-4">
              {bubble.bubbleName && (
                <span className="inline-block rounded-full border border-purple-500/40 px-2.5 py-0.5 text-[10px] uppercase tracking-wide text-purple-200">
                  {bubble.bubbleName}
                </span>
              )}
              {bubble.description && (
                <p className="mt-2 text-xs text-neutral-400 break-words">
                  {bubble.description}
                </p>
              )}
            </div>
          )}

          {/* Model Section - Only for bubbles with model config */}
          {modelConfig && (
            <div className="px-5 pt-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                <Cpu className="h-3.5 w-3.5" />
                Model
              </div>
              <div className="mt-2 space-y-2 rounded-xl border border-neutral-700 bg-neutral-900/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xs font-semibold text-neutral-100">
                    {modelConfig.label || 'AI Model'}
                  </p>
                  {!isModelEditable && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/20 px-2 py-0.5 text-[10px] font-medium text-blue-300 border border-blue-500/30">
                      Dynamic
                    </span>
                  )}
                </div>
                {isModelEditable ? (
                  <select
                    title="Select AI Model"
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 focus:border-purple-500 focus:outline-none"
                    value={currentModel}
                    onChange={(e) =>
                      updateBubbleParam(
                        bubble.variableId,
                        modelConfig.paramPath,
                        e.target.value
                      )
                    }
                  >
                    {AvailableModels.options.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
                  <pre className="w-full rounded-lg border border-neutral-700 bg-neutral-950/50 px-2 py-1.5 text-xs text-neutral-400 font-mono">
                    {currentModel || 'Variable'}
                  </pre>
                )}
              </div>
            </div>
          )}

          {/* Parameters Section - same form the details popup used to show */}
          <div className="px-5 pt-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400 mb-3">
              <Info className="h-3.5 w-3.5" />
              Parameters
            </div>
            <SchemaParamsSection
              bubble={bubble}
              updateBubbleParam={updateBubbleParam}
              excludedParamNames={excludedParamNames}
            />
          </div>

          {/* Credentials Section */}
          <div className="px-5 py-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400 mb-3">
              <Info className="h-3.5 w-3.5" />
              Credentials
            </div>
            {requiredCredentialTypes.length === 0 ? (
              <p className="rounded-xl border border-neutral-700 bg-neutral-900/60 px-3 py-4 text-xs text-neutral-400">
                This bubble does not require credentials.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {requiredCredentialTypes.map((credType) => {
                  const availableForType = getCredentialsForType(credType);
                  const systemCred = isSystemCredential(
                    credType as CredentialType
                  );
                  const optionalCred = OPTIONAL_CREDENTIALS.has(
                    credType as CredentialType
                  );
                  const isMissingSelection =
                    !systemCred &&
                    !optionalCred &&
                    (selectedBubbleCredentials[credType] === undefined ||
                      selectedBubbleCredentials[credType] === null);

                  return (
                    <div key={credType} className={`space-y-1`}>
                      <label className="block text-[11px] text-neutral-300">
                        {credType}
                        {!systemCred &&
                          !optionalCred &&
                          availableForType.length > 0 && (
                            <span className="text-red-400 ml-1">*</span>
                          )}
                      </label>
                      <select
                        title={`${bubble.bubbleName} ${credType}`}
                        value={
                          selectedBubbleCredentials[credType] !== undefined &&
                          selectedBubbleCredentials[credType] !== null
                            ? String(selectedBubbleCredentials[credType])
                            : ''
                        }
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === '__ADD_NEW__') {
                            emitTelemetry('setup.add_another_opened', {
                              flowId,
                              credentialType: credType,
                              existingCount: availableForType.length,
                              source: 'bubble_node',
                            });
                            setCreateModalForType(credType);
                            return;
                          }
                          const credId = val ? parseInt(val, 10) : null;
                          handleCredentialChange(credType, credId);
                        }}
                        className={`w-full px-2 py-1 text-xs bg-neutral-700 border ${isMissingSelection ? 'border-amber-500' : 'border-neutral-500'} rounded text-neutral-100`}
                      >
                        <option value="">
                          {systemCred
                            ? 'Use system default'
                            : 'Select credential...'}
                        </option>
                        {availableForType.map((cred) => (
                          <option key={cred.id} value={String(cred.id)}>
                            {cred.name || `${cred.credentialType} (${cred.id})`}
                          </option>
                        ))}
                        <option disabled>────────────</option>
                        <option value="__ADD_NEW__">
                          + Add New Credential…
                        </option>
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Credential Modal */}
      {createModalForType && (
        <CreateCredentialModal
          isOpen={!!createModalForType}
          onClose={() => setCreateModalForType(null)}
          onSubmit={(data) => createCredentialMutation.mutateAsync(data)}
          isLoading={createCredentialMutation.isPending}
          lockedCredentialType={createModalForType as CredentialType}
          lockType
          onSuccess={(created) => {
            if (createModalForType) {
              handleCredentialCreated(createModalForType, created);
            }
            setCreateModalForType(null);
          }}
        />
      )}
    </div>
  );
}

export default memo(BubbleNode);
