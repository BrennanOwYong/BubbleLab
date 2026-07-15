# Delta: run-time grounding + docs-lie detection + sign-off gate

Branch: `improve/run-grounding-and-signoff`. Implements Phase-2 of the owner's
two-phase execution model (REPO-MAP §4b): authoring stays mock-only and
credential-free; grounding, drift detection, and docs-lie correction happen on
REAL runs; write-hinted operations cannot execute without explicit sign-off.

## What changed

### 1. The sign-off gate (server-side, authoritative)

- `packages/bubble-core/src/utils/write-set.ts`: `computeWriteSet()` — from a
  flow's parsed bubbles (call-site identity included) and the IR-8 operation
  metadata, collect every write-hinted call site. Fail-safe: bubbles without
  metadata, unknown operations, and non-literal `operation` params classify as
  writes. Each entry carries every runtime identity of the call site
  (`invocationCallSiteKey`, dependency-graph `uniqueId`, `String(variableId)`)
  plus the classification and its citation.
- `apps/bubblelab-api/src/services/write-signoff.ts`: gate evaluation +
  sign-off persistence. `evaluateWriteSignOff()` blocks any REAL run whose
  write set is not fully covered by a persisted sign-off;
  `approveFlowWrites()` records the sign-off (who, when, approved call sites,
  code hash) into the flow's `metadata` JSON column and REJECTS partial
  approval — every write call site must be named. A code change invalidates
  the sign-off (hash mismatch).
- `apps/bubblelab-api/src/services/bubble-flow-execution.ts`: the gate runs in
  `executeBubbleFlowWithTracking` — the single choke point shared by manual
  execute, execute-stream, webhook, and cron paths. A blocked run returns
  `errorCode: 'WRITE_SIGNOFF_REQUIRED'` + `pendingWriteSignOff` (bubble,
  operation, side effect, citation, call-site keys) and dispatches NOTHING.
- `apps/bubblelab-api/src/routes/bubble-flows.ts` + `schemas/bubble-flows.ts`
  + `packages/bubble-shared-schemas/src/bubbleflow-schema.ts`:
  `POST /:id/execute` returns **409** with the pending payload; new
  `POST /:id/approve-writes` records the explicit sign-off.
- Defense in depth (base class is law): approved runs execute with
  `enforceWriteSignOff` + the approved keys stamped into `executionMeta`;
  `BaseBubble.action()` MOCKS any write-hinted call site outside the approved
  set even if a client bypassed the gate. Children of an approved call site
  (`${approvedKey}.` prefix on `currentUniqueId`) are covered — approving an
  agent call site covers the tools it spawns dynamically. Reads never need
  sign-off; TEST runs skip the gate (test mode already mocks writes; per-op
  grants in the test body are the explicit sign-off for those ops).

### 2. Drift signal (OUTPUT_MISMATCH) that survives every boundary

- `packages/bubble-core/src/types/bubble-errors.ts`: `BubbleDriftError`
  (extends `BubbleValidationError`, `code: 'OUTPUT_MISMATCH'`, carries
  operation, call-site key, structured deviations) + `isDriftError()` which
  checks the CODE/name structurally — the generated temp-file flow links its
  own bubble-core module instance, so `instanceof` dies at that boundary and
  the code must not.
- `packages/bubble-core/src/types/base-bubble-class.ts`: the resultSchema
  failure path in `action()` (which only runs on REAL responses — mocks
  return earlier) now (a) notifies `executionMeta.onContractDrift` BEFORE
  throwing, then (b) throws `BubbleDriftError`. The observer is why the
  signal survives flow code that catches the error — the reference build's
  KB-blocking bug (HANDOFF §9).
- `packages/bubble-runtime/src/runtime/BubbleRunner.ts`: wires a drift
  collector into `executionMeta` (chaining any caller observer), adds a
  drift branch FIRST in the catch cascade returning
  `errorCode: 'OUTPUT_MISMATCH'`, and attaches collected `drift` events to
  every result shape — success (flow swallowed the throw) and all failure
  branches.
- `packages/bubble-shared-schemas`: `run-grounding-schema.ts`
  (`ContractDriftEventSchema`, observers, `DRIFT_ERROR_CODE`);
  `executeBubbleFlowResponseSchema` gains `errorCode`, `drift`,
  `pendingWriteSignOff`.
- Consumer: `bubble-flow-execution.ts` persists drift events + errorCode into
  the execution row's `result` JSON and returns them in the API response —
  the Contract KB's ingest point (IR-11/12) reads from here.

### 3. Docs-lie detector + persisted reclassification

- `packages/bubble-core/src/utils/mutation-evidence.ts`: conservative
  evidence detection on real responses of doc-said-read operations — HTTP 201
  status (with or without Location header), explicit `created: true`, or a
  `createdId` field, checked at the top level and one level into
  `data`/`response`. A bare `id` is NEVER evidence (reads return ids
  constantly). Second path: an optional caller-supplied before/after state
  snapshot (`executionMeta.mutationProbe`), captured around the real
  execution; any difference is evidence. `downgradeLyingRead()` mirrors the
  reference build's gate.ts: `read_with_side_effects`, confidence 0.95,
  idempotent false, evidence as citation.
- **Honest detectability statement**: marker detection works only for bubbles
  that surface status/creation fields in their results; probe detection works
  only when a caller supplies one. An operation with neither is undetectable
  here — its correction channel is cross-run observation comparison, which
  belongs to the Contract KB task.
- `packages/bubble-core/src/utils/side-effect-overrides.ts`:
  `SideEffectOverrideRegistry` (module singleton) holds runtime-verified
  corrections; `record()` is idempotent (never re-learned) and persists
  through a `SideEffectOverrideStore` seam. `FileSideEffectOverrideStore`
  (JSON) ships now; IR-11/12 can plug a DB store into the same interface.
- Precedence observed > doc-derived is enforced at every read:
  `BaseBubble.sideEffect` / `operationSideEffectMetadata` consult the
  registry first, and `BubbleFactory.getMetadata()` merges overrides into
  `operationMetadata` — so `get-bubble-details-tool`, `list-bubbles-tool`,
  and the codegen LLM behind them see the corrected hint (catalogue
  surfacing). A corrected lying read also joins `computeWriteSet`, so the
  sign-off gate and test mode start mocking/blocking it.
- `apps/bubblelab-api/src/services/side-effect-override-store.ts` + boot hook
  in `src/index.ts`: corrections load from `SIDE_EFFECT_OVERRIDES_PATH`
  (default `./data/side-effect-overrides.json`) BEFORE any run, and persist as
  observed. `executionMeta.onSideEffectCorrection` is the API-side
  notification seam.

### 4. Phase-1 property preserved

Authoring/stitching (parse, credential discovery, write-set computation, mock
generation) executes nothing: proven by a fetch-spy test issuing ZERO network
calls with zero credentials configured.

## Deviations from the brief

- The brief named `source='runtime_verified'`. BubbleLab's IR-8 source enum
  (`operation-metadata-schema.ts`) already defines `'observed'` as exactly
  "runtime-verified behavior" and reserves it for this channel (IR-8 delta
  §"Why this design"). Corrections use `source: 'observed'` rather than adding
  a duplicate enum member; the reference build's `runtime_verified` semantics
  (confidence 0.95, idempotent reset, evidence citation) are ported intact.
- Sign-off persistence lives in the flow row's existing `metadata` JSON column
  instead of a new table: no dual-dialect migration surface, and the code-hash
  binding gives the audit property (who/when/what/for-which-code) the brief
  asked for. The Contract KB task owns new tables.
- Bubble-studio UI (warning dialog rendering the 409 payload) is not in this
  branch — the payload is designed for it (`pendingWriteSignOff` names every
  operation, mutation, and citation), and the server gate + base-class
  enforcement make the UI purely presentational.

## How it was verified

New tests (real behavior; the unit under test is never mocked):

- `packages/bubble-core/src/utils/run-grounding.test.ts` (vitest):
  - Drift: off-contract real response → `BubbleDriftError` with code
    `OUTPUT_MISMATCH` + structured deviations; observer receives the event
    even when the throw is swallowed; input-validation errors carry NO drift
    code (distinctness); `isDriftError` matches foreign-module errors by code.
  - Docs-lie: doc-said-read returning HTTP 201 → reclassified to
    `read_with_side_effects` (source `observed`), correction observer fired
    once, later instances resolve the corrected class, re-runs never re-learn;
    clean reads untouched; state-probe path catches marker-less mutation;
    corrected op is mocked in test mode; bare `id` is not evidence.
  - Persistence: correction recorded via `FileSideEffectOverrideStore` in
    "process 1" loads in a fresh registry ("process 2") and refuses
    re-recording.
  - Sign-off enforcement: unapproved write MOCKED (performAction count 0);
    approved variableId-key executes; child-of-approved-prefix covered,
    stranger blocked; reads untouched.
  - `computeWriteSet`: classified write listed with citation, read excluded;
    fail-safe for variable operations / unknown ops / metadata-less bubbles;
    runtime-corrected read joins the write set; pure-read flow → empty set.
- `packages/bubble-runtime/src/runtime/BubbleRunner.grounding.test.ts`
  (vitest, real generated-code temp-file path):
  - drift → `result.errorCode === 'OUTPUT_MISMATCH'` + drift events (not a
    generic failure);
  - flow code catching the drift error → run succeeds but `result.drift`
    still populated (the reference-build bug proven fixed);
  - `enforceWriteSignOff` blocks the write-default bubble without approval
    and executes it with exactly the keys `computeWriteSet` emits (parse-time
    identity == runtime identity, end-to-end);
  - authoring under a fetch spy → zero network calls.

Gate results are recorded at the bottom of this file.

## References

- `docs/plan/HANDOFF.md` §5, §9 (improvement-plan branch);
  `docs/plan/REPO-MAP.md` §3 (IR-9/10), §4a step 5, §4b.
- Reference implementation: `integration_stitcher/packages/tester/src/gate.ts`
  (`downgradeLyingRead`, auto-run gate), `tester.ts` (state-probe verification
  loop), `deviance.ts` (deviation shape), `observation.ts`.
- MCP ToolAnnotations (idempotent/destructive defaults):
  https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations

## Gate results (2026-07-15, WSL /mnt/c)

(recorded after the build/test run below)
