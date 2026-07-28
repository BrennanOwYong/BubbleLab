# RESULT: setup/repeatable boundary enforcement

- **Status:** complete
- **Branch:** feature/setup-repeatable-boundary
- **Commit:** 7ac08db (single feature commit on top of 1d84e06)
- **Files changed:**
  - `apps/bubblelab-api/src/config/bubbleflow-generation-prompts.ts` (rule 31 replaced)
  - `apps/bubblelab-api/src/services/ai/coffee.ts` (SETUP PROVISIONING RESPONSIBILITY section replaced)
  - `packages/bubble-runtime/src/validation/lint-rules.ts` (new rule `no-create-if-missing` + helpers, registered in `defaultLintRuleRegistry`)
  - `packages/bubble-runtime/src/validation/lint-rules.test.ts` (8 new tests)

## 1. Codegen prompt: rule 31 replaced (exact new text)

The old rule 31 ("SETUP-PROVISIONED ITEMS", which only covered defaulting provisioned ids) is replaced by:

> 31. SETUP vs REPEATABLE BOUNDARY (hard invariant): a BubbleFlow stores ONLY the repeatable work - the idempotent sequence that runs identically on every execution. One-time SETUP is everything that makes a fixed resource exist for the flow to reuse across runs (a spreadsheet it appends to every run, a database, a folder). Setup happens at BUILD time via the plan's setupResources declaration: the system creates the resource once and its REAL id - provided in the plan or conversation context - becomes the destructuring default of a payload input (with @header/@hint per rule 28). handle() and every private method ASSUME that resource already exists and use its id directly.
>
> - NEVER create fixed reused infrastructure anywhere in the flow: no create_spreadsheet/create_database/create-folder call for a resource the flow reads or writes on later runs.
> - NEVER write a create-if-missing guard for such a resource: no "fetch the resource's info, and create it when the fetch fails" (ensure-style logic), in handle() or in any private method. If the resource's id is a flow input, it exists; use it.
> - NEVER ask the user for the id of something that does not exist yet, and NEVER leave a placeholder for it (rule 21): the plan-provisioned REAL id is the destructuring default.
> - ALLOWED and unchanged: creating a FRESH artifact each run as the flow's OUTPUT (e.g. a new dated report spreadsheet produced by every execution). That is repeatable work; create it unconditionally, never behind an existence check.
>   BAD (forbidden - setup leaked into the repeatable body):
>   // Checks whether the pipeline spreadsheet exists and creates it when missing
>   const info = await new GoogleSheetsBubble({ operation: 'get_spreadsheet_info', spreadsheet_id: spreadsheetId }).action();
>   if (!info.success) {
>   const created = await new GoogleSheetsBubble({ operation: 'create_spreadsheet', title: 'Pipeline' }).action();
>   }
>   GOOD (setup stayed at build time; the flow only repeats):
>   const { spreadsheetId = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms' } = payload; // real id provisioned at build
>   // Adds the new answer row to the answers spreadsheet
>   const appendResult = await new GoogleSheetsBubble({
>   operation: 'append_values',
>   spreadsheet_id: spreadsheetId,
>   range: 'Answers!A:C',
>   values: [[name, email, answer]],
>   }).action();

The old rule's obligations (real id as default, no placeholder, never ask the user) are preserved inside the new rule, so no contradictory guidance remains. `INPUT_SCHEMA_INSTRUCTIONS` item 4 (provisioned id as the optional-field default) already agrees with the new rule and is unchanged.

## 2. Planner prompt (coffee.ts): section replaced (exact new text)

> ## SETUP PROVISIONING RESPONSIBILITY (REQUIRED, not optional):
>
> Every flow has two layers: one-time SETUP (fixed infrastructure the flow reuses on every run - a spreadsheet it pipes rows into, a database, a folder) and the REPEATABLE work performed each run. Setup happens at BUILD time through the plan's setupResources declaration; the plan's steps describe ONLY the repeatable work.
> When the user asks for an item to exist for this flow ("make a spreadsheet to pipe answers into", "create a database for this"), creating that item is build-time setup - not the user's homework and NOT a step of the flow. Do NOT create it yourself, do NOT plan a flow step that creates it at run time, do NOT plan check-and-create ("if the spreadsheet does not exist, create it") logic for it, and NEVER plan an input that asks the user for the id of something that does not exist yet. Instead, DECLARE it on the plan so the system creates it right after the user approves and fills the real id into the flow automatically:
>
> - REQUIRED for every fixed reused resource: add a "setupResources" array to the plan, one entry per item to create, with this exact shape: { "kind": "google_spreadsheet", "inputKey": "<the flow input the new id fills, e.g. spreadsheetId>", "title": "<a name for the item>", "sheetTitles": ["<tab name>"] }. Omitting the entry and letting the flow self-create the resource is a planning error.
> - Name the matching flow input exactly "inputKey"; the system provisions the item and prefills that input with the real id, so never leave a placeholder for it.
> - Every plan step then ASSUMES the resource exists and uses it (e.g. "add each answer to the answers spreadsheet"); no step creates it and no step checks for it.
> - Per-run OUTPUT artifacts are different: an item produced fresh on every run as the flow's result (e.g. a new dated report spreadsheet each execution) is repeatable work. Plan it as a normal step and do NOT declare it in setupResources.
> - Tell the user in plain words that you'll create the item for them and it will be ready to use. Do not mention ids or "setupResources" to the user.

Shape matches `SetupResourceSchema` in `packages/bubble-shared-schemas/src/coffee.ts` (kind enum currently only `google_spreadsheet`; inputKey/title required, sheetTitles optional).

## 3. Lint rule: IMPLEMENTED — `no-create-if-missing`

Location: `packages/bubble-runtime/src/validation/lint-rules.ts`, registered last in `defaultLintRuleRegistry` (rule count 19 → 20).

**What it flags** (all four conditions must hold, so precision beats recall):

1. An existence probe: a bubble instantiation with a literal `operation` matching `^(get_|list_|search_|find_)` whose result is bound to a `const` variable.
2. A `create_*` operation of the SAME bubble class, later in the SAME method.
3. The create executes on the probe's FAILURE path, established by condition-polarity analysis of the probe's result variable:
   - then-branch of `if` with a negated probe test (`!info.success`, `info.success === false`, `info.data == null`, `!== true`, incl. through parens/compound `||`/`&&`), or
   - else-branch of `if` with a positive probe test, or
   - a success guard-clause (`if (info.success) return ...;` with no else) earlier in the method body.
4. Rule only scans methods of the BubbleFlow class.

**What it deliberately never flags** (verified by tests):

- A bare `create_*` with no preceding existence guard (fresh per-run output artifact).
- A create gated by data reads (`read_values` etc.) — those signal "input data exists", not "resource exists".
- Cross-class pairs (probe Google Sheets, create a Notion page — e.g. failure reporting).
- A probe followed by an UNGUARDED create (read template info → create fresh copy), including the `if (!info.success) return` early-error shape.

**Known accepted false negatives** (documented, not fixed, to keep zero false positives):

- Cross-method composition (probe in one private method, create in another, gated in handle()) — determining polarity of an arbitrary method return value is data-flow analysis this AST pass cannot do safely.
- Aliased results (`const ok = info.success; if (!ok) ...`) and destructured results (`const { success } = ...`).
- Prompt rule 31 remains the primary enforcement; the lint is a high-precision backstop for the exact observed flow-34 shape (inline ensureX with probe + guarded create in one method).

## Verification

- `pnpm --filter bubblelab-api exec tsc --noEmit` → exit 0 (after building shared-schemas, core, runtime, appgen in that order; fresh clone had no node_modules/dist).
- Runtime rebuilt (`pnpm --filter @bubblelab/bubble-runtime build`) → clean.
- `pnpm --filter @bubblelab/bubble-runtime test` → 225 passed, 1 failed, 1 skipped. The single failure is the KNOWN pre-existing yfinance validation test (`src/validation/index.test.ts` — resend `to` param "Invalid input"), unrelated to this change.
- `lint-rules.test.ts` alone: 56/56 passed, including the 8 new `no-create-if-missing` tests (3 flag-shapes: negated then-branch, else-branch, guard-clause return, plus `=== false` form; 4 negative cases: unguarded create, probe-without-failure-gating, data-read gating, cross-class).

## Deviations

- Brief said prompt rule ~31 "currently allows/encourages in-flow creation". It did not: the old rule 31 only covered defaulting provisioned ids. No contradiction existed; the rule was still replaced/extended into the full boundary invariant since the old text was silent on forbidding in-flow creation (silence is what let flow 34 happen).
- The `while (parseAttempt...)` planner logic and schemas were untouched; only prompt text changed, so no schema/runtime behavior shift outside the new lint rule.
- Gotcha hit: a TS block comment containing `get_*/list_*` self-terminates at `*/` and broke the runtime build; reworded doc comments to avoid `*/` sequences.
