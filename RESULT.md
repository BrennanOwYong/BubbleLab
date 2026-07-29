# RESULT: delete Coffee/Boba generation pipeline from the API

Status: complete. Branch `feature/delete-coffee-boba-backend`, pushed to origin.

## Files deleted

apps/bubblelab-api:

- `src/services/ai/coffee.ts` (Coffee planner)
- `src/services/ai/boba.ts` (Boba wrapper)
- `src/services/ai/boba.test.ts`
- `src/services/ai/bubbleflow-generator.workflow.ts` (codegen workflow)
- `src/services/ai/code-generation-stream.ts` (zero importers before deletion)
- `src/services/ai/one-shot-generation.test.ts`
- `src/services/conversation-thread.ts` (all 4 exports served only the generate route)
- `src/services/setup-provisioning.ts`
- `src/services/setup-provisioning.test.ts`
- `src/routes/bubble-flows-conversation-persistence.test.ts` (tested the generate route)
- `src/routes/bubble-flows-generate-done-message.test.ts` (tested the generate route)

packages/bubble-shared-schemas:

- `src/coffee.ts` (entire file: all Coffee*/Clarification*/SetupResource*/SetupFieldDescriptor*/PlanStep/WorkflowDoneMessage/SystemMessage/ConversationEntry schemas + COFFEE\_\* constants + isCoffeeMessage/isWorkflowDoneMessage)

`coffee.test.ts` named in the brief does not exist in this repo; the Coffee tests lived in the two route test files above.

## Edits

- `apps/bubblelab-api/src/routes/bubble-flows.ts`: removed the whole `generateBubbleFlowCodeRoute` handler (was lines 1498–2006, 512 lines) and its imports (runCoffee, runBoba, conversation-thread block, setup-provisioning block, CoffeeResponse/WorkflowDoneMessage/isCoffeeMessage). Removed imports orphaned by the handler deletion: `ServiceUsage`, `StreamingEvent`, `trackServiceUsages`, `posthog`, `BubbleResult`, `getFlowNameFromCode`, `CredentialType`, `ValidationResult`. `runContextFlowRoute` handler kept intact, comment reworded (external agents, not Coffee).
- `apps/bubblelab-api/src/schemas/bubble-flows.ts`: removed `generateBubbleFlowPhaseSchema` + `generateBubbleFlowCodeRoute` + the `generateBubbleFlowCodeSchema` import. `runContextFlowSchema`/`runContextFlowResponseSchema`/`runContextFlowRoute` kept; descriptions reworded to drop Coffee.
- `packages/bubble-shared-schemas/src/index.ts`: dropped `export * from './coffee.js'`.
- `packages/bubble-shared-schemas/src/streaming-events.ts`: removed the coffee.js type import and the five `coffee_*` StreamingEvent union variants (`coffee_clarification`, `coffee_context_gathering`, `coffee_request_context`, `coffee_plan`, `coffee_complete`). Only coffee.ts emitted them.
- `packages/bubble-shared-schemas/src/generate-bubbleflow-schema.ts`: removed `generateBubbleFlowCodeSchema`, `generateBubbleFlowCodeResponseSchema`, `GenerationResultSchema`, types `GenerateBubbleFlowCodeResponse`/`GenerationResult`, and now-unused imports (`ParsedBubbleWithInfoSchema`, `ServiceUsageSchema`, `ConversationEntrySchema`). Template schemas (`generateBubbleFlowTemplateSchema`, `generateDocumentGenerationTemplateSchema`, `bubbleFlowTemplateResponseSchema`) kept — `routes/bubble-flow-templates.ts` imports them.
- `packages/bubble-shared-schemas/src/pearl.ts`: comment referenced deleted `COFFEE_DEFAULT_MODEL`; reworded (constant was never imported there).
- `apps/bubblelab-api/src/services/ai/rice.ts`: comment-only edit dropping Coffee from the agent list.

## Dependent map (built before deleting)

| Module                                            | Importers found                                                                                                                                        | Disposition                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| ai/coffee.ts                                      | routes/bubble-flows.ts, bubble-flows-conversation-persistence.test.ts                                                                                  | both handled (route edited, test deleted) |
| ai/boba.ts                                        | routes/bubble-flows.ts, both route test files, code-generation-stream.ts                                                                               | all deleted/edited                        |
| bubbleflow-generator.workflow.ts                  | boba.ts, one-shot-generation.test.ts                                                                                                                   | both deleted                              |
| code-generation-stream.ts                         | none                                                                                                                                                   | deleted                                   |
| conversation-thread.ts                            | routes/bubble-flows.ts only (generate handler)                                                                                                         | route edited                              |
| setup-provisioning.ts                             | routes/bubble-flows.ts (generate handler), setup-provisioning.test.ts, bubble-flows-generate-done-message.test.ts                                      | all handled                               |
| shared-schemas coffee.ts                          | streaming-events.ts, generate-bubbleflow-schema.ts, index.ts, api conversation-thread.ts + routes/bubble-flows.ts (generate handler) — plus the studio | all non-studio importers removed          |
| GenerationResult(Schema)                          | boba.ts, workflow, code-generation-stream, both route tests, one-shot test                                                                             | all deleted                               |
| generateBubbleFlowCodeSchema                      | schemas/bubble-flows.ts (generate route only)                                                                                                          | removed                                   |
| template schemas in generate-bubbleflow-schema.ts | routes/bubble-flow-templates.ts                                                                                                                        | KEPT                                      |

## Shared-schemas types deleted vs left for studio coordination

Deleted here (studio lane removes its imports on its own branch; a merge before the studio lane lands will break the studio build until that branch merges too):

- every export of `coffee.ts` (CoffeeRequest/Response, CoffeePlanEvent(+Schema), CoffeeRequestExternalContextEvent, CoffeeContextRequestInfoSchema, ClarificationQuestion(Schema/Choice), SetupResourceSchema, SetupFieldDescriptorSchema, WorkflowDoneMessage(Schema), SystemMessage, ConversationEntry(Schema), CoffeeMessage(Schema), isCoffeeMessage, isWorkflowDoneMessage, COFFEE_MAX_ITERATIONS, COFFEE_MAX_QUESTIONS, COFFEE_DEFAULT_MODEL, PlanStep, CoffeeAgentOutput, all message subtypes)
- the five `coffee_*` StreamingEvent variants
- `generateBubbleFlowCodeSchema`, `generateBubbleFlowCodeResponseSchema`, `GenerationResultSchema`, `GenerateBubbleFlowCodeResponse`, `GenerationResult`

Nothing was left behind for the studio: every candidate type had zero remaining non-studio importers, so per the brief all were deleted.

## Preserved (looked generation-related, is used by surviving routes)

- `runContextFlowRoute` + schemas (POST /bubble-flow/generate/run-context-flow) — the external agent's provision path; kept per brief, comments de-Coffee'd.
- `milktea.ts` + `milktea.test.ts` — MilkTea is a per-bubble parameter-configuration agent with its own live route (POST /ai/milktea via routes/ai.ts); it is not part of the Coffee/Boba flow-generation pipeline and imports none of the deleted modules. Kept.
- `pearl.ts`, `pearl.test.ts`, `rice.ts` — error-explainer / execution evaluator; no imports of deleted modules (comment-only mentions, fixed).
- Template routes (`bubble-flow-templates.ts`) and their schemas in `generate-bubbleflow-schema.ts` — a separate template feature, untouched.
- `validateBubbleFlowCodeRoute`, `createBubbleFlowRoute`, all execute/stream/test/update/delete/activate routes — untouched.

## Verification

- Builds, in order, all clean: `@bubblelab/shared-schemas` (tsup + tsc), `@bubblelab/bubble-core` (94-bubble manifest regenerated), `@bubblelab/bubble-runtime` (tsc), `@bubblelab/bubble-appgen` (tsc).
- `pnpm --filter bubblelab-api exec tsc --noEmit` → exit 0 (noUnusedLocals caught three orphaned imports after the handler deletion; removed).
- `PATH="$HOME/.bun/bin:$PATH" pnpm --filter bubblelab-api test` → **238 pass, 0 fail, 16 skip, 254 total** across 33 files. Surviving-route suites (validate lint surfacing, create, execute, credentials, auto-bind, conversation-persistence-free flows) all green.
- Residual grep for `runCoffee|runBoba|BubbleFlowGeneratorWorkflow|generateBubbleFlowCodeRoute|generateBubbleFlowCodeSchema|GenerationResult|CoffeeMessage|ConversationEntry|isCoffeeMessage|setup-provisioning|conversation-thread|code-generation-stream` over apps/bubblelab-api/src + packages/\*/src → zero hits.

## Environment gotcha hit

This fresh clone had no `apps/bubblelab-api/.env`; 16 tests failed on missing `CREDENTIAL_ENCRYPTION_KEY` (matches the recorded errors-as-events learning). Copied `.env` from `/home/unix/bubblelab-live/apps/bubblelab-api/.env` (gitignored, not committed) → suite fully green. The yfinance validation failure did not appear in this run (it sits among the 16 skips/other suites).

## Deviations from the brief

- `coffee.test.ts` does not exist (brief listed it); equivalent coverage lived in the two deleted route test files.
- `SystemMessage`/`WorkflowDoneMessage` "generation fields": these were whole types inside coffee.ts, not fields on a surviving type; deleted with the file.
