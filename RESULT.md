# RESULT — FlowVisualizer reskin (static LR flowchart, expandable plate nodes)

- **Status**: complete (reskin + three follow-up additions)
- **Branch**: `feature/flowvisualizer-reskin` (pushed to origin)
- **Commits**: `644c799` (reskin), plus the follow-up commit for additions 6–8 below (kill code view / checklist fix / descriptive edges)
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

### 6. Code view killed everywhere (addition)

- `ConsolidatedSidePanel.tsx`: the `activeTab === 'code'` sub-view (Monaco under the Checklist tab, with "Back to checklist" header) is removed. **Monaco stays mounted but permanently hidden** (`<div className="hidden" aria-hidden>`): `useEditor` reads/writes flow code through the live editor instance (`getEditorCode()`/`setEditorCode()` in `hooks/useEditor.ts` use `editorStore.editorInstance`), so param editing, validation, and cron updates need the instance to exist even though nothing can display it. The checklist-tab highlight special-case for `'code'` and the line-count `useEditor` usage are gone.
- `stores/uiStore.ts`: `'code'` removed from `ConsolidatedPanelTab`; `showEditorPanel` (the only writer of `consolidatedPanelTab: 'code'`) removed — its former callers were the node/param code affordances already deleted in requirement 5, so nothing referenced it.
- `FlowChecklistPanel.tsx`: "View code" link removed from both the header and the empty state; the panel no longer touches `uiStore`.
- Net: no button, no tab, no sub-view — no way to display raw code in the flow editor. Verified by grep: zero remaining `setConsolidatedPanelTab('code')` / `consolidatedPanelTab: 'code'` / `showEditorPanel` references.

### 7. Checklist data fixed (addition)

Compared `deriveChecklistSections` output against live flows `GET /bubble-flow/9` (Gmail overseas-opportunity alert) and `/12` (Notion pipeline digest) from the API at :3001. The step list itself matched the flows' real steps 1:1 (the derivation reuses `extractStepGraph`, same as the canvas); the wrong data was in the plain-language rewriter (`utils/flowChecklist.ts` `PLAIN_REPLACEMENTS`/`toPlainLanguage`), which mangled real step descriptions into false or broken lines:

- **"Sends the digest message to Telegram using read mode"** — factually wrong. "HTML parse mode" was shredded by the `HTML ` strip + `parse`→`read` rules. Fix: compound rules `HTML parse mode`→`formatted text` and `parse mode`→`formatting` ordered before the generic rules. Now reads "using formatted text".
- **"Builds a Gmail search look up that targets…"** — broken grammar. `query`→`look up` replaced noun uses. Fix: `search query`→`search` compound first, then `query`→`search` / `queries`→`searches` (noun-safe); `VERB_MAP` gains `query: 'looks up'` so function-name-derived lines stay third-person ("Looks up recent deals").
- **"Computes the [since, until] window…"** — bracketed code aside leaked through. Fix: strip square-bracketed asides.
- **"deals edited since since iso"** — camelCase spacing of `sinceIso` duplicated "since". Fix: collapse immediate word repeats after identifier spacing. (Residue "since iso" remains — the identifier itself carries no plain-language meaning to recover.)

Also documented (not a bug fixed): flow 9's "What you need to provide" is empty because its inputSchema marks nothing `required` (all fields carry defaults, including a placeholder `telegramChatId` default) — the checklist is faithful to the schema. Regression coverage: 4 new unit tests in `flowChecklist.test.ts`; two existing assertions updated to the new wording (`'Look up recent deals'`→`'Looks up recent deals'`, mount test `'Looks up your Notion deals database'`→`'Searches…'`, and the mount test now asserts "View code" is absent).

### 8. Descriptive edges incl. conditional (addition)

What the data exposes: `extractStepGraph` (utils/workflowToSteps.ts) already emits per-edge `edgeType: 'sequential' | 'conditional'` and a `label` built from the workflow's control-flow nodes — `"if <raw JS condition>"`, `"else if <condition>"`, `"else"` (the backend's parsed workflow carries the raw condition text on `if` nodes). FlowVisualizer previously threw this away behind a hardcoded `SHOW_EDGE_LABELS = false`.

Implemented in FlowVisualizer + `humanizeConditionLabel` (exported from flowChecklist.ts, unit-tested):

- Sequential spine edges stay unlabeled, subtle gray dashes — left→right flow needs no caption.
- Conditional branch edges are **amber** (distinct from the gray spine and the green executed path) and **always labeled** with a plain-language condition: raw JS is rewritten (`X === true`→`X`, `X === false`→`not X`, `!== null`→`exists`, `>=`→`at least`, `&&`→`and`, `.length`→`count`, object paths collapsed to the last segment, camelCase/snake_case spaced, 46-char truncation), so `else`→"otherwise", `if aiResult.isMatch === true`→"if match", `else if retryCount >= maxRetries`→"or if retry count at least max retries". A conditional edge with no label (shouldn't occur) falls back to "condition".
- Execution highlighting is preserved: an executed conditional edge turns solid green with a green label, so the taken branch is visible during runs.
- Limitation noted: the two probed live flows are fully sequential (their if/else lives inside step bodies, which the step graph models as within-step logic, not step-level branches), so conditional labels appear only on flows whose branching happens between steps — that is exactly what the step graph encodes; nothing further is exposed by the current data.

## Dependent files mapped (before refactor)

- `BubbleDetailsOverlay` — imported only by `nodes/BubbleNode.tsx` → orphaned → deleted.
- `useOverlay` — imported only by `BubbleDetailsOverlay` → deleted.
- `param-editors/*` — imported by `BubbleDetailsOverlay` (deleted), `BubbleNode` (now direct), each other, and the `param-editors/index.ts` barrel (still valid).
- Node components (`BubbleNode`, `InputSchemaNode`, `CronScheduleNode`, `ServiceTriggerNode`, `StepContainerNode`, `TransformationNode`) — imported only by `FlowVisualizer.tsx` (`nodeTypes`).
- `FlowVisualizer` — imported by `FlowIDEView.tsx` (props unchanged, untouched).
- `getAllInlineParamConfigs` — imported only by `BubbleNode` → orphaned → deleted from config.
- `uiStore` — widely imported; only additive changes.

## Verification

- **tsc**: `pnpm --filter bubble-studio exec tsc --noEmit` → clean (0 errors) after the reskin AND after additions 6–8.
- **build**: `pnpm --filter bubble-studio run build` → ✓ (pre-existing chunk-size warning only) after both rounds.
- **tests (after additions)**: 13 files, **203 tests, all passed** — 199 original + 4 new (`toPlainLanguage` noun/parse-mode/bracket/duplicate fixes, `humanizeConditionLabel`). Updated assertions: `flowChecklist.test.ts` `'Look up recent deals'`→`'Looks up recent deals'`; `FlowPanels.mount.test.tsx` `'Looks up your Notion deals database'`→`'Searches…'` and `'View code'` now asserted ABSENT (was asserted present).
- **live-data check**: checklist derivation re-run against `GET /bubble-flow/9` and `/12` from the live API — every outcome line now factually matches the flow's real steps (probe output in section 7).
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
