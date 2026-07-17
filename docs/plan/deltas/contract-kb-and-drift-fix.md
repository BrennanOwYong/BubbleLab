# Delta: IR-11/12 — Contract KB + the drift bug fix

Branch: `improve/contract-kb-and-drift-fix`. Grafts the verified Contract
Knowledge Base design from the reference implementation
(`integration_stitcher/packages/kb`) onto BubbleLab, and fixes the bug that
kept the reference KB lab-only: the output-contract-violation signal
collapsed at a wrapper boundary and nothing consumed it, so the KB never
learned from production traffic.

## The drift bug, in BubbleLab terms

Before this branch, a real API response that violated a bubble's declared
`resultSchema` threw a plain `BubbleValidationError`
(`base-bubble-class.ts`, result-validation catch) — the SAME class as
input-validation failures — and `BubbleRunner.runAll()` collapsed it into a
prose `error` string on the `ExecutionResult`. Three collapse points, one
worse than the others:

1. `BaseBubble.action()` — the violation was typed like any validation error.
2. `BubbleRunner.runAll()` catch — typed error → prose string.
3. Generated flow code — a user `try/catch` around `bubble.action()` could
   swallow the error entirely, leaving NO trace anywhere.

Nothing downstream could identify drift, and nothing consumed it.

## The fix: two carriers, both originating at the validation site

1. **Distinct error**: `BubbleOutputContractViolationError` (extends
   `BubbleValidationError`, so every existing `instanceof` branch keeps
   working) with stable `code: 'OUTPUT_CONTRACT_VIOLATION'`, structured
   `driftFindings` (path + message per mismatch), `observedOutput`,
   `operation`, `callSiteKey`. `BubbleRunner` checks it FIRST (it subclasses
   the generic error) and maps it to `ExecutionResult.errorCode` +
   `ExecutionResult.drift` instead of prose;
   `executeBubbleFlowWithTracking` forwards both — no boundary collapses it.
2. **Observation sink** (the survival channel): `BaseBubble.action()` emits a
   `ContractObservation` through `executionMeta.contractObservationSink`
   BEFORE any error propagation — so a user try/catch that swallows the
   error cannot swallow the signal. Emissions:
   - schema-conforming real result with `success: true` → grounded observation
   - violating real result → grounded observation + `driftFindings` +
     `errorCode` (a drifted response IS ground truth — the anti-poison gate
     decides whether it is an anomaly or consistent drift)
   - `success: false` results → NOT emitted (their shape is the error shape;
     a persistent 500 can never heal a contract toward its error payload)
   - test-mode mocked results → emitted with `grounded: false` so the KB's
     refusal is explicit and auditable
   - sink failures are caught: a broken consumer never breaks execution.

## The Contract KB

- **Engine** (`packages/bubble-core/src/contract-kb/`, pure + programmatic,
  no LLM anywhere): structural schema inference (`ValueSchema`), canonical
  fingerprinting, per-node channels with IMMUTABLE versions, pending
  clusters, diff, rollback. Keyed by BubbleLab's EXISTING per-call-site
  identity (`invocationCallSiteKey ?? currentUniqueId`, with
  `operation:<op>` / `bubble:<name>` fallbacks) — no new identity layer.
- **Anti-poison**: a contract mutates only after 3 (default) observations
  with an IDENTICAL structural fingerprint. One anomalous response (a 500
  shape, a malformed payload) lands in a pending cluster and never rewrites
  the contract. Mocked observations are refused outright.
- **Rollback**: re-points the active version; the bad version stays in
  history marked `rolledBackAt`; pending evidence is purged so re-promotion
  needs a fresh run of N consistent observations and mints a NEW version.
- **Recorded samples**: each channel keeps the latest grounded sample;
  `getRecordedMock()` (test-mode seam from the test-mode-switch branch) is
  now served by `createRecordedMockProvider()` — test-mode mocks are
  recorded reality instead of `MockDataGenerator` fiction, once production
  has run.
- **Storage** (`apps/bubblelab-api`): `contract_kb_documents` (one
  Zod-validated document per integration: versions, pending clusters,
  samples) + `contract_observations` (append-only audit log with
  provenance: production vs test, grounded, accepted, action, errorCode,
  flow/execution ids). The original branch commits shipped the schema
  changes WITHOUT drizzle migrations, so `migrate()` never created the
  tables and every API suite failed at `beforeEach` with "no such table:
  contract_observations". The follow-up fix commit generates them for both
  dialects (`drizzle-sqlite/0018_material_luke_cage.sql`,
  `drizzle-postgres/0018_sudden_frank_castle.sql`), each creating
  `contract_kb_documents` and `contract_observations`.
- **THE CONSUMER** (`apps/bubblelab-api/src/services/contract-kb-service.ts`
  wired in `execution.ts#runBubbleFlowCommon`): every run — production and
  test — gets a collector sink on `executionMeta`; after `runAll()` the
  collected observations are ingested into the KB and the audit log,
  best-effort, never affecting the run result. Production traffic feeding
  the KB is the acceptance criterion the reference build failed.

## Files

- `packages/bubble-shared-schemas/src/contract-observation.ts` (new):
  `ContractObservation`, `ContractObservationSink`, `ContractDriftFinding`,
  `OUTPUT_CONTRACT_VIOLATION`, `ExecutionDriftRecord`.
- `execution-meta.ts`, `bubble.ts`: `contractObservationSink` seam.
- `bubbleflow-execution-schema.ts`: `errorCode` + `drift` on
  `ExecuteBubbleFlowResponse`/`ExecutionResult`.
- `packages/bubble-core/src/types/bubble-errors.ts`:
  `BubbleOutputContractViolationError`.
- `packages/bubble-core/src/types/base-bubble-class.ts`: observation
  emission + distinct violation throw.
- `packages/bubble-core/src/contract-kb/`: the engine
  (`value-schema.ts`, `document.ts`, `store.ts`, `contract-kb.ts`).
- `packages/bubble-core/src/bubbles/service-bubble/contract-drift-probe.ts`
  (+ colocated `.metadata.ts`, IR-8 format): in-process diagnostic bubble
  (read op that can conform or drift; write op with a deterministic
  receipt) — the platform's own probe for the drift pipeline, registered
  like `hello-world`.
- `packages/bubble-runtime/src/runtime/BubbleRunner.ts`: drift branch
  (checked before the generic validation branch) preserving
  `errorCode`/`drift` on `ExecutionResult`.
- `apps/bubblelab-api`: schema (sqlite/postgres/unified) + migrations,
  `contract-kb-service.ts`, wiring in `execution.ts` and
  `bubble-flow-execution.ts` (which also forwards `errorCode`/`drift`).

## Deviations from the REPO-MAP patch plan

- REPO-MAP §3 names tables `recorded_contracts` + `contract_observations`.
  Implemented as `contract_kb_documents` (whole per-integration document,
  matching the engine's document model — versions and pending clusters are
  internally consistent and Zod-validated as one unit) plus the prescribed
  `contract_observations` audit log. Same information, fewer consistency
  invariants to maintain across rows.
- REPO-MAP sequences the Contract KB "after the Tester" (IR-9/10) with
  `flow-tester.ts` as an ingest point. The Tester branch is not on main;
  this branch wires the two ingest sources that exist today — production
  runs and `POST /:id/test` test-mode runs — through one seam
  (`contractObservationSink` on `executionMeta`). A future flow-tester
  consumes the same seam with zero engine changes.
- `get-bubble-details-tool` grounding (serving recorded contracts to the
  codegen catalogue) is NOT done here — it belongs to the codegen/prompt
  pass (REPO-MAP §3 "NL-prompt → workflow generator" step 2). The data is
  ready: `ContractKb.latestSample()` / `activeVersion()`.
- Known limitation, deliberate: the document store is last-write-wins per
  integration; concurrent runs of the same integration can drop each
  other's pending-cluster increments (never a promoted version — promotion
  re-reads on the next open). Acceptable for the current single-writer
  ingest (post-run, sequential); a `SELECT ... FOR UPDATE` around ingest is
  the postgres upgrade path.

## How it was verified

(Results recorded from the gate run on this branch; see final section.)

- `packages/bubble-core/src/contract-kb/contract-kb.test.ts` — engine
  acceptance: loose contract converges to ground truth after 3 consistent
  observations; ONE anomaly (500 shape) never mutates; two inconsistent
  anomalies never promote while 3 consistent drifts heal; mocked
  observations refused; versions immutable + diffable; rollback purges
  pending evidence and re-promotion mints a new version; latest grounded
  sample served; store round-trip.
- `packages/bubble-core/src/types/base-bubble-drift-signal.test.ts` — real
  `ContractDriftProbeBubble` through the real `action()` lifecycle: distinct
  error with stable code and named findings; observation SURVIVES a user
  try/catch; executionMeta channel honored; mocked results emit
  `grounded: false`; broken sink never breaks execution.
- `packages/bubble-runtime/src/runtime/BubbleRunner.drift-signal.test.ts` —
  the generated-code path (temp-file import): `ExecutionResult` carries
  `errorCode: OUTPUT_CONTRACT_VIOLATION` + structured `drift`; the sink
  receives the grounded drift observation through the wrapper boundary.
- `apps/bubblelab-api/src/services/contract-kb-production.test.ts` — ★ the
  acceptance criterion: a PRODUCTION run (no testMode) through
  `executeBubbleFlowWithTracking` whose bubble violates its resultSchema
  produces (1) an identifiable ExecutionResult (`errorCode` + `drift`),
  (2) a `contract_observations` row with `source: 'production'`,
  `grounded: true`, `errorCode: OUTPUT_CONTRACT_VIOLATION`,
  `action: 'pending'`, and (3) pending evidence in the KB document with the
  active contract UNMUTATED by the single anomaly. Plus: production
  convergence after 3 runs; rollback; test-mode refusal
  (`action: 'refused'`, no document created from mocks); and the recorded
  production write served back as the test-mode mock
  (`receipt-1` / `production-note` instead of generated fiction).

## References

- Design source: `docs/plan/HANDOFF.md` §9 (drift bug), §5 (test-mode seam);
  `docs/plan/IMPROVEMENT-REGISTER.md` IR-11/12; `docs/plan/REPO-MAP.md` §3.
- Reference implementation (read-only):
  `integration_stitcher/packages/kb/src/{kb,schema,document,store}.ts`.

## Gate results

(TO BE FILLED by the verification run below.)
