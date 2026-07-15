# Delta: test-mode switch (the ★ finding)

Branch: `improve/test-mode-switch`. Grafts the verified test-mode design from the
reference implementation (HANDOFF §5) onto BubbleLab. Intercepts ABOVE
`performAction()` in `BaseBubble.action()` — never at the per-bubble HTTP/SDK client —
so no client is constructed, no credential is read, and auth type is irrelevant.

## What changed

### packages/bubble-shared-schemas

- `execution-meta.ts`: `ExecutionMeta` gains `testMode?`, `approvedWriteCallSites?`,
  `recordedMockProvider?`; new `RecordedMockLookup` / `RecordedMockProvider` types.
  ExecutionMeta is the carrier because the injected bubble constructor context already
  threads `executionMeta: __bubbleFlowSelf?.__executionMeta__` into every bubble
  (`bubble-runtime/src/utils/parameter-formatter.ts:98/156/199`) — zero new source
  rewriting (risk register #1).
- `mock-data-generator.ts`: `BubbleResult` gains `mocked?: boolean` — a shape-valid
  result whose operation DID NOT happen.
- `bubbleflow-schema.ts`: `testBubbleFlowSchema` for the new API route.

### packages/bubble-core

- `types/operation-side-effect.ts` (new): minimal structural interface
  (`OperationSideEffect`, `OperationSideEffectHint`, `OperationSideEffectMap`) the gate
  consumes. **IR-8 integration point**: IR-8's doc-grounded
  `OperationSideEffectMetadata` / `BubbleOperationMetadata` (richer: confidence,
  source, citation, requiredScopes, destructive, idempotent) is structurally
  assignable to this map, so bubbles declaring IR-8 metadata as their static
  `operationMetadata` feed this gate with no further change. Keys are `operation`
  discriminator literals; `'*'` classifies bubbles without an operation param.
- `types/bubble.ts`: `BubbleContext` gains `testMode?`, `approvedWriteCallSites?`,
  `recordedMockProvider?` (also honored via `context.executionMeta`).
- `types/base-bubble-class.ts`:
  - `get sideEffect()`: resolves the current `operation` against the class's static
    `operationMetadata`; **unknown/missing → `'write'`** (fail-safe: an unclassified
    operation can never execute in test mode by accident).
  - Gate in `action()`, after the `previousResult` short-circuit, before
    `performAction`: `testMode && sideEffect !== 'read' && !grant` → return
    `(await getRecordedMock()) ?? generateTestModeMockResult()`. Only pure reads run;
    `read_with_side_effects` is mocked.
  - Grant (`hasApprovedWriteGrant`): exact string match of
    `invocationCallSiteKey`/`currentUniqueId` against `approvedWriteCallSites`. No
    wildcards; a bubble with no call-site identity never matches — impossible to
    trigger accidentally. Enforcement lives in the base class, so a lying client
    cannot execute unapproved writes (server-side "base class is law", REPO-MAP §4b).
  - `getRecordedMock()`: Contract KB seam (IR-11/12). Consults
    `recordedMockProvider` with `{bubbleName, operation, callSiteKey}`; provider
    failures fall back to the generated mock. Recording infra does not exist yet — the
    provider is the designed plug point.
  - `generateTestModeMockResult()`: operation-aware upgrade over bare
    `generateMockResult()` — when `resultSchema` is a discriminated union on
    `operation`, generates from the option matching the CURRENT operation (bare
    `MockDataGenerator.generateMockResult` returns `{}` for union schemas because it
    requires `.shape`). Marks `mocked: true`, forces `success: true, error: ''`.

### packages/bubble-runtime

- `BubbleRunner.ts`: `BubbleRunnerOptions` gains `testMode?` /
  `approvedWriteCallSites?`; `runAll()` merges them into `__executionMeta__`. No
  injector/rewriter change.

### apps/bubblelab-api

- `services/execution.ts`: `ExecutionOptions` gains the two fields; forwarded into
  `BubbleRunner`.
- `services/bubble-flow-execution.ts`: forwards them from
  `executeBubbleFlowWithTracking`.
- `schemas/bubble-flows.ts` + `routes/bubble-flows.ts`: `POST /:id/test` — same
  handler shape as execute, with `testMode: true` and optional
  `approvedWriteCallSites` from the body.

## Deviations from the REPO-MAP patch plan

- Codegen prompt changes (`bubbleflow-generation-prompts.ts`, HANDOFF §6) NOT done
  here: without IR-8's per-operation classifications landed, telling the LLM "which
  ops are read vs write" has no data behind it, and prompts must land across all
  codenamed generation paths at once (risk register #6). Integration point: add
  test-mode semantics to `BUBBLE_STUDIO_INSTRUCTIONS` once IR-8 metadata is in the
  catalogue.
- IR-8 was mid-flight in a parallel worktree; rather than colliding on
  `operation-metadata-schema.ts`, this branch defines the minimal structural interface
  above. IR-8 has since committed (c778b94 on `improve/ir8-side-effect-metadata`) its
  own `get sideEffect()` on BaseBubble with IDENTICAL semantics (resolve current
  `operation` against static `operationMetadata`, unknown → 'write'). Merging both
  branches produces one textual conflict in `base-bubble-class.ts`: keep IR-8's
  richer getter pair (`sideEffect` + `operationSideEffectMetadata`) and optionally
  fold in this branch's `'*'` fallback for bubbles without an `operation` param; the
  test-mode gate itself only reads `this.sideEffect` and works with either getter.
  IR-8's `ServiceBubble.static operationMetadata?: BubbleOperationMetadata` satisfies
  this branch's structural read.

## How it was verified

- `pnpm build:core` (7m25s, WSL/mnt/c), `pnpm typecheck` (9/9 tasks) — pass.
- `pnpm lint:check`: 0 errors in touched files (verified by linting the 14 touched
  files directly). The repo-wide run reports 142 pre-existing errors, all in
  `apps/bubble-studio` ("Definition for rule not found" for react-hooks/react-refresh
  rules) — untouched by this branch.
- `packages/bubble-core/src/types/base-bubble-test-mode.test.ts` — 20/20 pass:
  - SDK-client fixture (resend pattern: client constructed inside performAction) and
    bare-fetch fixture (github pattern: chooseCredential re-called per operation):
    with testMode, write-hinted ops leave `performAction` counter at 0, client
    constructor counter at 0, `chooseCredential` counter at 0; result is
    `mocked: true`, operation-matching, schema-valid.
  - Read-hinted ops run for real in test mode (counters 1).
  - Write runs for real ONLY with exact-match per-call-site grant; wrong-site grant
    and grant-without-identity stay mocked.
  - Recorded mock preferred over generated; provider-throw falls back.
  - REAL `ResendBubble` (SDK) and `GithubBubble` (bare fetch) under a global fetch
    spy: zero network attempts, mocked results — proving auth-agnostic interception.
- `packages/bubble-runtime/src/runtime/BubbleRunner.test-mode.test.ts` — 3/3 pass:
  testMode threads through the generated-code path (temp-file import) via
  executionMeta; write-default bubble mocked with testMode, real without.
- Full unit suites at HEAD vs baseline (WSL on /mnt/c, no API keys in env):
  - bubble-core: 398 passed / 12 failed / 45 skipped. Every failure is a
    `Test timed out in 60000ms` in registry-heavy tool tests
    (`tools-schema-compat`, `research-agent-tool`, `bubbleflow-validation-tool`,
    `get-bubble-details-tool`, `list-bubbles-tool`). Baseline proof: the same 5 files
    re-run with `git checkout origin/main -- packages/bubble-core/src
packages/bubble-shared-schemas/src` produced the SAME timeouts (11 failed; the
    12th sits on the 60s boundary and flips run-to-run). Environment, not this branch.
  - bubble-runtime: 168 passed / 3 failed / 8 skipped. All three failures are
    `Test/Hook timed out in 60000ms` (validation tests spawning the TS language
    service; a linkedin-gen AI flow with no API keys). The 40+ other BubbleRunner
    execution tests pass, including this branch's 3 threading tests inside the suite.

## References

- Design source: `docs/plan/HANDOFF.md` §5 (improvement-plan branch),
  `docs/plan/REPO-MAP.md` §3 "TEST-MODE SWITCH" + §4b.
- Threading channel: `packages/bubble-runtime/src/utils/parameter-formatter.ts`.
