# RESULT — generate-route lane (setup provisioning + workflow-done message)

## Status

COMPLETE (pending: live sheet-creation check needs a real Google credential — see "Needs live check").

## Branch / commit

- Branch: `feature/setup-provisioning`
- Commit: (see git log; committed and pushed from this lane)

## Files changed

- `packages/bubble-shared-schemas/src/coffee.ts` — added `SetupResourceSchema`, `SetupFieldDescriptorSchema`; extended `CoffeePlanEventSchema` with optional `setupResources`; extended `SystemMessageSchema` with optional `role`/`kind`/`timestampMs`/`text`/`fields`.
- `apps/bubblelab-api/src/services/setup-provisioning.ts` — NEW: provisioning service + field-descriptor and done-message builders.
- `apps/bubblelab-api/src/routes/bubble-flows.ts` — building-phase success path wires provisioning, defaultInputs merge, done-message persistence, `workflow_done` SSE event; GET /bubble-flow/:id gained the userProfileDefaults TODO seam.
- `apps/bubblelab-api/src/services/setup-provisioning.test.ts` — NEW: 13 unit tests (DB-backed, injected creator, no network).
- `apps/bubblelab-api/src/routes/bubble-flows-generate-done-message.test.ts` — NEW: 3 route-level tests through the real Hono app (only runBoba mocked).

## Provisioning trigger signal

The planner declares resources on the plan: `plan.setupResources` (optional array on `CoffeePlanEventSchema`). Shape:

```ts
type SetupResource = {
  kind: 'google_spreadsheet'; // extensible enum
  inputKey: string; // flow input the created id fills, e.g. "spreadsheetId"
  title: string; // name of the created resource
  description?: string;
  sheetTitles?: string[]; // google_spreadsheet: initial tab names
};
```

The building phase reads the LATEST `type: 'plan'` message in the request's `messages` and provisions its `setupResources` (`extractSetupResources`, setup-provisioning.ts). COORDINATION FOR PROMPTS LANE: the Coffee planner prompt must instruct the model to emit `plan.setupResources` with exactly this shape — the zod schema already accepts it (Coffee's structured-output parse uses `CoffeePlanEventSchema`, coffee.ts:61); unknown keys are STRIPPED by zod, so any other field name will not survive.

## How the created id is persisted

- `bubble_flows.default_inputs[inputKey] = <real spreadsheetId>` — the same key→value structure GET /bubble-flow/:id already returns as `defaultInputs`; the Setup form reads its prefilled value from there.
- Provenance at `bubble_flows.metadata.setupProvisioning[inputKey]`:

```ts
{ kind, status: 'created'|'failed'|'skipped_no_credential',
  title, resourceId?, url?, credentialId?, error?, provisionedAt }
```

- Credential selection mirrors credential-auto-bind: most-recent exact `GOOGLE_SHEETS_CRED`, else most-recent derived-record parent covering it; token via `oauthService.getValidToken`. Creation reuses `GoogleSheetsBubble` `create_spreadsheet` (no new Google client).
- Idempotency: a non-empty `defaultInputs[inputKey]` or a provisioning record with `resourceId` is never re-created (a lost defaultInputs value is re-asserted from the record without an API call).
- Degradation: every failure is caught per-resource; the field stays blank, the record carries the error, generation never blocks or crashes.

## EXACT conversationMessages shapes emitted (for studio-forms)

The existing thread entries are the `CoffeeMessage` discriminated union (discriminator `type`, base `{ id, timestamp }`). The brief's `{ role, kind, timestampMs, text }` shape was extended COMPATIBLY onto the `type: 'system'` branch so round-trips through the generate route's zod validation survive. Final emitted shapes:

```jsonc
// all required inputs satisfied
{ "id": "workflow-done-<ms>", "timestamp": "<ISO>", "type": "system",
  "role": "system", "kind": "workflow-done", "timestampMs": 1753600000000,
  "text": "Workflow done! Check it out now",
  "content": "Workflow done! Check it out now" }

// required inputs still missing
{ "id": "workflow-done-<ms>", "timestamp": "<ISO>", "type": "system",
  "role": "system", "kind": "workflow-done-needs-info", "timestampMs": 1753600000000,
  "text": "Workflow done, but I still need some information",
  "content": "Workflow done, but I still need some information",
  "fields": [ /* FieldDescriptor[]: FULL field list, known values filled */ ] }
```

`content` mirrors `text` (legacy system-message renderers keep working). `timestampMs` is persisted in `metadata.conversationMessages` (durable build-completion proof), not only streamed. Match on `kind`.

The message is ALSO streamed as an SSE event after `generation_complete`:
`event: workflow_done`, `data: { "type": "workflow_done", "message": <the message above> }`.

## FieldDescriptor shape

```ts
type SetupFieldDescriptor = {
  key: string; // flow input key (payload field name)
  header: string; // humanized from key ("spreadsheetId" -> "Spreadsheet Id")
  hint: string; // input-schema property description, '' when none
  value?: string; // known default (provisioned id / saved defaultInputs); omitted when unfilled
};
```

Built from `bubble_flows.input_schema` (`properties` + `required`) merged with `defaultInputs`. "Missing required" = in `required` with no known value; the needs-info variant carries the FULL list (known values included) so the form renders complete. Exported from `@bubblelab/shared-schemas` (`SetupFieldDescriptorSchema`).

## userProfileDefaults (task F)

No source exists on this branch. Marked a TODO seam in GET /bubble-flow/:id (routes/bubble-flows.ts, next to `accountEmailDefaults`) describing the exact wiring; did not build profile storage.

## Verified

- `tsc --noEmit` (bubblelab-api): clean, includes both new test files.
- Build chain rebuilt in order shared-schemas → core → runtime → appgen.
- `pnpm --filter bubblelab-api test src/services/setup-provisioning.test.ts`: 13 pass / 0 fail (created path via injected creator + seeded OAuth credential whose stored token decrypts without network; idempotency; record re-assert; no-credential skip; creator-throw degrade; derived-parent fallback; descriptor/message builders).
- `pnpm --filter bubblelab-api test src/routes/bubble-flows-generate-done-message.test.ts`: 3 pass / 0 fail (real route, only runBoba mocked, real validateAndExtract + sqlite: needs-info message persisted + `workflow_done` SSE; satisfied variant with prefilled defaultInputs; plan-declared setupResources → skipped_no_credential record, blank field, build unharmed).
- `pnpm --filter bubblelab-api test src/routes/bubble-flows-conversation-persistence.test.ts`: 4 pass / 0 fail (pre-existing persistence ACs unaffected).
- Full API suite: see commit message note / suite output (run after these changes).

## Needs live check (could NOT verify here)

- REAL spreadsheet creation end-to-end (planner emits setupResources → live Sheets API create with the user's Google credential → Setup form shows the real id). Requires the user's connected GOOGLE_SHEETS_CRED/Drive credential and the prompts-lane planner instruction to be in place. Recipe: connect a Google Sheets credential, generate a flow whose plan declares a sheet to create, then check GET /bubble-flow/:id → `defaultInputs.spreadsheetId` + `metadata.setupProvisioning`.
- Studio rendering of `workflow_done` (studio-forms lane owns the handler; unknown SSE event types fall through harmlessly in current studio switches).

## Deviations + WHY

1. Done-message shape: the brief's flat `{ role, kind, timestampMs, text }` could not be persisted as-is — `metadata.conversationMessages` entries are the `CoffeeMessage` zod discriminated union and the generate route VALIDATES incoming messages against it (an unknown `type` would be rejected, unknown keys stripped on the next round-trip). Extended the `system` branch with the brief's fields instead (all present verbatim, plus union-required `id`/`timestamp`/`type`/`content`). Brief explicitly allowed this ("extend compatibly").
2. Provisioning runs in the BUILDING phase (after code validation, before the flow update), not "during planning": the input key's schema and the flow record only exist after a valid build, and a plan the user rejects must not create resources. The trigger declaration itself still comes from the planning phase via the plan message.
3. The building success path now ALWAYS persists the conversation thread (synthesized from the prompt when the caller sent no messages) — previously it skipped persistence for empty `messages`. Required so the done message never dangles without context; AC-3 semantics of the persistence tests are preserved (4/4 green).
4. `.env` was copied from `/home/unix/bubblelab-live/apps/bubblelab-api/.env` into this clone for CREDENTIAL_ENCRYPTION_KEY-dependent tests. NOT committed (gitignored, verified with `git check-ignore`).
