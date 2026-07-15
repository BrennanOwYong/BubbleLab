# Delta: one-shot prompt -> workflow (the MVP demo path)

Branch: `improve/stitch-generator`. Upgrades BubbleLab's existing generation path
(`runBoba` -> `BubbleFlowGeneratorWorkflow` -> `validateAndExtract`) per REPO-MAP §3
"NL-prompt → workflow generator" — an upgrade, not a greenfield build.

## What changed

### 1. Literal parameter VALUES are validated statically (packages/bubble-runtime)

`src/validation/param-value-validator.ts` (new): every parsed bubble call site's
literal parameters are checked against the bubble's declared Zod params schema
BEFORE anything runs. The TypeScript LanguageService pass (BubbleValidator) already
catches structural type errors; this closes the Zod-only gap — `.email()`, `.min()`,
`.max()`, enum membership, unknown `operation` on a discriminated union.

- Literals are recovered from the parser output (`BubbleParameterType.STRING/NUMBER/
  BOOLEAN` directly; `OBJECT/ARRAY` re-evaluated from source text with a strict
  TypeScript-AST literal evaluator — no eval, no execution).
- Conservative by construction: variables, expressions, template strings with
  substitutions, env reads, and spreads are skipped, and nested unknown values
  suppress only the Zod issues that touch them. A skip is never an error.
- Discriminated-union schemas resolve their branch via a literal `operation`;
  an unknown operation is an error naming the valid ones.
- Wired into `validateAndExtract` (`src/validation/index.ts`) as step 5, so every
  consumer — the generator's `createWorkflow`/`editWorkflow` tools, the API validate
  route, Pearl — inherits it with no further change. Errors use the existing
  `line N: …` format, tagged `[param-value]`, so the generation agent can fix them.
- Zod internals are duck-typed (`_def.typeName`), not `instanceof`, because
  bubble-core and bubble-runtime may hold different zod instances.

### 2. The validator is the generator's ONLY successful exit (apps/bubblelab-api)

`services/ai/bubbleflow-generator.workflow.ts`:
- `buildFinalGenerationResult()` (exported, pure): code that fails static validation
  → `success: false` carrying the validator's errors verbatim; no code produced
  (impossible prompt) → `success: false` carrying the model's own explanation.
  Previously invalid code exited with `success: true, isValid: false` and an empty
  error — silent garbage.
- The final code is re-validated authoritatively with `validateAndExtract` when the
  in-loop hooks did not record a passing validation (hook state can go stale after
  failed edits). The retry loop itself (createWorkflow → editWorkflow with validator
  errors fed back, up to 50 iterations) already existed and is unchanged.
- `services/ai/boba.ts`: the generator's success flag now survives the bubble
  wrapper (`result.success && result.data.success`); previously the wrapper-level
  `success` masked inner failure.
- Storage was already gated on `isValid` in `routes/bubble-flows.ts` (code stored
  with name/inputSchema/eventType/cron, runnable via `POST /:id/execute`, on
  schedule via the cron columns, and in test mode via `POST /:id/test`) — with the
  loud-failure change nothing invalid reaches that gate claiming success.

### 3. The generation prompt knows about side effects and test mode

- `config/bubbleflow-generation-prompts.ts`: new exported
  `SIDE_EFFECT_AND_TEST_MODE_INSTRUCTIONS` — read/write/read_with_side_effects
  classes, fail-safe write default, writes are MOCKED in test mode (`mocked: true`,
  the operation DID NOT HAPPEN), the forbidden read-back-after-mocked-write
  patterns, writes-terminal structuring, and the fixed-path/agentic-node
  positioning (ai-agent is a NODE for judgment; it never chooses the path).
- Embedded inside `BUBBLE_SPECIFIC_INSTRUCTIONS`, which is composed into every
  code-writing path: the generator workflow (boba), Pearl, and Rice (risk register
  #6 — one block, every path). Coffee (planner, writes no final code) keeps
  `CRITICAL_INSTRUCTIONS` only.
- `buildBubbleCatalogue()` (exported from the generator workflow): the system-prompt
  bubble list is built LIVE from `BubbleFactory` per generation and now carries each
  operation's side-effect hint and requiredScopes when declared (IR-8 metadata).
  `get-bubble-details-tool` already emits `operationSideEffects` per IR-8.

### 4. Runnable demo

`apps/bubblelab-api/scripts/demo-one-shot.ts` (`pnpm --filter bubblelab-api
demo:one-shot`, bun): live catalogue hints → bad-literal flow rejected at compile
with a fetch guard proving zero network → validated flow run through `BubbleRunner`
with `testMode: true` (write mocked, zero network) → real LLM generation + the
impossible-prompt loud failure ONLY when `GOOGLE_API_KEY`+`OPENROUTER_API_KEY` are
set, otherwise printed as SKIPPED. The script throws on any dishonest outcome.

## Acceptance criteria mapping

- "bad literal parameter rejected at compile WITHOUT executing the tool" →
  param-value validator + `param-value-validator.test.ts` (fetch never called;
  validation is pure parsing) + demo stage 2.
- "impossible prompt FAILS LOUDLY" → `buildFinalGenerationResult` +
  `one-shot-generation.test.ts` + demo stage 4 (keys required, honest skip).
- "prompt → flow that compiles, stores, RUNS" → existing route path, now
  loud-failure-gated; demo stages 3-4.
- "generator reads live catalogue with side-effect hints" →
  `buildBubbleCatalogue` + test asserting `send_email=write` /
  `get_email_status=read` from the live factory.
- "LLM as a node, path fixed at compile time" + "prompt told about test mode" →
  `SIDE_EFFECT_AND_TEST_MODE_INSTRUCTIONS` in every code-writing prompt.

## How it was verified

Gate (REPO-MAP §2): `pnpm build && pnpm typecheck && pnpm lint:check` plus the two
new test suites (results recorded below).

- `packages/bubble-runtime/src/validation/param-value-validator.test.ts` (7 tests,
  vitest, real factory/parser/schemas): bad literal email rejected; empty subject
  (`min(1)`) rejected; unknown operation rejected naming valid ones; valid literals
  + runtime-dependent values pass; literal evaluator unit cases.
- `apps/bubblelab-api/src/services/ai/one-shot-generation.test.ts` (5 tests, bun):
  validator-only exit shapes (invalid → success=false with errors; no code →
  loud failure carrying model text; valid → success), live catalogue side-effect
  hints from a real `ResendBubble` registration, test-mode block present in the
  shared prompt constant.

## Environment learnings

- Existing fixture flows in bubble-runtime pass the new value check unchanged —
  the conservative skip rules mean only proven schema violations fail.
- `BubbleParameterType.STRING` values are stored WITHOUT quotes for plain literals
  but as RAW SOURCE (backtick-included) for template literals — the backtick prefix
  is the discriminator.

## References

- Design source: `docs/plan/REPO-MAP.md` §3 (NL-prompt → workflow), HANDOFF §6
  (codegen must know about test mode), §5 (test-mode semantics).
- IR-8 catalogue surfacing: `docs/plan/deltas/ir8-side-effect-metadata.md`.
- Test-mode runtime behavior: `docs/plan/deltas/test-mode-switch.md`.
