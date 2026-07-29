# RESULT — FlowVisualizer reskin (static LR flowchart, expandable plate nodes)

- **Status**: complete
- **Branch**: `feature/flowvisualizer-reskin` (pushed to origin)
- **Commit**: `644c799` — "studio: reskin flow editor into static LR flowchart of expandable name-plate nodes"
- **Scope**: `apps/bubble-studio` only; no backend changes.

## Files changed

- `src/components/flow_visualizer/FlowVisualizer.tsx` — draggable/connectable off, LR layout, expansion reflow, dead callback props removed
- `src/components/flow_visualizer/flowLayoutConstants.ts` — HIERARCHICAL transposed to `COLUMN_SPACING`/`BRANCH_VERTICAL_GAP`; new `EXPANDED.PANEL_HEIGHT` (420) and `EXPANDED.PLATE_HEIGHT` (64)
- `src/components/flow_visualizer/stepContainerUtils.ts` — `BUBBLE_HEIGHT` 280 → 72 (compact plate slot)
- `src/components/flow_visualizer/nodes/BubbleNode.tsx` — rewritten: name plate + inline expandable form
- `src/components/flow_visualizer/nodes/StepContainerNode.tsx` — 28px radius; grows by `PANEL_HEIGHT` when it contains the expanded plate
- `src/components/flow_visualizer/nodes/TransformationNode.tsx` — View Code button and `onTransformationClick` removed; radius
- `src/components/flow_visualizer/nodes/InputSchemaNode.tsx`, `ServiceTriggerNode.tsx`, `CronScheduleNode.tsx` — radius only
- `src/components/flow_visualizer/param-editors/{SchemaParamsSection,SchemaParamEditor,ParamEditor,DiscriminatedUnionEditor}.tsx` — per-param "View Code" links and `onParamEditInCode` plumbing removed
- `src/stores/uiStore.ts` — `expandedFlowNodeId` + `toggleExpandedFlowNode`/`setExpandedFlowNode`; `selectFlow` clears it
- `src/config/bubbleInlineParams.ts` — `getAllInlineParamConfigs` removed (orphaned), header comment updated
- `src/pages/CredentialsPage.tsx` — comment reference to deleted overlay updated
- **Deleted**: `src/components/flow_visualizer/BubbleDetailsOverlay.tsx`, `src/hooks/useOverlay.ts` (orphaned after the popup removal)

## Requirement implementation

### 1. Nodes not movable

`nodesDraggable={false}` and `nodesConnectable={false}` on the `<ReactFlow>` canvas (FlowVisualizer.tsx ~2712); every node the code creates now sets `draggable: false` (8 sites). Pan (`panOnDrag`), scroll/pinch zoom, and `<Controls showInteractive={false}>` untouched. `elementsSelectable` stays true, so nodes remain clickable. The `extent` drag-constraint on in-container plates was removed as dead code.

### 2. Node shape — MRT name-plate

All node outer containers use `rounded-[28px]`. BubbleNode collapsed to a fixed 64px-tall horizontal plate (`FLOW_LAYOUT.EXPANDED.PLATE_HEIGHT`): logo, variable name, status/error/missing badges, docs link, sub-bubble toggle, expand chevron. 28px on a 64px plate = 44% of height — deep rounded ends without the full-pill 50%. Step containers, transformation nodes, and the three entry nodes carry the same 28px radius (header bars `rounded-t-[28px]`). Existing Gluu/neutral palette and `BUBBLE_COLORS` state styling kept.

### 3. Layout — left to right with vertical branch fan-out

The layout mechanism found: **no dagre/elk** — two hand-rolled paths in `FlowVisualizer.initialNodesAndEdges()`:

- **Sequential fallback** (no workflow / unparsed bubbles / step-main): already horizontal (`x = START_X + index * HORIZONTAL_SPACING`); kept, edges already `right` → `left`.
- **Step-based** `calculateHierarchicalLayout()`: was top-to-bottom (children below parents, branches spread on x). Transposed: x advances one column per step (`x + STEP_CONTAINER_LAYOUT.WIDTH + COLUMN_SPACING`), sibling branches stack vertically centered on the parent's vertical center (offsets from real step heights via `heightMap`, so tall containers don't collide), roots stack vertically, subtree bottom is threaded back so siblings clear each other. The convergence-point post-process was transposed the same way: a step with multiple parents lands in the column right of its right-most parent, vertically centered between the parents' centers.
- Step-to-step edges (and their handle marks) switched from `bottom`→`top` to `right`→`left`; entry→first-step already `right`→`left`. Within-step plate-to-plate edges stay vertical (`bottom`→`top`) — that's the stack inside a container, not the spine. Dependency-graph sub-bubble trees and custom-tool containers keep hanging below their parent (`bottom`→`top`), which is the vertical fan-off-the-spine reading.

### 4. Click-to-expand inline (popup replaced)

- `BubbleDetailsOverlay` (the fixed side popup) is deleted. Its content — bubble-name chip + description, Model section (dropdown when editable / read-only + "Dynamic" chip via `getModelParamConfig`/`extractParamValue`), Parameters (`SchemaParamsSection`, i.e. the same `SchemaParamEditor`/`DiscriminatedUnionEditor`/legacy `ParamEditor` chain with the real-value-not-placeholder behavior untouched), Credentials (per-type selects incl. "Use system default", required `*`, "+ Add New Credential…" → `CreateCredentialModal` with the bind-to-all-steps + telemetry logic preserved) — now renders inside the node, below the plate.
- Expansion identity: `useNodeId()` compared against `uiStore.expandedFlowNodeId`. Plate click toggles; clicking another node's plate moves the expansion (one at a time); pane click collapses. Clicks inside the form `stopPropagation` so editing never collapses the node.
- The panel is a **fixed 420px scrollable region** (`nowheel` so scrolling doesn't zoom the canvas). Fixed, not content-sized, because the layout reserves exactly `PANEL_HEIGHT` and sequential nodes anchor at their vertical center — deterministic reflow beats measuring.
- Reflow: sequential layout shifts the expanded node's center down `PANEL_HEIGHT / 2` (top edge stays on the spine; left/right handles pinned at plate mid-height 32px so spine edges stay horizontal). Step layout: plates after the expanded one inside a container shift down `PANEL_HEIGHT`, `StepContainerNode` grows by the same amount, and `calculateStepHeight` feeds the grown height into the LR layout so downstream columns/branches clear it. Expansion changes are treated as a structure change in the node/edge sync effect, so positions rebuild wholesale (position persistence is drag-only and dragging is off).

### 5. "Show Code" removed

Removed: the overlay's View Code/Focus Code button (gone with the overlay), BubbleNode's header code icon + its click-through to `showEditorPanel`, TransformationNode's View Code button, and every per-param "View Code" link in the param editors (`onParamEditInCode` stripped end-to-end; the FlowVisualizer callbacks that fed it are deleted). The canvas-level `onNodeClick` Pearl-context/highlight behavior is untouched, and the code tab elsewhere in the studio is untouched.

## Dependent files mapped (before refactor)

- `BubbleDetailsOverlay` — imported only by `nodes/BubbleNode.tsx` → orphaned → deleted.
- `useOverlay` — imported only by `BubbleDetailsOverlay` → deleted.
- `param-editors/*` — imported by `BubbleDetailsOverlay` (deleted), `BubbleNode` (now direct), each other, and the `param-editors/index.ts` barrel (still valid).
- Node components (`BubbleNode`, `InputSchemaNode`, `CronScheduleNode`, `ServiceTriggerNode`, `StepContainerNode`, `TransformationNode`) — imported only by `FlowVisualizer.tsx` (`nodeTypes`).
- `FlowVisualizer` — imported by `FlowIDEView.tsx` (props unchanged, untouched).
- `getAllInlineParamConfigs` — imported only by `BubbleNode` → orphaned → deleted from config.
- `uiStore` — widely imported; only additive changes.

## Verification

- **tsc**: `pnpm --filter bubble-studio exec tsc --noEmit` → clean (0 errors).
- **build**: `pnpm --filter bubble-studio run build` → `✓ built in 1m 4s` (pre-existing chunk-size warning only).
- **tests**: `pnpm --filter bubble-studio test` → **13 files, 199 tests, all passed**. No test asserted the old popup or draggable behavior, so none needed updating (the suite excludes `*.integration.test.*`; `flowvisualizer.integration.test.ts` tests `extractStepGraph` against a live API and is untouched by this UI change).
- **Described behavior** (from the implemented code paths): nodes ignore drag (canvas + per-node flags off) while pan/zoom and the zoom controls work; steps march left→right with branch steps fanned vertically off the spine and conditional edges entering on the left edge; clicking a plate grows it 420px downward revealing the model/params/credentials form, sibling plates and the surrounding container/columns shift to make room, clicking again or elsewhere collapses it; no code button or per-param View Code link exists anywhere in the node/param UI.

## Couldn't move inline cleanly / deviations

- **Per-param "View Code" jump** (`onParamEditInCode`): a code affordance, so removed per requirement 5 rather than relocated — read-only ("Dynamic"/"Read-only") params now display their value with no jump-to-editor shortcut from the node UI. Editing them still works via the code tab elsewhere.
- **Line-number display** from the overlay header (Lines X:Y) dropped — code-adjacent metadata with the code affordance gone.
- **`BubbleInlineParams`** (model dropdown / prompt preview on the old always-tall card) removed rather than kept on the plate: the full inline form supersedes it and the plate must stay compact. The Model section survives inside the expanded form.
- **Sub-bubble (dependency-graph) nodes** are expandable too, but their tree layout (`nodePositioning.ts`) does not reserve panel space — an expanded sub-bubble form can overlap a deeper sub-bubble (they only render during execution or via the layers toggle, and they carry no parameters, so the form is short). The primary step-based layout reflows fully.
- **Sequential fallback layout** reflows nothing horizontally on expansion (nothing sits below the spine), which is sufficient there.
- Radius is 28px (~44% of plate height), per the "almost pill, not 9999px" spec.

## Learnings

- Fresh clone: `pnpm install` then build `@bubblelab/shared-schemas` and `@bubblelab/bubble-core` before studio tsc/build (`tsc` resolves `@bubblelab/shared-schemas` from `dist`; studio build copies `bubble-core/dist/bubbles.json`).
- The repo's pre-commit hook (lint-staged/prettier via `commit-workflow.sh`) reformats staged files — cosmetic only here.
- Node position persistence (`persistedPositions`) is populated exclusively by drag `position` changes, so with dragging off it is inert and layout recomputes are authoritative.
