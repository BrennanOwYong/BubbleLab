import { create } from 'zustand';

/**
 * UI Store - Global panel visibility and UI state
 *
 * Philosophy: Manages all UI chrome - panels, modals, indicators
 * Does NOT manage domain-specific state (execution, editor)
 * Navigation is now handled by TanStack Router
 */

/**
 * Tabs in the consolidated side panel. 'build' is the live chat with the
 * builder agent (the primary tab); 'checklist' is the plain-language view of
 * what the flow does. Raw code has no tab and is never displayed in the
 * flow editor.
 */
export type ConsolidatedPanelTab =
  | 'build'
  | 'checklist'
  | 'conversation'
  | 'output'
  | 'history'
  | 'setup';

interface UIStore {
  // ============= Panel State =============

  /**
   * Currently selected flow ID (which flow is being viewed/edited)
   * Used by execution/editor stores to track which flow is active
   */
  selectedFlowId: number | null;

  // ============= Panel Visibility State =============

  /**
   * Whether the Monaco editor is visible
   */
  showEditor: boolean;

  /**
   * Whether the left panel is visible (currently unused)
   */
  showLeftPanel: boolean;

  /**
   * Whether the sidebar (flow list) is open
   */
  isSidebarOpen: boolean;

  /**
   * Whether the output panel is collapsed
   */
  isOutputCollapsed: boolean;

  // ============= Consolidated Side Panel State =============

  /**
   * Whether the consolidated side panel is open
   */
  isConsolidatedPanelOpen: boolean;

  /**
   * Active tab in the consolidated side panel
   */
  consolidatedPanelTab: ConsolidatedPanelTab;

  // ============= Modal Visibility State =============

  /**
   * Whether the export modal is open
   */
  showExportModal: boolean;

  /**
   * Whether to show the flow's stored prompt info
   */
  showPrompt: boolean;

  /**
   * React Flow node id of the flow-visualizer node whose inline parameter
   * form is expanded. One node at a time: expanding a node collapses the
   * previously expanded one.
   */
  expandedFlowNodeId: string | null;

  // ============= Actions =============

  /**
   * Select a flow (changes what's shown in the IDE)
   */
  selectFlow: (flowId: number | null) => void;

  /**
   * Toggle a flow-visualizer node's inline parameter form. Passing the id of
   * the currently expanded node collapses it; passing another id moves the
   * expansion there.
   */
  toggleExpandedFlowNode: (nodeId: string) => void;

  /**
   * Collapse any expanded flow-visualizer node (pass null) or expand a
   * specific one.
   */
  setExpandedFlowNode: (nodeId: string | null) => void;

  /**
   * Toggle editor visibility
   */
  toggleEditor: () => void;

  /**
   * Toggle sidebar visibility
   */
  toggleSidebar: () => void;

  /**
   * Open the sidebar
   */
  openSidebar: () => void;

  /**
   * Close the sidebar
   */
  closeSidebar: () => void;

  /**
   * Collapse the output panel
   */
  collapseOutput: () => void;

  /**
   * Expand the output panel
   */
  expandOutput: () => void;

  /**
   * Toggle export modal
   */
  toggleExportModal: () => void;

  /**
   * Open export modal
   */
  openExportModal: () => void;

  /**
   * Close export modal
   */
  closeExportModal: () => void;

  /**
   * Toggle prompt display
   */
  togglePrompt: () => void;

  // ============= Consolidated Panel Actions =============

  /**
   * Set the active tab in the consolidated side panel
   */
  setConsolidatedPanelTab: (tab: ConsolidatedPanelTab) => void;

  /**
   * Open the consolidated side panel with a specific tab
   */
  openConsolidatedPanelWith: (tab: ConsolidatedPanelTab) => void;

  /**
   * Toggle the consolidated side panel visibility
   */
  toggleConsolidatedPanel: () => void;

  /**
   * Close the consolidated side panel
   */
  closeConsolidatedPanel: () => void;
}

/**
 * Zustand store for UI state
 */
export const useUIStore = create<UIStore>((set) => ({
  // Initial state
  selectedFlowId: null,
  showEditor: false,
  showLeftPanel: false,
  isSidebarOpen: false,
  isOutputCollapsed: true,
  showExportModal: false,
  showPrompt: false,
  isConsolidatedPanelOpen: true,
  consolidatedPanelTab: 'build',
  expandedFlowNodeId: null,

  // Actions
  selectFlow: (flowId) =>
    set({
      selectedFlowId: flowId,
      showEditor: false,
      expandedFlowNodeId: null,
    }),

  toggleExpandedFlowNode: (nodeId) =>
    set((state) => ({
      expandedFlowNodeId: state.expandedFlowNodeId === nodeId ? null : nodeId,
    })),

  setExpandedFlowNode: (nodeId) => set({ expandedFlowNodeId: nodeId }),

  // If sidebar is open AND trying to open editor, close sidebar
  toggleEditor: () =>
    set((state) => {
      if (state.isSidebarOpen && !state.showEditor) {
        return { showEditor: !state.showEditor, isSidebarOpen: false };
      }
      return { showEditor: !state.showEditor };
    }),

  toggleSidebar: () =>
    set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),

  openSidebar: () => set({ isSidebarOpen: true }),

  closeSidebar: () => set({ isSidebarOpen: false }),

  collapseOutput: () => set({ isOutputCollapsed: true }),

  expandOutput: () => set({ isOutputCollapsed: false }),

  toggleExportModal: () =>
    set((state) => ({ showExportModal: !state.showExportModal })),

  openExportModal: () => set({ showExportModal: true }),

  closeExportModal: () => set({ showExportModal: false }),

  togglePrompt: () => set((state) => ({ showPrompt: !state.showPrompt })),

  // Consolidated panel actions
  setConsolidatedPanelTab: (tab) => set({ consolidatedPanelTab: tab }),

  openConsolidatedPanelWith: (tab) =>
    set({
      isConsolidatedPanelOpen: true,
      consolidatedPanelTab: tab,
    }),

  toggleConsolidatedPanel: () =>
    set((state) => ({
      isConsolidatedPanelOpen: !state.isConsolidatedPanelOpen,
    })),

  closeConsolidatedPanel: () => set({ isConsolidatedPanelOpen: false }),
}));

// ============= Derived Selectors =============

/**
 * Check if a flow is selected
 */
export const selectHasSelectedFlow = (state: UIStore): boolean =>
  state.selectedFlowId !== null;
