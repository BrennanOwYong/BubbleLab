# RESULT — feature/delete-studio-generation

Status: complete. Studio is VIEW / RUN / EDIT-only; the in-app flow generation UI (Coffee/Boba prompt→plan→build) is deleted. tsc exit 0, vite build success, 203/203 unit tests pass.

## Dependent map (grep-mapped before deletion)

| Deleted module                                                                                                                                                              | Importers found                                                                                                     | Resolution                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| hooks/usePearlStream.ts                                                                                                                                                     | PearlChat, usePearlChatStore                                                                                        | both deleted                                                                                                           |
| hooks/usePearlChatStore.ts                                                                                                                                                  | PearlChat, LiveOutput, AllEventsView, usePearlStream                                                                | LiveOutput/AllEventsView edited (Fix-with-Gluu CTAs removed), rest deleted                                             |
| stores/pearlChatStore.ts                                                                                                                                                    | PearlChat, usePearlChatStore, usePearlStream, FlowVisualizer                                                        | FlowVisualizer edited (node-click context wiring removed), rest deleted                                                |
| stores/generationStore.ts                                                                                                                                                   | routes/flows, routes/home, FlowIDEView, GenerationOutputOverlay, usePromptFromURL, useFlowGeneration, DashboardPage | all edited or deleted                                                                                                  |
| components/ai/PearlChat.tsx                                                                                                                                                 | BubbleSidePanel, ConsolidatedSidePanel                                                                              | BubbleSidePanel deleted (unreachable, see below), ConsolidatedSidePanel edited                                         |
| components/ai/\* widgets (PlanApproval, Clarification, ContextRequest, BubblePromptInput, CodeDiffView, VoiceRecorder, MarkdownWithBubbles, BubbleTag, BubbleText, type.ts) | PearlChat only, except VoiceRecorder (also DashboardPage) and BubbleTag (internal ai/)                              | whole `src/components/ai/` directory deleted; MarkdownWithBubbles/BubbleTag/BubbleText had NO surviving-view importers |
| hooks/useFlowGeneration.ts                                                                                                                                                  | routes/home, usePromptFromURL                                                                                       | deleted                                                                                                                |
| hooks/usePromptFromURL.ts                                                                                                                                                   | routes/home                                                                                                         | deleted                                                                                                                |
| hooks/useMilkTea.ts                                                                                                                                                         | BubbleSidePanel                                                                                                     | deleted                                                                                                                |
| components/GenerationOutputOverlay.tsx                                                                                                                                      | DashboardPage                                                                                                       | deleted                                                                                                                |
| pages/DashboardPage.tsx                                                                                                                                                     | routes/home                                                                                                         | deleted; /home rewritten as auth landing                                                                               |
| stores/outputStore.ts                                                                                                                                                       | DashboardPage, useFlowGeneration, GenerationOutputOverlay, routes/flows                                             | deleted; flows.tsx delete-error output swapped to toast.error                                                          |

BubbleSidePanel was unreachable: its open actions (openBubbleListPanel/selectBubble/openPearlChat) had zero external callers; sidePanelMode started 'closed' and nothing set it. Deleted together with its mount in `routes/__root.tsx`.

## Files deleted

- `src/components/ai/` (entire directory: PearlChat, PlanApprovalWidget, ClarificationWidget, ContextRequestWidget, BubblePromptInput, CodeDiffView, VoiceRecorder, MarkdownWithBubbles, BubbleTag, BubbleText, type.ts)
- `src/components/BubbleSidePanel.tsx`, `GenerationOutputOverlay.tsx`, `FlowGeneration.tsx` (pre-existing orphan), `TypewriterMarkdown.tsx`, `SubmitTemplateModal.tsx`, `OnboardingQuestionnaire.tsx`, `shared/MarkdownComponents.tsx`
- `src/components/templates/` (templateLoader + all template_codes; only generation consumed them)
- `src/pages/DashboardPage.tsx`
- `src/hooks/usePearlStream.ts`, `usePearlChatStore.ts`, `usePromptFromURL.ts`, `useFlowGeneration.ts`, `useMilkTea.ts`, `useBubbleDetail.ts`
- `src/stores/generationStore.ts`, `pearlChatStore.ts`, `outputStore.ts`
- `src/utils/pearlConversation.ts`, `soundUtils.ts`, `bubbleTagParser.ts`, `sseStream.ts` (each had only generation-file importers at HEAD)
- Dead code removed inside surviving files: `getCodeContextForPearl`/`getCodeContextForMilkTea` (utils/editorContext.ts), `trackWorkflowGeneration`/`trackTemplate`/`trackAIAssistant` (services/analytics.ts), the no-op "Retry Generation" button and the Fix/Explain-with-Gluu banners (FlowVisualizer, AllEventsView, EvaluationIssuePopup).

## Shared-schemas imports removed (coordination with backend lane)

Every import of a Coffee/generation type from `@bubblelab/shared-schemas` is gone. Removed, per file (files deleted unless noted):

- `components/ai/type.ts`: ClarificationQuestion, CoffeePlanEvent, CoffeeRequestExternalContextEvent, CoffeeContextAnswer
- `components/ai/PlanApprovalWidget.tsx`: CoffeePlanEvent
- `components/ai/ClarificationWidget.tsx`: ClarificationQuestion
- `components/ai/ContextRequestWidget.tsx`: CoffeeRequestExternalContextEvent
- `hooks/usePearlChatStore.ts`: ClarificationQuestion, CoffeePlanEvent, CoffeeRequestExternalContextEvent, StreamingEvent, PEARL_DEFAULT_MODEL
- `hooks/usePearlStream.ts`: PearlRequest, PearlResponse, StreamingEvent
- `hooks/useMilkTea.ts`: MilkTeaRequest, MilkTeaResponse
- `stores/generationStore.ts`: GenerationResult
- `utils/flowChecklist.ts` (edited, kept): CoffeeMessageSchema, CoffeeMessage, PlanMessage → replaced
- `components/FlowConversationPanel.tsx` (edited, kept): ClarificationQuestion, CoffeeMessage → replaced

Replacement: new `src/types/conversation.ts` holds a local, lenient zod copy of ONLY the persisted-message shapes the surviving read-only views need (ConversationMessageSchema union, ClarificationQuestion, PlanMessage). The studio no longer depends on any coffee.ts export; backend lane can delete `packages/bubble-shared-schemas/src/coffee.ts` without breaking the studio. Verified by import-scan: zero coffee-module names in any `@bubblelab/shared-schemas` import. Kept shared-schemas imports are execution/flow types only (StreamingLogEvent, ParsedWorkflow, ParsedBubbleWithInfo, CredentialType, BubbleFlowDetailsResponse, ...).

## Conversation-tab decision

KEPT. FlowConversationPanel already renders a graceful empty state when a flow has no conversationMessages ("No conversation saved for this flow"), and existing flows keep a valuable build-history view. Its type dependency moved to the local `src/types/conversation.ts`, so it survives the shared-schemas Coffee deletion. This was the lower-risk option: removal would also have forced Checklist changes (shared `parseConversationThread`).

Checklist plan-fallback also kept: `deriveChecklistItems` still falls back to the approved plan in conversationMessages when a flow's workflow graph is empty, using the local PlanMessage type.

## Default panel tab

`checklist`. `ConsolidatedPanelTab` type no longer contains 'pearl'; uiStore default `consolidatedPanelTab: 'checklist'`. Tabs now: Checklist, Conversation, Console (output), History, Setup. The always-mounted hidden Monaco instance in ConsolidatedSidePanel is untouched (useEditor needs it for param editing/validation).

## Entry-point removals

- `/home`: rewritten as auth landing. Signed-in → redirect to `/flows`; signed-out → SignInModal. No prompt box, no templates, no "start from scratch", no `?prompt=` handling. `?showSignIn`/`?ref` (affiliate tracking) kept because `/flows` and `/flow/$flowId` redirect there.
- `/` index: redirects to `/home` with `ref` only (prompt param dropped).
- `/flows`: generation-streaming navigation locks removed; HomePage "New Flow" button removed; empty state now "Flows built for you will appear here". Flow open/rename/duplicate/delete, Cron/Webhook toggles, usage bar all kept.
- FlowIDEView: generationStore removed; header/run/export no longer gated on isStreaming; prompt header shows only the flow's stored prompt. Run-disabled reason for empty bubbleParameters reworded to "Flow has no steps yet".
- FlowVisualizer: node clicks now only highlight (no add-to-Gluu-context, no panel-open to chat); pane click clears highlight. Empty-code overlay kept (reworded "This flow is still being built") for flows the external agent has not finished.

## Verification

- `tsc --noEmit`: exit 0 (required building `@bubblelab/shared-schemas` and `@bubblelab/bubble-core` dist first in this fresh clone).
- `vite build` (`pnpm --filter bubble-studio run build`): success.
- Test suite (`vitest run`, integration-excluded): 13 files, 203/203 pass. No generation-UI tests existed to delete; FlowPanels.mount.test.tsx (Conversation + Checklist against real flow-21 fixture) passes against the local conversation types — the fixture thread (prompts, clarification Q&A, plan, approval, workflow-done messages) parses identically.
- Import scan: zero `Coffee*`/`ClarificationQuestion`/`PlanMessage` names in shared-schemas imports; zero references to deleted modules.
- Rendered behavior (from code paths + mount tests, no live smoke run in this environment): `/flows` lists flows with search/rename/duplicate/delete; opening a flow shows the reskinned canvas beside the panel opening on Checklist; Console/History/Setup tabs and the Run/Export buttons work unchanged (useRunExecution untouched); no prompt box, plan-approval widget, or Gluu chat exists anywhere — the strings/components are deleted from the bundle.

## Generation-adjacent code KEPT (with reason)

- `src/types/conversation.ts` (new): read-only rendering of persisted generation threads; the data outlives the generator.
- `flowChecklist.ts` conversation parsing: Checklist tab fallback + Conversation tab both consume it.
- `GeneratingOverlay` + `generationError` state in FlowVisualizer: flows written by the external agent can still arrive with empty code or a stored generationError; these are display-only.
- `stores/editorStore.ts` `sidePanelMode`/`selectedBubbleName`/`targetInsertLine` fields: pre-existing dead-ish state, but `useEditor.insertCodeAtLine` (kept, part of the editor surface) reads `targetInsertLine`. Left untouched to avoid destabilizing useEditor; flagged as future cleanup.
- `useCreateBubbleFlow`: kept — `useDuplicateFlow` (Duplicate Flow menu item) and HomePage's optimistic-list type depend on it. Duplication copies an existing flow; it does not generate.
- SignInModal, useAffiliateTracking: reused by the new `/home` landing.

## Environment learnings

- Fresh clone needed `pnpm install` + building shared-schemas and bubble-core dists before studio tsc/build would run (studio build script copies `bubble-core/dist/bubble-bundle.d.ts` and `bubbles.json` into public/).
- `pnpm --filter bubble-studio exec vitest run --exclude='**/*.integration.test.{ts,tsx,js,jsx}'` mirrors the package test script without watch mode.
