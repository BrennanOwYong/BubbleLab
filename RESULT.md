# Task result: remove in-project AI agents (pearl / rice / milktea)

Status: complete. Branch: feature/remove-inproject-agents.

## Files deleted

apps/bubblelab-api/src/services/ai/ (entire directory):

- pearl.ts, pearl.test.ts
- milktea.ts, milktea.test.ts
- rice.ts (no rice.test.ts existed)
- bubbles.json (fixture used only by milktea.test.ts)
- ai.excalidraw (diagram of the deleted agents)

apps/bubblelab-api/src/services/evaluation-trigger.ts — orphaned once the rice call was severed; sole importer was bubble-flow-execution.ts.

packages/bubble-shared-schemas/src/:

- pearl.ts (PearlRequest/ResponseSchema, PEARL_DEFAULT_MODEL)
- milk-tea.ts (MilkTeaRequest/Response/AgentOutputSchema)
- rice.ts (RiceRequest/Response/EvaluationResultSchema, RiceIssueType, RICE_DEFAULT_MODEL)

## Dependent map (before deletion)

- runPearl, runMilkTea → apps/bubblelab-api/src/routes/ai.ts (POST /ai/pearl, POST /ai/milktea handlers)
- milkTeaRoute, pearlRoute → apps/bubblelab-api/src/schemas/ai.ts (OpenAPI route defs)
- runRice, getRiceModelUsed → apps/bubblelab-api/src/services/bubble-flow-execution.ts (runEvaluationIfNeeded, gated on options.evalPerformance)
- shouldEvaluateExecution, storeEvaluation → same file, from evaluation-trigger.ts
- RiceEvaluationResult → evaluation-trigger.ts only
- evalPerformance option → services/execution.ts (StreamingExecutionOptions field), routes/bubble-flows.ts (execute-stream query param)
- ConversationMessageSchema (imported by pearl.ts + milk-tea.ts schema files) is defined in shared-schemas agent-memory.ts and used by bubble-core (ai-agent, agent-memory) and the studio — untouched. The stale comment in pearl.ts claiming milk-tea.ts exports it was wrong.
- Studio: zero fetches to /ai/pearl or /ai/milktea (confirmed by grep). Remaining studio references are inert: editorStore SidePanelMode union values 'milktea'/'pearl', evaluation-popup components, useRunExecution appending ?evalPerformance=true (server now ignores it), comments.

## Edits to surviving files

- routes/ai.ts SURVIVED: it also hosts POST /ai/speech-to-text (Wispr transcription, not an agent). Removed the milktea + pearl handlers, the systemAICredentials() helper (only those handlers used it), and now-unused imports (streamSSE, runMilkTea, runPearl, CredentialType, StreamingEvent). Registration in src/index.ts (app.route('/ai', aiRoutes)) unchanged.
- schemas/ai.ts: removed milkTeaRoute + pearlRoute defs and their schema imports; speech-to-text route defs kept.
- services/bubble-flow-execution.ts: removed runEvaluationIfNeeded + its call site + imports (runRice, getRiceModelUsed, shouldEvaluateExecution, storeEvaluation, CredentialType, env).
- services/execution.ts: removed dead evalPerformance field from StreamingExecutionOptions.
- routes/bubble-flows.ts: removed the evalPerformance query-param read and pass-through.
- packages/bubble-shared-schemas/src/index.ts: removed the milk-tea/pearl/rice re-exports.

## Kept deliberately

- start_evaluating/end_evaluating event types + evaluationResult field in shared-schemas streaming-events.ts: live importers remain in the studio (executionStore, EvaluationIssuePopup, LiveOutput, AllEventsView). The server never emits them now; pruning them requires a studio cleanup pass, out of this task's scope.
- bubbleFlowEvaluations DB table (db/schema-\*.ts): kept to avoid a migration and preserve historical evaluation rows.
- posthog.ts generationSource union mentioning 'pearl'/'milktea': analytics string labels with zero callers before this change; pre-existing, untouched.
- AIAgentBubble and all bubble-core "Pearl flow" runtime references (\_isPearlFlow, capability-pipeline comments, slack bubble labels): SDK/runtime surface used by generated flows, preserved per brief.

## Verification

- Builds clean in order: @bubblelab/shared-schemas → bubble-core → bubble-runtime → bubble-appgen (all exit 0).
- apps/bubblelab-api `tsc --noEmit`: exit 0.
- `pnpm --filter bubblelab-api test`: 238 pass / 0 fail. First run had 16 failures (CredentialEncryption + derived-credential suites), all from the known fresh-clone gap: missing apps/bubblelab-api/.env with CREDENTIAL_ENCRYPTION_KEY. Copied .env from /home/unix/bubblelab-live; rerun fully green. The yfinance validation test passed.
- Residual grep for runPearl|runRice|runMilkTea|pearl.js|rice.js|milktea.js|milk-tea.js|MilkTeaRequest|PearlRequest|RiceEvaluationResult|evalPerformance across apps/bubblelab-api + packages: zero hits.

## Deviations

None blocking. Two scope notes: (1) routes/ai.ts survived instead of being deleted because of the non-agent speech-to-text route; (2) rice removal also removed the evalPerformance execution option end to end (server side), while the studio's dead ?evalPerformance=true query string and evaluation-popup UI remain as inert frontend code for a later studio pass.
