# REPO-MAP — file-level patch plan for the improvement graft

Companion to `HANDOFF.md` and `IMPROVEMENT-REGISTER.md`. Every path is repo-relative. Line numbers
verified 2026-07-14. Builders: read section 2 before touching anything.

---

## 1. Layout

pnpm workspace + turbo monorepo. `pnpm-workspace.yaml` covers `packages/*`, `apps/*`.

| Location | Role |
|---|---|
| `packages/bubble-core` | The bubbles and their base classes. `src/bubble-factory.ts` (class `BubbleFactory`, `register()` at :87, default registrations from :481). `src/types/base-bubble-class.ts` (sealed `action()` lifecycle), `src/types/service-bubble-class.ts` (`chooseCredential()` abstraction), `src/types/bubble.ts` (`BubbleContext` at :83). Bubbles live in `src/bubbles/service-bubble/` (~60 integrations: `slack/`, `github.ts`, `gmail.ts`, …), `src/bubbles/tool-bubble/` (incl. `get-bubble-details-tool.ts`, `list-bubbles-tool.ts`), `src/bubbles/workflow-bubble/`. `CREATE_BUBBLE_README.md:1052` documents the 12-location registration checklist. |
| `packages/bubble-runtime` | Build/run pipeline. `src/extraction/BubbleParser.ts` (AST parse, call-site identity). `src/injection/BubbleInjector.ts` (source-text rewriting for credential injection) + `LoggerInjector.ts`. `src/runtime/BubbleRunner.ts` (the runner: writes generated code to a temp `.ts` file at :437, `import()`s it at :454, unlinks at :666). `src/validation/` (TypeScript validation of generated flows). |
| `packages/bubble-shared-schemas` | Cross-cutting Zod schemas. `src/types.ts` (`CredentialType` enum, hand-maintained, dozens of members). `src/credential-schema.ts` (`BUBBLE_CREDENTIAL_OPTIONS` map at :2907). `src/mock-data-generator.ts` (the schema-derived fiction, complaint #19/#25). `src/bubbleflow-schema.ts`, `src/oauth-schema.ts`, `src/permission-schema.ts`. |
| `packages/bubble-scope-manager` | Prebuilt dist-only package (`index.d.ts/js/mjs`, no `src/`) — a patched TypeScript scope manager used by the parser. Do not plan edits here. |
| `apps/bubblelab-api` | Hono API server. `src/routes/` (`bubble-flows.ts`, `credentials.ts`, `oauth.ts`, `ai.ts`, `webhooks.ts`). `src/services/oauth-service.ts` (**`getValidToken()` at :347 — refreshes on every resolution, comment at :345 says "always refreshing"; `refreshToken()` at :385; no lock**). `src/services/credential-helper.ts` (the other `getValidToken` caller). `src/services/execution.ts` + `bubble-flow-execution.ts` (run dispatch), `src/services/validation.ts`, `credential-validator.ts`. **Generation prompts: `src/config/bubbleflow-generation-prompts.ts`** (533 lines; `BUBBLE_STUDIO_INSTRUCTIONS` :77, `BUBBLE_SPECIFIC_INSTRUCTIONS` :397). Generation workflows: `src/services/ai/bubbleflow-generator.workflow.ts`, `code-generation-stream.ts` (plus codenamed variants `boba/milktea/pearl/coffee/rice`). DB via `src/db/` (Drizzle). |
| `apps/bubble-studio` | React/Vite front end. `src/components/flow_visualizer/` renders the parsed graph; run/credential UI in `src/components/`, state in `src/stores/`, API client in `src/services/`. `public/bubbles.json` is the condensed bubble catalogue the LLM and UI read (regenerated at build). |

Credential flow (verified in HANDOFF §4): discover types via `BubbleInjector.findCredentials()`,
inject DB ids by rewriting source in `BubbleInjector.injectCredentials()`, resolve secrets at
execution via `credential-helper.ts` → `oauth-service.ts`.

---

## 2. Build / test / lint commands (verified by running them)

Run everything from the repo root. Node 20+, pnpm 9 (`packageManager` field governs).

| Command | What it does | Verified result |
|---|---|---|
| `pnpm install --frozen-lockfile` | install | see BUILD-VERIFICATION note below |
| `pnpm build` | `build:core` (shared-schemas → bubble-core → bubble-runtime, in that order) then turbo build of the rest | see note |
| `pnpm typecheck` | `turbo typecheck` across workspace | see note |
| `pnpm test:core` | unit tests for bubble-core + bubble-runtime only | see note |
| `pnpm test` | full turbo test (excludes `create-bubblelab-app`) | many suites are `*.integration.test.ts` needing real API keys/env — expect failures without secrets; use `test:core` as the builder gate |
| `pnpm lint:check` | eslint, no fix | available |

Gotchas that cost time:
- **Build order is encoded in root scripts, not turbo alone**: `pnpm build` = `pnpm build:core && turbo build --filter=!core...`. Never run `turbo build` bare first; core must exist as dist before apps compile.
- **WSL on `/mnt/c` is slow**: full install/build takes several minutes because the repo sits on the Windows filesystem. Budget for it; do not assume a hang.
- `pnpm dev` runs `setup-env.sh` and expects env files; builders doing pure library work do not need it.
- Integration tests (`*.integration.test.ts`) hit live APIs. The deterministic gate for CI-less work is `pnpm build && pnpm typecheck && pnpm test:core && pnpm lint:check`.

**Verification status (2026-07-14):** `pnpm install --frozen-lockfile && pnpm build` was launched
from the repo root and was still executing (turbo processes alive, no errors emitted) after 10+
minutes when the mapping session hit its deadline — WSL + `/mnt/c` makes full builds minutes-long.
Command names and ordering are verified against root `package.json` scripts; completion was NOT
observed. FIRST BUILDER: run `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck &&
pnpm test:core` to completion, record the real wall-times and any failures, and replace this
paragraph with the observed results before other builders start.

---

## 3. Per-improvement file-level patch plan

### IR-5 — refresh-on-expiry + single-flight lock
- `apps/bubblelab-api/src/services/oauth-service.ts`
  - `getValidToken()` (:347): replace always-refresh with expiry check. Token rows already carry
    `expiresAt` (see interface at :27 and persist path around :495); refresh only when
    `now > expiresAt - 300s`. Keep the existing fall-back-to-stored-token on refresh failure.
  - `refreshToken()` (:385): wrap in a single-flight guard — module-level
    `Map<credentialId, Promise<string>>`; concurrent callers await the same promise. For
    multi-instance deployments add a DB advisory lock (Drizzle `SELECT ... FOR UPDATE` on the
    credential row) around the refresh+persist.
- `apps/bubblelab-api/src/services/credential-helper.ts` — the other resolution path; confirm it
  routes through `getValidToken` and inherits the fix (no separate change expected).
- Test: replicate the reference evidence — valid token → 0 refresh calls; 10 concurrent resolutions
  of an expired token → exactly 1 provider call. Unit-testable with a mocked provider client.

### IR-8 — per-operation `sideEffect` metadata (bubbles have no read/write concept today)
- `packages/bubble-core/src/types/service-bubble-class.ts`: add
  `static operationMetadata?: Record<string, OperationMetadata>` to the class contract, where
  `OperationMetadata = { sideEffect: 'read'|'write'|'read_with_side_effects'; requiredScopes?: string[]; confidence: number; source: 'mcp'|'openapi'|'prose'|'observed'; citation: string }`.
  Type lives in `packages/bubble-shared-schemas/src/` (new `operation-metadata-schema.ts`, exported from `index.ts`).
- `packages/bubble-core/src/types/base-bubble-class.ts`: add instance getter `get sideEffect()`
  that reads the current `operation` param and resolves it against the static map; **unknown or
  missing → `'write'`** (fail-safe default).
- `packages/bubble-core/src/bubble-factory.ts`: expose the map through `getMetadata`/list paths so
  it reaches `apps/bubble-studio/public/bubbles.json` and
  `packages/bubble-core/src/bubbles/tool-bubble/get-bubble-details-tool.ts` /
  `list-bubbles-tool.ts` (the catalogue the codegen LLM reads — HANDOFF §6).
- Per-bubble metadata lives **colocated** with each bubble (see §4a) — do not add a 13th central
  registry location.

### TEST-MODE SWITCH (intercept above `performAction`)
- `packages/bubble-core/src/types/bubble.ts` (:83): add `testMode?: boolean` and
  `approvedWriteCallSites?: string[]` to `BubbleContext`.
- `packages/bubble-core/src/types/base-bubble-class.ts` `action()`: insert **before** the
  `performAction` call at :247 (and after the existing `previousResult` short-circuit at :229):
  `if (context.testMode && this.sideEffect !== 'read' && !approved) return this.getRecordedMock() ?? this.generateMockResult();`
  `generateMockResult()` already exists at :371. New `getRecordedMock()` reads the Contract KB
  recorded-response store when present.
- `packages/bubble-runtime/src/runtime/BubbleRunner.ts`: thread `testMode` from run options into
  the `BubbleContext` handed to the flow. Pass it via the runtime context, **not** via
  `BubbleInjector` source rewriting.
- `apps/bubblelab-api/src/services/execution.ts` / `bubble-flow-execution.ts`: accept
  `testMode` on the run request and forward it; `src/routes/bubble-flows.ts`: new `POST /:id/test`.
- `apps/bubblelab-api/src/config/bubbleflow-generation-prompts.ts`: tell the codegen LLM which ops
  are read vs write and that mocked writes did not happen (HANDOFF §6).

### IR-9/10 — the Tester
Under the two-phase model (§4b) the Tester is the **Phase-2 explicit TEST run**, not a build-time probe.
- New `apps/bubblelab-api/src/services/flow-tester.ts`: orchestrates a `testMode=true` run through
  `BubbleRunner`; reads execute for real, writes mock unless per-op sign-off (§4b); records real
  responses keyed by `BubbleParser` call-site identity.
- `packages/bubble-core/src/types/bubble-errors.ts` + `BubbleRunner.ts`: introduce and **preserve**
  an `OUTPUT_MISMATCH` drift code end-to-end (reference build lost it at the wrapper boundary —
  HANDOFF §9). Give it a consumer: the Tester report and the KB ingester.
- `apps/bubble-studio`: test-run button + results panel; warning dialog for write sign-off.

### IR-6/7 — proactive scope audit
- Depends on `requiredScopes` in IR-8 metadata.
- `apps/bubblelab-api/src/services/credential-validator.ts` (+ `validation.ts`): at flow
  validation, union `requiredScopes` over the parsed call sites (BubbleParser already yields
  bubble+operation), diff against granted scopes stored on the credential row (persisted by
  `oauth-service.ts`, `scopes` fields at :29/:47/:143), fail naming the missing scope.
  Providers with no scope metadata degrade to an explicit "unknown scopes, will surface on first
  run" message.
- Surface in `routes/bubble-flows.ts` validation response and in studio credential UI.

### Contract KB (IR-11/12 — build after the Tester)
- New Drizzle tables in `apps/bubblelab-api/src/db/`: `recorded_contracts`
  (call-site-identity key, structural fingerprint, response sample, version, source run id) and
  `contract_observations` (for the 3-consistent-observations heal rule; never learn from mocks).
- Ingest points: flow-tester (test runs) and `bubble-flow-execution.ts` (production runs, consuming
  `OUTPUT_MISMATCH`).
- Serve recorded samples to `getRecordedMock()` and to `get-bubble-details-tool.ts` so codegen
  grounds on reality instead of `mock-data-generator.ts` fiction.

### NL-prompt → workflow generator
BubbleLab already has one: `apps/bubblelab-api/src/services/ai/bubbleflow-generator.workflow.ts` +
`code-generation-stream.ts`, prompts in `src/config/bubbleflow-generation-prompts.ts`, catalogue via
`list-bubbles-tool.ts`/`get-bubble-details-tool.ts`, output validated by
`packages/bubble-runtime/src/validation/`. The work is an **upgrade, not a greenfield build**:
1. Inject `sideEffect`/`requiredScopes` into the catalogue both tools emit.
2. Swap `MockDataGenerator` samples for recorded contracts when available.
3. Add the test-mode semantics of HANDOFF §6 to `BUBBLE_STUDIO_INSTRUCTIONS`.
4. Emit flows pre-wired for a Phase-2 test run (declare their write set).

---

## 4. Unresolved prerequisites — proposed designs

### 4a. Backfill: sideEffect + requiredScopes for ~60 existing bubbles
Hand-writing ~60 bubbles × 10–40 operations is weeks of error-prone work; deriving from Zod alone
is impossible (schemas describe parameters, not effects). Proposal — a **cited LLM classification
pass with human-reviewable output**:

1. **Extractor script** (`scripts/backfill-operation-metadata.ts`): instantiate `BubbleFactory`,
   for each registered service bubble read its params schema (every bubble is a discriminated
   union on `operation`) and its `.describe()` strings; pull the vendor doc root from the bubble's
   header comment or a small lookup table.
2. **LLM pass**: per bubble, prompt with (operation list + descriptions + relevant vendor doc
   pages) requiring output per operation: `{sideEffect, requiredScopes, confidence, source,
   citation}` where citation is a doc URL/quote. **Never classify from HTTP verb** (register
   evidence: 4 doc-said-read ops mutated). Confidence < threshold → emit `'write'` +
   `unverified: true`.
3. **Storage**: one colocated file per integration —
   `src/bubbles/service-bubble/<name>.metadata.ts` exporting a typed
   `Record<string, OperationMetadata>`, imported by the bubble class as its static. Colocation
   keeps the 1-file-per-integration property and avoids a new central checklist location. Files
   land as reviewable PRs (a human skims citations, not re-derives them).
4. **CI guard**: a test iterating the factory asserting every operation has an entry (unknown ops
   fail the build), so new operations cannot ship unclassified.
5. **Runtime correction channel**: Phase-2 real runs that observe a "read" op mutating state write
   an `observed` override row in the DB; precedence `observed > doc-derived`. Docs lie; runs don't.

### 4b. Two-phase execution model (owner's design — no build-time probing)
**Phase 1 (authoring/stitching): mock contracts only.** BubbleLab's "build never executes"
property is *kept*. Authoring/validation (`bubble-runtime/src/validation`, parser, injector
discovery) runs with zero credentials; the LLM stitches against declared contracts whose samples
come from the Contract KB when a recording exists, else `MockDataGenerator`. Credential *presence*
checks stay advisory at authoring (name what will be needed; block nothing). **No read-scoped or
probe credential exists anywhere.**

**Phase 2 (first real run / explicit TEST): the sign-off gate.** Grounding and docs-lie correction
happen here, on real traffic.
- **Gate location (server-side, authoritative):** `apps/bubblelab-api/src/services/execution.ts`
  (shared by `POST /:id/execute` and the new `POST /:id/test`). Before dispatch, when
  (a) the run is a TEST, or (b) it is the flow's **first** real run (executions count = 0), the
  server computes the flow's write set: parse via `BubbleParser`, resolve each call site's
  `operation` param against `operationMetadata`, collect `sideEffect !== 'read'` sites. If the
  write set is non-empty and unapproved, respond `409 { pendingApproval: [{callSiteId, bubble,
  operation, sideEffect, citation}] }` and dispatch nothing.
- **Warning surface (client):** bubble-studio run/test dialog renders the 409 payload as an
  explicit warning — "these operations WRITE to real systems/users" — one checkbox per operation
  plus typed confirmation. Resubmit carries `approvedWriteCallSites: string[]`.
- **Enforcement (defense in depth):** the server stamps the approved set into `BubbleContext`;
  `BaseBubble.action()` (test-mode switch above) mocks any write-hinted op **not** in the approved
  set even if a client lies. UI is convenience; base class is law.
- **Audit:** persist the approval (who, when, which call sites) on the executions row.
- **Grounding side effect:** every Phase-2 run records real read responses (and approved writes)
  into the Contract KB, and `OUTPUT_MISMATCH` drift flows to its consumer. This is where docs-lie
  reclassification (4a step 5) fires.

---

## 5. Risk register — what will fight us

1. **Source-rewriting injector** (`bubble-runtime/src/injection/BubbleInjector.ts`): splices
   credential ids into source text with line-shift tracking. Any new per-run state (testMode,
   approved sites) must travel through the runtime context object, never through more rewriting —
   adding fields to the rewriter compounds their most fragile code and collides with IR-15 later.
2. **Temp-file runner** (`bubble-runtime/src/runtime/BubbleRunner.ts:437–466`): generated code is
   written to a temp `.ts` and `import()`ed. Consequence: interception MUST live in
   `bubble-core` base classes (which the imported module links against), not in the runner process
   logic. Also a cache hazard: `import()` caches by URL, and temp-file paths on WSL/`/mnt/c` are
   slow and Windows-locked; expect flaky unlinks.
3. **The 12-location checklist** (`bubble-core/CREATE_BUBBLE_README.md:1052`): every metadata or
   catalogue change risks becoming location 13. The colocated `.metadata.ts` + factory-derived
   catalogue design exists to avoid that; reviewers should reject any central-registry variant.
4. **141 hand-maintained credential types** (`bubble-shared-schemas/src/types.ts` +
   `credential-schema.ts` `BUBBLE_CREDENTIAL_OPTIONS` :2907), including dual systems for one app
   (`SLACK_CRED` vs `SLACK_API`): the scope audit must map credential type → provider scope
   vocabulary per type; expect per-provider special cases and missing scope metadata.
5. **Monolithic bubble files** (`slack.ts` ≈ 124 KB): parallel builders editing the same bubble
   file will merge-conflict; per-op metadata in sibling files reduces contention.
6. **Two codegen paths + codenamed AI workflows** (`boba/milktea/pearl/coffee/rice` in
   `apps/bubblelab-api/src/services/ai/`): prompt changes must land in every live path, not just
   `bubbleflow-generation-prompts.ts`; grep before declaring done.
7. **Integration-test suite needs live keys**: `pnpm test` will fail without secrets; gate on
   `test:core` + typecheck + lint, and mark new tests unit-runnable.
8. **WSL `/mnt/c` filesystem**: installs/builds are minutes-slow and file-lock errors occur;
   never diagnose a "hang" without checking turbo output first.
