# Setup/repeatable-boundary fix — verification result (PoC)

Date: 2026-07-28. Verified against the live API (localhost:3001, commit 7ac08db live, runtime dist rebuilt 17:03). Driver script: /tmp/verify-setup/gen.mjs (throwaway; POST /bubble-flow/empty → /generate?phase=planning → plan approval → /generate?phase=building, SSE parsed).

Throwaway flows created: **35** (PoC Daily Log), **36** (PoC SQRil Verify — see task 4). Delete both when done.

## Task 1+2 — PoC Daily Log flow (flow 35)

Prompt: "Every day at 9am, append one summary row to a Google Sheet you set up for this flow called 'PoC Daily Log', and send me the summary on Telegram."

### (a) Planner emits setupResources — PASS

Planning-phase plan JSON (from `stream_complete.coffeeResult.plan`):

```json
"setupResources": [
  { "kind": "google_spreadsheet", "inputKey": "spreadsheetId", "title": "PoC Daily Log", "sheetTitles": ["Daily Log"] }
]
```

### (b) Provisioning ran once, real ID in defaults — PASS

GET /bubble-flow/35 after building:

```json
"defaultInputs": { "spreadsheetId": "1Kq1BIISXRJp8ul6N9d4GtsIwH6awn0CycbJ2gr54rIA" },
"metadata.setupProvisioning": {
  "spreadsheetId": {
    "kind": "google_spreadsheet", "title": "PoC Daily Log", "status": "created",
    "resourceId": "1Kq1BIISXRJp8ul6N9d4GtsIwH6awn0CycbJ2gr54rIA",
    "url": "https://docs.google.com/spreadsheets/d/1Kq1BIISXRJp8ul6N9d4GtsIwH6awn0CycbJ2gr54rIA/edit",
    "credentialId": 4, "provisionedAt": "2026-07-28T13:30:19.309Z"
  }
}
```

Status is `created` (not skipped): GOOGLE_SHEETS_CRED id 4 is healthy; a real spreadsheet exists at the URL above.

### (c) Generated code clean — PASS

Greps over original_code (7941 chars, class PocDailyLogFlow, cron `0 9 * * *`):

- `create_spreadsheet`: absent
- `get_spreadsheet_info` / any existence probe: absent
- `ensure*` methods: absent
- Only Sheets call: `operation: 'append_values'` with `spreadsheet_id: spreadsheetId` taken from the payload; `spreadsheetId` is a documented flow input (`@header Daily log sheet`).

Observation (not an assertion failure): the payload destructuring carries a hardcoded fallback `spreadsheetId = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'` (Google's docs sample ID). Runs driven by defaultInputs use the provisioned ID, so this fallback is dead in practice, but `no-placeholder-values` did not flag it.

## Task 3 — lint rule `no-create-if-missing`

Snippets: /tmp/verify-setup/bad-flow.ts (private `ensureLogSpreadsheet`: `get_spreadsheet_info` → on `!info.success` → `create_spreadsheet` of the same GoogleSheetsBubble), /tmp/verify-setup/good-flow.ts (spreadsheet_id from payload, `append_values` only).

Run through `defaultLintRuleRegistry.validateAll` from the live API's own dependency (`apps/bubblelab-api/node_modules/@bubblelab/bubble-runtime/dist/validation/lint-rules.js`):

- BAD → **1 error, PASS**: `line 24: Create-if-missing setup detected: 'create_spreadsheet' runs only when 'get_spreadsheet_info' fails. A fixed resource the flow reuses across runs is one-time SETUP: it is provisioned at build time (plan setupResources) and its real id arrives as a flow input, so the flow must assume it already exists. Remove the existence check and the in-flow creation and take the resource id from the payload. ...`
- GOOD → **0 create-if-missing errors, PASS**

Enforcement-path caveat (found while verifying, no source touched):

- The standalone `POST /bubble-flow/validate` endpoint calls `validateAndExtract(code, factory, false)` (bubble-flows.ts:1279) — `requireLintErrors=false`, and its response drops the `lintErrors` field, so the BAD snippet comes back `valid: true` there. The endpoint is not the lint gate.
- The generation save path IS the gate: bubble-flows.ts:1709 calls `validateAndExtract(code, factory)` with the default `requireLintErrors=true`; lint-violating code fails `valid` and is never saved.
- Boba's in-loop `bubbleflow-validation-tool` uses bubble-core's own `validateBubbleFlow` (packages/bubble-core/src/utils/bubbleflow-validation.ts), which runs no lint rules at all. So during generation Boba never sees the lint message as repair feedback; the prompt rules plus the save gate are what keep ensureX out.

## Task 4 — SQRil re-run (trimmed to 3 countries) — flow 36

Prompt: flow 34's original prompt trimmed to Indonesia/Vietnam/Philippines, kept the two sheet-creation asks verbatim ("if it doesn't already exist, create a Google Sheet called 'SQRil Merchant Pipeline'..." and "save each day's briefing to a Google Sheet (create one called 'SEA Market Watch')").

- Clarification round fired (timezone, sheet columns, gmail filter, telegram destination — none about sheet existence); plan arrived on round 2.
- **setupResources emitted: FAIL.** The plan JSON has NO `setupResources` key; steps say "Reads the current rows in your merchant pipeline spreadsheet" / "Appends a new row to your market watch log spreadsheet", treating both sheets as pre-existing. Coffee's own prompt (services/ai/coffee.ts:126) calls this omission "a planning error" — both sheets are fixed reused resources the user asked to be created.
- **defaultInputs populated: FAIL (consequence).** GET /bubble-flow/36 → `defaultInputs: {}`, `metadata.setupProvisioning` absent. The user must paste `pipelineSpreadsheetId` and `marketWatchSpreadsheetId` by hand; both carry the Google sample-ID fallback `'1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'` in the destructuring defaults.
- **No ensureX in code: PASS.** 16509-char SqrIlSeaMorningBriefFlow (cron `0 23 * * *` = 7am SGT): zero `create_spreadsheet`, zero `get_spreadsheet_info`, zero `ensure*`; both sheet IDs are payload inputs with @header/@hint.
- **No duplicate 'SEA Market Watch' sheets: PASS (vacuously).** Nothing created any sheet — provisioning never ran and the code cannot create one.

## Verdict

The boundary half of the fix holds on both runs: generated code never self-creates or existence-checks fixed sheets, and the `no-create-if-missing` lint (live in the API's runtime dist) rejects the ensureX pattern with the prescriptive message. The provisioning half works end-to-end when the planner emits `setupResources` (flow 35: real sheet created, real ID prefilled) but the planner's emission is unreliable: the flow-34-style prompt, which asks for two sheets by name, produced a plan with no `setupResources` at all (flow 36), leaving the user to hand-paste both IDs against sample-ID placeholder defaults. Failure point: Coffee's plan generation, not the provisioning service, the save gate, or the lint.

Secondary findings:

1. `POST /bubble-flow/validate` runs lint with `requireLintErrors=false` (bubble-flows.ts:1279) and omits `lintErrors` from its response — it will report ensureX code as `valid: true`. The save gate (bubble-flows.ts:1709, default true) is the enforcement point.
2. Boba's in-loop `bubbleflow-validation-tool` (bubble-core's own validateBubbleFlow) runs no lint rules, so a lint violation surfaces only at save time as a generation failure, never as repair feedback inside the generation loop.
3. `no-placeholder-values` does not catch the Google sample spreadsheet ID used as a destructuring default (present in both flows 35 and 36; harmless in 35 where defaultInputs override it, harmful in 36 where they don't).

Cleanup: delete flows 35 and 36; the provisioned sheet "PoC Daily Log" (1Kq1BIISXRJp8ul6N9d4GtsIwH6awn0CycbJ2gr54rIA) can be trashed in Drive.
