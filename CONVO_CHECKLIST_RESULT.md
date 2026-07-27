# Studio conversation view + checklist result

## Status

DONE. Branch `feature/studio-convo-checklist`, based on 95b0ca7 (feature/mvp-oneshot), pushed to origin.

## Branch + commit

- Branch: `feature/studio-convo-checklist`
- Commit: see `git log -1` on the branch ("studio: conversation view + plain-language checklist replacing the code tab")
- Pushed: `origin/feature/studio-convo-checklist`

## Components added/changed

- `apps/bubble-studio/src/utils/flowChecklist.ts` (new) — derivation layer.
  - `parseConversationMessages` validates each `metadata.conversationMessages` entry with `CoffeeMessageSchema.safeParse` (one bad entry never drops the thread).
  - `deriveChecklistItems` builds checklist items from the parsed `workflow` via the same `extractStepGraph` the canvas uses (`utils/workflowToSteps.ts`), so checklist and visualizer describe identical steps; falls back to the approved plan's steps from the conversation when no workflow exists.
  - `deriveFlowSummary`, `humanizeToolName` ('ai-agent' -> 'AI Agent'), `humanizeFunctionName` ('queryRecentDeals' -> 'Query recent deals').
- `apps/bubble-studio/src/components/FlowConversationPanel.tsx` (new) — read-only chat view of the saved thread: user prompts right-aligned, clarification questions with their choices, answers echoed with question text (looked up from `originalQuestions` or the preceding request), the plan as summary + numbered steps + bubble chips, plan approval as a green pill, system/context/tool_result compact. Empty state: "No conversation saved for this flow".
- `apps/bubble-studio/src/components/FlowChecklistPanel.tsx` (new) — "What this flow does": plan-summary intro line, numbered checklist items with tool chips, "View code" link (top right) that switches to the demoted code view.
- `apps/bubble-studio/src/components/ConsolidatedSidePanel.tsx` — tab strip now Pearl / **Checklist** (replaces Code, `ListChecks` icon, badge = item count) / **Conversation** (`MessageSquare` icon, badge = message count) / Console / History / Setup. Checklist tab stays highlighted while the code sub-view is showing (`ConsolidatedSidePanel.tsx:96-101`). Monaco stays always-mounted (its `useEditor` contract) inside a hidden container that now carries a "Back to checklist" bar when active.
- `apps/bubble-studio/src/stores/uiStore.ts` — union widened to exported `ConsolidatedPanelTab` ('checklist' | 'conversation' added; 'code' kept as a valid id so `showEditorPanel()` from the visualizer's open-code affordances still works).
- Tests: `apps/bubble-studio/src/utils/flowChecklist.test.ts` (9 tests), `apps/bubble-studio/src/components/FlowPanels.mount.test.tsx` (4 mount tests), fixture `apps/bubble-studio/src/utils/__fixtures__/flow21.json` (live flow 21 capture).

## How the data flows into each component

- `GET /bubble-flow/:id` returns `metadata` (contains `conversationMessages`, written by `apps/bubblelab-api/src/services/conversation-thread.ts:47-57`) and `workflow` (`ParsedWorkflowSchema`), both already in `BubbleFlowDetailsResponse` (`packages/bubble-shared-schemas/src/bubbleflow-schema.ts:383-388`). No API change needed.
- `useBubbleFlow(flowId)` caches that response under `['bubbleFlow', flowId]`. Both panels call `useBubbleFlow(flowId)` directly; ConsolidatedSidePanel calls it once more for tab badges (same cache entry, no extra fetch).
- Conversation: `data.metadata` -> `parseConversationMessages` -> `CoffeeMessage[]` -> `FlowConversationPanel` renderers.
- Checklist: `data.workflow` -> `extractStepGraph(workflow, workflow.bubbles)` -> step `description ?? humanized functionName` + tool chips from each step's `bubbleIds` resolved in `workflow.bubbles`.

## tsc result

`pnpm --filter bubble-studio exec tsc --noEmit` clean (exit 0). `pnpm run build` (vite production build) also passes.

## How render was verified

No Playwright MCP server was available in this session, so rendering was verified with jsdom mount tests that exercise the app's own data path instead of a mocked one: the react-query cache is seeded at the exact key `['bubbleFlow', 21]` that `useBubbleFlow` reads, with a fixture captured live from `GET http://localhost:3001/bubble-flow/21`. `FlowPanels.mount.test.tsx` mounts both panels with `createRoot` and asserts on rendered DOM text (4/4 pass):

- Conversation panel shows the real prompt ("Every Friday"), the clarification round, the plan summary ("pull deals from your Notion database") and "You approved the plan".
- Checklist panel shows "Queries your Notion deals database", the AI-agent classification line, "Sends one Telegram message", tool chips "AI Agent"/"Telegram", and the "View code" link.
  Full studio suite: 185/185 tests pass across 12 files (was 172/172 across 10).

What flow 21 shows in the Checklist tab (verified by executing the derivation against the live capture):

> Summary: "Run every Friday at 17:00 UTC, pull deals from your Notion database edited in the last 7 days, use an AI agent to flag stalled deals and propose next steps from the notes, then send a formatted pipeline digest to your Telegram private chat."

1. Computes the ISO-8601 cutoff timestamp in UTC based on lookback_days.
2. Queries your Notion deals database using a recency-friendly sort and a configurable page size. [Notion]
3. Clamps a value to an integer between min and max.
4. Extracts deal title and notes text from Notion page properties and filters to pages edited after the cutoff.
5. Uses an AI agent to classify whether a deal looks stalled and propose actionable next steps. [AI Agent]
6. Builds one or more Telegram HTML messages, splitting when the digest would exceed safe length.
7. Sends one Telegram message using HTML formatting and disabled link previews for a compact digest. [Telegram]

Conversation tab for flows 21 and 22 shows the 6-message thread: user prompt -> clarification questions with choices -> the user's answers -> follow-up user message -> the plan (summary + 6 steps + bubble chips) -> "You approved the plan".

## Deviations

- "Replace the code tab" implemented as: Checklist takes the Code tab's slot; the raw code remains reachable via a "View code" link in the checklist and shows with a "Back to checklist" bar. `code` stays a valid (buttonless) tab id because the visualizer's `showEditorPanel()` jump-to-code affordances (`FlowVisualizer.tsx:1204` etc.) and Monaco's always-mounted `useEditor` contract depend on it. The Checklist tab stays highlighted while code shows so the strip never loses selection.
- Added a Conversation tab badge/derivation in ConsolidatedSidePanel via a second `useBubbleFlow` call — same react-query cache entry, so no extra network traffic.

## Learnings

- The tab strip lives in `ConsolidatedSidePanel.tsx`, NOT `FlowIDEView.tsx` (FlowIDEView owns the header/visualizer layout and mounts ConsolidatedSidePanel).
- Monaco must stay mounted even when hidden — `useEditor` holds the editor instance; the code container toggles `hidden`, never unmounts.
- `extractStepGraph` (`utils/workflowToSteps.ts`) already produces exactly the human-language step list needed: `function_call`/`transformation_function` nodes carry generation-time `description` sentences; function calls nested inside `for` loops become steps too. Reusing it keeps checklist and canvas consistent.
- `metadata` is typed `z.record(z.string(), z.unknown())` in `BubbleFlowDetailsResponse`; validating each conversation entry individually with `CoffeeMessageSchema.safeParse` gives typed messages with no casts and survives unknown message shapes.
- React 19 `act` in vitest/jsdom needs `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and mount tests can skip @testing-library entirely: `createRoot` + seeded `QueryClient` (setQueryData marks data fresh under useBubbleFlow's 5-min staleTime, so no fetch fires).
