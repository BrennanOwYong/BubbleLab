import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, useNodeId } from '@xyflow/react';
import { CogIcon } from '@heroicons/react/24/outline';
import { ChevronDown, Cpu, Info, Layers } from 'lucide-react';
import { CredentialType, AvailableModels } from '@bubblelab/shared-schemas';
import type { CredentialResponse } from '@bubblelab/shared-schemas';
import { CreateCredentialModal } from '@/pages/CredentialsPage';
import { bindCredentialToAllSteps } from '@/lib/credentialBinding';
import { isPlatformProvided } from '@/lib/platformCredentials';
import { usePlatformCredentialTypes } from '@/hooks/usePlatformCredentialTypes';
import { useCreateCredential } from '@/hooks/useCredentials';
import { findLogoForBubble } from '@/lib/integrations';
import { OPTIONAL_CREDENTIALS } from '@bubblelab/shared-schemas';
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
import { emitTelemetry, track } from '@/lib/telemetry';
import {
  deriveCuratedNodeView,
  curatedViewTelemetryPayload,
  humanizeSlug,
} from '@/components/flow_visualizer/curatedNodeView';
import AutoResizeTextarea from '@/components/AutoResizeTextarea';
import { useOverflowTripwire } from '@/components/flow_visualizer/nodes/useOverflowTripwire';
import { countWrappedLines } from '@/components/flow_visualizer/stepContainerUtils';

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

// U3 containment for the curated view's free-text fields (system prompt, tool
// description): the only U1 fields that are unbounded natural-language text,
// so they're the ones that can genuinely outgrow their box. Clamp to a fixed
// line count and reserve exactly that many lines of height, mirroring
// stepContainerUtils.reservedDescriptionLines (reserved >= rendered by
// construction). Width assumes the narrowest curated field box in the app
// (small/custom-tool bubbles, w-64 scaled) so the line estimate is never an
// under-count for the wider (w-80) main-bubble variant.
const CURATED_TEXT_FONT =
  '12px Inter, system-ui, Avenir, Helvetica, Arial, sans-serif'; // text-xs
const CURATED_TEXT_LINE_HEIGHT_PX = 16; // text-xs leading (1rem)
const CURATED_TEXT_MAX_LINES = 6;
const CURATED_TEXT_AVAILABLE_WIDTH_PX = 190;

/** Reserved line count for a curated text field: hard newlines each force a row. */
function reservedCuratedTextLines(text: string): number {
  const total = text
    .split('\n')
    .reduce(
      (sum, line) =>
        sum +
        Math.max(
          countWrappedLines(
            line,
            CURATED_TEXT_AVAILABLE_WIDTH_PX,
            CURATED_TEXT_FONT
          ),
          1
        ),
      0
    );
  return Math.min(total, CURATED_TEXT_MAX_LINES);
}

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
  const platformCredentialTypes = usePlatformCredentialTypes();

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

  // Get selected credentials for this bubble (memoized: the {} fallback must
  // stay referentially stable for the curated-view derivation below)
  const selectedBubbleCredentials = useMemo(
    () => pendingCredentials[credentialsKey] || {},
    [pendingCredentials, credentialsKey]
  );

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
    if (isPlatformProvided(credType, platformCredentialTypes)) return false;
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
  const logo = useMemo(
    () =>
      findLogoForBubble({
        bubbleName: bubble?.bubbleName,
        className: bubble?.className,
        variableName: bubble?.variableName,
      }),
    [bubble?.bubbleName, bubble?.className, bubble?.variableName]
  );

  const isSystemCredential = useMemo(() => {
    return (credType: CredentialType) =>
      isPlatformProvided(credType, platformCredentialTypes);
  }, [platformCredentialTypes]);

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

  // U1: curated default view for the expanded panel — one derivation feeds
  // both the render and the node.curated_view_rendered telemetry event, so
  // they cannot disagree (PLAN-DOCS/discovery/U1.md).
  const curatedView = useMemo(
    () => deriveCuratedNodeView({ bubble }),
    [bubble]
  );

  // U3 tripwire: fires layout.node_overflow if a clamped curated text field's
  // actual DOM wrap needs more lines than reservedCuratedTextLines predicted.
  const descriptionRef = useRef<HTMLDivElement>(null);
  useOverflowTripwire(descriptionRef, reactFlowNodeId, 'bubble-description');
  const systemPromptRef = useRef<HTMLDivElement>(null);
  useOverflowTripwire(systemPromptRef, reactFlowNodeId, 'bubble-system-prompt');

  // Draft for the curated system-prompt editor; committed on blur through the
  // same updateBubbleParam code-rewrite path the param editors use.
  const [promptDraft, setPromptDraft] = useState<string | null>(null);

  // Full raw param editor survives behind this closed-by-default disclosure
  // (power-user escape hatch; deletion of the param-editors family is a
  // follow-up once the curated view is validated).
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Emit once per expansion; the ref gates re-emission while expanded.
  const emittedExpansionRef = useRef(false);
  useEffect(() => {
    if (!isExpanded) {
      emittedExpansionRef.current = false;
      return;
    }
    if (emittedExpansionRef.current) return;
    emittedExpansionRef.current = true;
    track(
      'node.curated_view_rendered',
      curatedViewTelemetryPayload(flowId, bubble, curatedView)
    );
  }, [isExpanded, flowId, bubble, curatedView]);

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
                  {logo?.name ?? humanizeSlug(bubble.bubbleName)}
                </span>
              )}
              {bubble.description && (
                <div
                  ref={descriptionRef}
                  className="mt-2 overflow-hidden"
                  style={{
                    height:
                      reservedCuratedTextLines(bubble.description) *
                      CURATED_TEXT_LINE_HEIGHT_PX,
                  }}
                >
                  <p
                    className="text-xs text-neutral-400 break-words"
                    style={{
                      display: '-webkit-box',
                      WebkitLineClamp: reservedCuratedTextLines(
                        bubble.description
                      ),
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {bubble.description}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Curated default view (U1): agent = model / instructions / tools /
              memory; tool = description (header above) + connected account.
              Rendered from the same view-model the telemetry event carries. */}
          {curatedView.kind === 'agent' ? (
            <>
              {/* Instructions (system prompt) */}
              <div className="px-5 pt-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  <Info className="h-3.5 w-3.5" />
                  Instructions
                </div>
                <div className="mt-2 rounded-xl border border-neutral-700 bg-neutral-900/60 p-3">
                  {curatedView.systemPrompt.editable ? (
                    <AutoResizeTextarea
                      title="Edit the instructions"
                      value={
                        promptDraft ?? curatedView.systemPrompt.value ?? ''
                      }
                      maxHeight={160}
                      onChange={(e) => setPromptDraft(e.target.value)}
                      onBlur={() => {
                        if (
                          promptDraft !== null &&
                          promptDraft !== (curatedView.systemPrompt.value ?? '')
                        ) {
                          updateBubbleParam(
                            bubble.variableId,
                            'systemPrompt',
                            promptDraft
                          );
                        }
                        setPromptDraft(null);
                      }}
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 focus:border-purple-500 focus:outline-none resize-none"
                    />
                  ) : (
                    <div
                      ref={systemPromptRef}
                      className="overflow-hidden"
                      style={{
                        height:
                          reservedCuratedTextLines(
                            curatedView.systemPrompt.value ||
                              'Written by the flow'
                          ) * CURATED_TEXT_LINE_HEIGHT_PX,
                      }}
                    >
                      <p
                        className="text-xs text-neutral-400 whitespace-pre-wrap break-words"
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: reservedCuratedTextLines(
                            curatedView.systemPrompt.value ||
                              'Written by the flow'
                          ),
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {curatedView.systemPrompt.value ||
                          'Written by the flow'}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Tools it can use */}
              <div className="px-5 pt-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  <Layers className="h-3.5 w-3.5" />
                  Tools
                </div>
                <div className="mt-2 rounded-xl border border-neutral-700 bg-neutral-900/60 p-3">
                  {curatedView.allowedTools.length === 0 ? (
                    <p className="text-xs text-neutral-400">None</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {curatedView.allowedTools.map((toolName) => (
                        <span
                          key={toolName}
                          className="inline-flex items-center rounded-full border border-neutral-600 bg-neutral-800 px-2.5 py-0.5 text-[11px] text-neutral-200"
                        >
                          {toolName}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Memory sources (read-only) — labeled "Skills" for the user */}
              <div className="px-5 pt-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  <Info className="h-3.5 w-3.5" />
                  Skills
                </div>
                <div className="mt-2 rounded-xl border border-neutral-700 bg-neutral-900/60 p-3">
                  {curatedView.memorySources.length === 0 ? (
                    <p className="text-xs text-neutral-400">Off</p>
                  ) : (
                    <ul className="space-y-1">
                      {curatedView.memorySources.map((source) => (
                        <li key={source} className="text-xs text-neutral-200">
                          {source}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </>
          ) : null}

          {/* Advanced (closed by default): the full raw parameter editor kept
              as a power-user escape hatch for one release — slated for
              deletion once the curated view is validated (U1 deviation). */}
          <div className="px-5 py-4">
            <button
              type="button"
              onClick={() => setShowAdvanced((prev) => !prev)}
              className="flex items-center gap-1.5 text-[11px] font-medium text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform duration-200 ${
                  showAdvanced ? 'rotate-0' : '-rotate-90'
                }`}
              />
              Advanced
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-4">
                {/* Model Section - legacy dropdown for non-agent bubbles with a
                    model config (agents get the curated model control above) */}
                {modelConfig && curatedView.kind === 'tool' && (
                  <div>
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
                <div>
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

                {/* Credentials Section (raw types) */}
                <div>
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
                        const availableForType =
                          getCredentialsForType(credType);
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
                                selectedBubbleCredentials[credType] !==
                                  undefined &&
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
                                  {cred.name ||
                                    `${cred.credentialType} (${cred.id})`}
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
