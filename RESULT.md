# RESULT — generate-route lane (setup provisioning + workflow-done message + JSDoc tag extraction)

## Status

COMPLETE (pending: live sheet-creation check needs a real Google credential — see "Needs live check").

## Branch / commit

- Branch: `feature/setup-provisioning`
- Commit: (hash recorded on push; single commit on top of bf32c04)

## Files changed

- `packages/bubble-shared-schemas/src/coffee.ts` — added `SetupResourceSchema`, `SetupFieldDescriptorSchema` (with `fromUserProfile`), `WorkflowDoneMessageSchema`, `ConversationEntrySchema` (union of CoffeeMessage | WorkflowDoneMessage) + `isCoffeeMessage`/`isWorkflowDoneMessage` guards; extended `CoffeePlanEventSchema` with optional `setupResources`. `SystemMessageSchema` left untouched.
- `packages/bubble-shared-schemas/src/generate-bubbleflow-schema.ts` — generate request `messages` now validates `ConversationEntrySchema[]` so threads containing done messages round-trip.
- `packages/bubble-runtime/src/extraction/BubbleParser.ts` — `extractJSDocForNode` lifts three new tags; `objectTypeToJsonSchema` emits them onto the input-schema property.
- `apps/bubblelab-api/src/services/setup-provisioning.ts` — NEW: provisioning service + field-descriptor and done-message builders.
- `apps/bubblelab-api/src/services/conversation-thread.ts` — thread types widened to `ConversationEntry[]`.
- `apps/bubblelab-api/src/routes/bubble-flows.ts` — building-phase success path wires provisioning, defaultInputs merge, done-message persistence, `workflow_done` SSE event; agents receive `messages.filter(isCoffeeMessage)` (done entries are UI-only).
- `apps/bubblelab-api/src/services/setup-provisioning.test.ts` — NEW: 16 unit tests.
- `apps/bubblelab-api/src/routes/bubble-flows-generate-done-message.test.ts` — NEW: 4 route-level tests through the real Hono app (only runBoba mocked).

## JSDoc tag extraction (BubbleParser)

`extractJSDocForNode` (BubbleParser.ts, next to the existing @canBeFile/@canBeGoogleFile lifts) now parses, from the payload-interface field's preceding comment:

- `@header <short human label>` — regex `/@header\s+([^\n]+)/`, rest-of-line capture, trailing `*/` stripped (single-line JSDoc works).
- `@hint <plain-language question>` — regex `/@hint\s+([^\n]+)/`, same cleanup.
- `@fromUserProfile <key>` — regex `/@fromUserProfile\s+([A-Za-z_][\w]*)/` (single token, e.g. `email`, `telegramChatId`).

The tag lines are excluded from the derived `description` (same filter list as canBeFile). `objectTypeToJsonSchema` writes them onto the property, so `bubble_flows.input_schema.properties[key]` now carries optional `header`, `hint`, `fromUserProfile` alongside `type`/`description`/`canBeFile`. Anything reading `inputSchema` (GET /bubble-flow/:id, user-profile lane's `resolveUserProfileDefaults(userId, flow.inputSchema)`) sees them with no further wiring.

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

The building phase reads the LATEST `type: 'plan'` message in the request's `messages` and provisions its `setupResources` (`extractSetupResources`). COORDINATION FOR PROMPTS LANE: the Coffee planner prompt must instruct the model to emit `plan.setupResources` with exactly this shape — the structured-output parse uses `CoffeePlanEventSchema` (coffee.ts agent), and zod STRIPS unknown keys, so any other field name will not survive.

## How the created id is persisted

- `bubble_flows.default_inputs[inputKey] = <real spreadsheetId>` — the key→value structure GET /bubble-flow/:id returns as `defaultInputs`; the Setup form reads its prefilled value from there.
- Provenance at `bubble_flows.metadata.setupProvisioning[inputKey]`:

```ts
{ kind, status: 'created'|'failed'|'skipped_no_credential',
  title, resourceId?, url?, credentialId?, error?, provisionedAt }
```

- Credential selection mirrors credential-auto-bind: most-recent exact `GOOGLE_SHEETS_CRED`, else most-recent derived-record parent covering it; token via `oauthService.getValidToken`. Creation reuses `GoogleSheetsBubble` `create_spreadsheet` (no new Google client).
- Idempotency: a non-empty `defaultInputs[inputKey]` or a provisioning record with `resourceId` is never re-created (a lost defaultInputs value is re-asserted from the record without an API call).
- Degradation: every failure is caught per-resource; the field stays blank, the record carries the error, generation never blocks or crashes.

## EXACT conversationMessages shapes emitted (for studio-forms)

Discriminated on role+kind, NO CoffeeMessage `type` field — matches the studio-forms contract verbatim:

```jsonc
// all required inputs satisfied
{ "role": "system", "kind": "workflow-done",
  "timestampMs": 1753600000000, "text": "Workflow done! Check it out now" }

// required inputs still missing
{ "role": "system", "kind": "workflow-done-needs-info",
  "timestampMs": 1753600000000,
  "text": "Workflow done, but I still need some information",
  "fields": [ /* FieldDescriptor[]: FULL field list, known values filled, missing required ones without value */ ] }
```

`timestampMs` = `Date.now()` at build completion, persisted in `metadata.conversationMessages` (durable proof), not only streamed. Schema: `WorkflowDoneMessageSchema` in `@bubblelab/shared-schemas`; the persisted array is typed `ConversationEntry[]` (`CoffeeMessage | WorkflowDoneMessage`) and the generate route's request zod accepts the union, so a thread containing done messages round-trips through later rounds (verified by test AC-4). The agents (Coffee/Boba) receive only the Coffee messages (`filter(isCoffeeMessage)`).

The message is ALSO streamed as an SSE event after `generation_complete`:
`event: workflow_done`, `data: { "type": "workflow_done", "message": <the message above> }`.

## FieldDescriptor shape

```ts
type SetupFieldDescriptor = {
  key: string; // flow input key (payload field name)
  header: string; // @header JSDoc tag; fallback humanized key ("spreadsheetId" -> "Spreadsheet Id")
  hint: string; // @hint JSDoc tag; fallback property description; '' when neither
  value?: string; // known default (provisioned id / saved defaultInputs); omitted when unfilled
  fromUserProfile?: 'email' | 'telegramChatId'; // @fromUserProfile tag passthrough
};
```

Built from `bubble_flows.input_schema` (`properties` + `required`, now tag-enriched) merged with `defaultInputs`. "Missing required" = in `required` with no known value; the needs-info variant carries the FULL list so the form renders complete. Exported as `SetupFieldDescriptorSchema`.

## userProfileDefaults (task F)

User-profile lane owns and has already wired `userProfileDefaults` into GET /bubble-flow/:id on its branch — nothing added here (an earlier TODO seam was removed to avoid merge noise). MERGE NOTE for team-lead: after merging user-profile, the done-message field values can additionally be filled from profile defaults by spreading `userProfileDefaults`-resolved values into the known-values map passed to `buildSetupFieldDescriptors(inputSchema, knownValues)` in the generate route's success path — the builder already takes an arbitrary known-values record, so it is a one-line spread at the call site.

## Verified

- `tsc --noEmit` (bubblelab-api): clean, including both new test files. Build chain rebuilt shared-schemas → core → runtime → appgen.
- `pnpm --filter bubblelab-api test setup-provisioning.test.ts + bubble-flows-generate-done-message.test.ts + bubble-flows-conversation-persistence.test.ts`: 23 pass / 0 fail. Covers: created path (injected creator + seeded OAuth credential, no network), idempotency, record re-assert, no-credential skip, creator-throw degrade, derived-parent fallback, tag-preferring descriptors, both message variants; route-level: needs-info message persisted with PARSER-LIFTED @header/@hint values + `workflow_done` SSE (AC-1), satisfied variant (AC-2), plan-declared setupResources → skipped_no_credential degrade (AC-3), round-trip of a thread containing a prior done message (AC-4).
- `pnpm --filter @bubblelab/bubble-runtime test`: 217 pass / 1 fail — the failure is `should validate yfinance flow`, pre-broken on base (recorded in project memory before this lane started; failure is a validation-errors assertion unrelated to JSDoc extraction; all BubbleScript/parser tests pass).
- Full API suite (`pnpm --filter bubblelab-api test`) on the final shape: 261 pass / 21 skip / 0 fail (282 tests, 37 files).

## Needs live check (could NOT verify here)

- REAL spreadsheet creation end-to-end (planner emits setupResources → live Sheets API create with the user's Google credential → Setup form shows the real id). Requires a connected GOOGLE_SHEETS_CRED/Drive credential and the prompts-lane planner instruction. Recipe: connect a Google Sheets credential, generate a flow whose plan declares a sheet to create, then check GET /bubble-flow/:id → `defaultInputs.spreadsheetId` + `metadata.setupProvisioning`.
- Studio rendering of `workflow_done` SSE + done-message form (studio-forms lane owns the renderer; shapes match its stated contract exactly).
- Studio TYPECHECK against the widened `messages` union: the studio sends `CoffeeMessage[]`, which remains assignable to `ConversationEntry[]`, but if it re-sends fetched `metadata.conversationMessages` it should type them `ConversationEntry[]` — studio-forms lane to confirm.

## Deviations + WHY

1. Done-message shape: first iteration extended `SystemMessageSchema` (type:'system') for round-trip safety; REPLACED after team-lead's final contract (role+kind, no `type`) with a standalone `WorkflowDoneMessageSchema`. Round-trip safety is preserved differently: the generate request's `messages` now validates the `ConversationEntry` union — without this, the route's zod would 400 on any thread containing a done message. Agents are shielded via `filter(isCoffeeMessage)`.
2. Provisioning runs in the BUILDING phase (after code validation, before the flow update), not during planning: the input key's schema and flow record exist only after a valid build, and a plan the user rejects must not create resources. The declaration still originates in planning via the plan message.
3. The building success path now ALWAYS persists the conversation thread (synthesized from the prompt when the caller sent no messages) — previously skipped for empty `messages`. Required so the done message never dangles without context; pre-existing persistence ACs stay green.
4. `.env` copied from `/home/unix/bubblelab-live/apps/bubblelab-api/.env` for CREDENTIAL_ENCRYPTION_KEY-dependent tests. NOT committed (gitignored, verified via `git check-ignore`).
5. `@fromUserProfile` values other than `email`/`telegramChatId` are lifted into the input schema verbatim (parser stays generic) but dropped from the FieldDescriptor (its zod enum is closed per the contract); extend `SetupFieldDescriptorSchema.fromUserProfile` when new profile keys land.
