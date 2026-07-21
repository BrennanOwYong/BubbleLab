# auto-select-credentials-on-flow — RESULT

- Branch: `feature/auto-select-credentials-on-flow` (off live HEAD `b0d5837`)
- Implementation commit: `d51f1d0`
- Final commit: see `git log -1` on the branch (this doc committed after `d51f1d0`)

## What was delivered

A freshly created workflow arrives with its required credentials already
selected per step, visible in the editor with zero clicks, persisted in the
stored flow, and correct for server-side (webhook/cron) execution. A step
with no matching connected credential shows the amber "Select credential..."
state, never a silent blank.

## Files changed (one line each)

API

- `apps/bubblelab-api/src/services/credential-auto-bind.ts` (new) — single-match auto-bind: exact-type else derived-record parent, exactly-one or nothing.
- `apps/bubblelab-api/src/services/credential-auto-bind.test.ts` (new) — 9 tests for the service against the real sqlite test DB.
- `apps/bubblelab-api/src/routes/bubble-flows.ts` — auto-bind wired into create (before insert), validate sync + response branches, and the Pearl generation save.
- `apps/bubblelab-api/src/services/bubble-flow-execution.ts` — execution backstop: auto-bind + persist before every tracked run (manual, webhook, cron, test).

Studio

- `apps/bubble-studio/src/stores/executionStore.ts` — `mergeCredentials` (per-slot merge, server wins, nothing dropped) and `suppressedAutoBindSlots` (deliberate clears via `setCredential(null)`; a fresh selection lifts suppression).
- `apps/bubble-studio/src/hooks/useValidateCode.ts` — validation round-trip merges instead of replacing `pendingCredentials` (WIPE fix).
- `apps/bubble-studio/src/components/FlowIDEView.tsx` — flow-load extraction merges instead of replacing; mounts the persist hook.
- `apps/bubble-studio/src/hooks/useFlowGeneration.ts` — removed the stale-store closure that wiped the PREVIOUS flow's credentials/cache on template create.
- `apps/bubble-studio/src/hooks/useAutoBindCredentials.ts` — re-asserts on every `pendingCredentials` change instead of bind-once-per-mount; suppressed slots skipped; telemetry deduped per (slot, credential).
- `apps/bubble-studio/src/hooks/usePersistCredentialBindings.ts` (new) — PUTs selections into stored `bubbleParameters` (debounced, diff-signature-guarded) so bindings survive reload without a Run.
- `apps/bubble-studio/src/lib/credentialBinding.ts` — `computeAutoBindings` falls back to derived-record credentials (reason `derived_record`); `computeSuiteBindingProposals` also proposes the ALREADY-BOUND sibling so the scope probe confirms/rolls back; new `getDerivedRecordCandidates`.
- `apps/bubble-studio/src/lib/credentialBinding.test.ts`, `apps/bubble-studio/src/stores/executionStore.test.ts` — coverage below.

## Three-hole fixes mapped

1. WIPE+DEADLOCK — `useValidateCode` and `FlowIDEView` now merge per slot (`mergeCredentials`); `useFlowGeneration`'s stale-store `setAllCredentials({})` (and its wrong-flow `updateBubbleParameters`) removed; `useAutoBindCredentials` re-asserts after any external wipe because the bind-once `appliedSlotsRef` is gone and the effect subscribes to `pendingCredentials`. Deliberate clears survive: `setCredential(null)` suppresses the slot for auto-bind AND for server-merge resurrection.
2. NOTHING BINDS AT IDENTIFICATION TIME / NO PERSIST — the server binds and PERSISTS at create, generation save, and validate sync; the studio persist hook covers bindings made after creation (new credential connected, suite binding); the execution backstop makes webhook/cron correct even for flows that never reached either path.
3. SUITE/DERIVED NOT USED FOR EXACT SLOTS — `computeAutoBindings` consumes `derivedCredentials` records client-side; the server service consults the `derived_credentials` table; the scope probe remains confirmation/rollback (suite proposals now target the bound sibling), never a gate for the initial selection.

## Tests

Studio unit (vitest, full suite): **164 pass / 0 fail** (10 files).
New/extended cases:

- `credentialBinding.test.ts` — falls back to a derived-record credential (suite zero-click); exact-type beats derived-record sibling; recency default among several record-covered siblings; suite proposals skip exact-bound slots, skip out-of-group bound slots, and propose the ALREADY-BOUND sibling for confirmation (plus all pre-existing cases).
- `executionStore.test.ts` (new) — empty validation round-trip drops nothing; server value wins its slot while unrelated slots survive; user-cleared slot is not resurrected by merge; `setCredential(null)` suppresses / fresh selection lifts; external `setAllCredentials` wipe suppresses nothing; re-assert contract: externally wiped slot re-fills, user-cleared slot stays empty.

API (bun test, full suite): **223 pass / 21 skip / 0 fail** (244 across 33 files).
New `credential-auto-bind.test.ts` (9 tests): single exact-type binds; several exact-type bind nothing; single derived-record parent binds when no exact type; exact beats derived; several derived parents bind nothing; already-bound slot untouched; system slots (ai-agent) skipped; another user's credential never used; several independent slots bound in one pass.

Live headless smoke (ALT ports API 3011 / studio 3010, fresh dev.db, seeded `mock-user-id` creds mirroring live: #2 TELEGRAM_BOT_TOKEN "Jiggly Bot", #4 GMAIL_CRED with spreadsheets+calendar scopes → derived records materialized by GET /credentials, #5 GOOGLE_SHEETS_CRED "Brennan Sheets"): **7/7 checks pass** (`/home/unix/pw-gui-test/auto-select-smoke.mjs`):

- sheets + telegram auto-selected on first load (values 5/2, labels shown), ZERO clicks
- both still selected after reload
- slack flow with no matching credential shows empty select with "Select credential..." and the amber missing-state border
- no page errors

Screenshots: `pw-artifacts/auto-select-credentials-initial.png`, `auto-select-credentials-after-reload.png`, `auto-select-credentials-needs-connect.png`.

Live execution-backstop probe: stripped flow 1's stored bindings in the DB, called POST `/bubble-flow/1/execute` → HTTP 200, and the stored row was re-bound (`414: {GOOGLE_SHEETS_CRED:5}`, `415: {TELEGRAM_BOT_TOKEN:2}`) before the run.

## Deviations from the brief

1. **Identification-time binding moved server-side.** The brief suggested invoking `computeAutoBindings` in `useCreateBubbleFlow.onSuccess` / Pearl generation-complete. The create and generation-save routes now bind BEFORE the flow row is written, so the create response and the post-generation refetch already carry bound parameters. Use: stronger than a client-side bind (persisted from birth, no client race, works when the editor never opens); the client hooks remain the re-assert layer for credentials connected after creation.
2. **Server also refills on validate.** Beyond the four seams named in the brief, the validate route's sync and response branches run the same single-match refill, making every validation self-healing server-side. Consequence: a user-cleared slot with exactly one match re-binds in the validate RESPONSE; the client's suppression set ignores that slot while the session lasts, but the DB keeps the binding. Deliberate emptiness is a transient state (Run blocks on missing credentials anyway), so persistence-of-clear across reloads was traded away for the durable auto-select invariant.
3. **Server rule is exactly-one, client rule keeps default-of-many.** The server never guesses between several accounts (invisible wrong-account risk); the editor still defaults to the most recent with the chooser visible, per the pre-existing UX.

## Not done / owned by main session

- No deploy to :3000; live clone untouched.
- ALT servers (3011/3010) stopped after verification; this clone's dev.db contains the smoke seeds.
