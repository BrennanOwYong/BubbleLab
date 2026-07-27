# studio-forms lane — RESULT

Status: DONE
Branch: feature/studio-default-forms
Commit: c1e0a62771f72c17cb743c86fa133ad267aa8dfa (feature commit; this hash note added in a follow-up docs commit)

## Files changed

- `apps/bubble-studio/src/utils/fieldDescriptor.ts` (new) — FieldDescriptor contract, C1 value-vs-placeholder resolver, userProfileDefaults narrowing + field matching, profile-defaults seed merge.
- `apps/bubble-studio/src/components/shared/DefaultValueForm.tsx` (new) — the default-value form over FieldDescriptor[] rendered inside the Conversation tab (C1 rule canonical implementation).
- `apps/bubble-studio/src/components/InputFieldsRenderer.tsx` — C1: known values render as real editable input `value` (normal text color); placeholders carry ONLY the hint. Applied to top-level string/number fields, object properties, nested object properties, and the account dropdown. Accepts optional `header`/`hint`/`value` per field (descriptor passthrough).
- `apps/bubble-studio/src/utils/flowChecklist.ts` — B3: section derivation (trigger/frequency, required inputs, outcomes, error responses), cron humanizer, stronger toPlainLanguage (string/integer/ISO-8601/markdown/URL/null/backticks); E: `parseConversationThread` parsing workflow-status messages alongside CoffeeMessages.
- `apps/bubble-studio/src/components/FlowChecklistPanel.tsx` — renders the four B3 sections only.
- `apps/bubble-studio/src/components/FlowConversationPanel.tsx` — renders workflow-done as a timestamped system note and workflow-done-needs-info with the inline DefaultValueForm; edits land in executionStore inputs (`getExecutionStore(flowId).setInput`).
- `apps/bubble-studio/src/components/ConsolidatedSidePanel.tsx` — Conversation badge counts the full thread including status messages.
- `apps/bubble-studio/src/components/flow_visualizer/FlowVisualizer.tsx` — F: profile defaults merged into the once-per-flow executionInputs seed (`{...profileMapped, ...defaultInputs}`; saved defaults win).
- `apps/bubble-studio/src/components/FlowPanels.mount.test.tsx` — repaired stale assertions (pre-existing failure on HEAD, see Deviations) + new mount test for status messages and the C1 rule.

## FieldDescriptor shape rendered against (backend lanes must match)

```ts
interface FieldDescriptor {
  key: string; // payload key, e.g. "telegramChatId"
  header: string; // rendered as the field LABEL
  hint: string; // rendered as placeholder ONLY when no value exists
  value?: string; // known value; rendered as REAL editable input text
}
```

## conversationMessages shape rendered against

`metadata.conversationMessages` is a single array. Existing entries are CoffeeMessages (discriminated on `type`, with `id` + ISO `timestamp` — see `packages/bubble-shared-schemas/src/coffee.ts`). The generate-route lane appends status entries INTO THE SAME ARRAY with this exact shape (discriminated on `role`/`kind`, NOT `type`):

```ts
// rendered as a centered system note with timestamp
{ role: 'system', kind: 'workflow-done', timestampMs: number, text: string }

// rendered as an assistant card with timestamp + the inline default-value form
{ role: 'system', kind: 'workflow-done-needs-info', timestampMs: number,
  text: string, fields: FieldDescriptor[] }
```

Parsing (`parseConversationThread` in `flowChecklist.ts`) checks `role === 'system'` and the two `kind` literals first, then falls back to `CoffeeMessageSchema.safeParse`; malformed entries are skipped individually. Invalid entries inside `fields` are filtered, not fatal. `timestampMs` is Unix epoch milliseconds. Do NOT reuse `type: 'system'` (that is the CoffeeMessage system note, plain text only).

## Flow-12 seed (exact, reproducible)

Flow 12 ("Gi Hoon: Notion Pipeline Digest (early)") in live Postgres. Its `input_schema` already carried the two IDs as SCHEMA defaults; the acceptance case needs them as stored default VALUES:

```bash
PGPASSWORD=bubblelab psql -h localhost -U bubblelab -d bubblelab -c \
  "UPDATE bubble_flows SET default_inputs = '{\"notionDatabaseId\":\"1234567890abcdef1234567890abcdef\",\"telegramChatId\":\"123456789\"}' WHERE id = 12;"
```

Verified: `GET http://localhost:3001/bubble-flow/12` returns `defaultInputs: {telegramChatId: "123456789", notionDatabaseId: "1234567890abcdef1234567890abcdef"}`.

Why SQL and not the API (deviation from "prefer the API PUT"): no PUT persists defaultInputs alone. `PUT /bubble-flow/:id` accepts only `bubbleParameters`; the only route writing `defaultInputs` is `POST /bubble-flow/validate-code`, which also rewrites originalCode, bubbleParameters, workflow, inputSchema, cron and cronActive (`bubble-flows.ts` ~1355-1380) — unacceptable side effects for a seed. The UPDATE targets only id 12, no DELETE.

Render path for the acceptance case (two independent guarantees):

1. `FlowVisualizer` seeds executionInputs from `defaultInputs` once per flow → `InputFieldsRenderer` shows them as the input's `value` (class `text-neutral-100`, normal color, editable).
2. Even unseeded, C1 now renders `field.default` from inputSchema as real value text (never placeholder).

## Verification

- `tsc --noEmit` (bubble-studio): exit 0.
- `pnpm --filter bubble-studio run build` (vite build): success.
- `vitest run` (all non-integration studio tests): 188/188 pass, including:
  - new mount test: needs-info form input `#needs-info-notionDatabaseId` has `.value === '1234567890abcdef1234567890abcdef'` (real text) and the value-less telegram field has `.value === ''` with the hint as `.placeholder`;
  - checklist mount test asserts the section render and `text).not.toMatch(/ISO-8601|JSON\b|\b2D array\b/)`.
- Flow 12 described (no screenshot): opening flow 12 shows `notionDatabaseId` and `telegramChatId` in the Flow Inputs node as normal-color editable text (`text-neutral-100`), sourced from the seeded defaultInputs via executionInputs; hints render under the label, not as fake values.

## Deviations

1. **Seed via SQL, not API PUT** — see above; no defaultInputs-only PUT exists.
2. **`accountEmailDefaults` had NO studio consumer before this lane** — it rode GET /bubble-flow/:id (`bubble-flows.ts:702`) unread. Both default maps are now consumed at the executionInputs seed (FlowVisualizer → `applyProfileDefaults`), per the locked contract from the user-profile lane:
   - `userProfileDefaults` is keyed by INPUT FIELD KEY (payload inputSchema property name). Lookup: exact key, then a normalized case/separator-insensitive match of the same key. No semantic guessing.
   - `accountEmailDefaults` stays keyed by CREDENTIAL TYPE; fields naming an account (gmailAccountEmail, ...) map to types via `getAccountCredentialTypesForField` (the same heuristic the account dropdown uses).
   - Precedence: saved defaultInputs > userProfileDefaults > accountEmailDefaults. Both maps degrade to a no-op when absent.
   - `FieldDescriptor.fromUserProfile?: string` (known values 'email' | 'telegramChatId') is accepted as an informational marker; the field-key lookup resolves the value.
     Contract locked in `fieldDescriptor.test.ts` (exact-key hit, cross-field guess rejected, credential-type account fill, precedence).
3. **FlowVisualizer touched** (not in the named file list) — it owns the only defaults→inputs seed seam; prefilling anywhere else would show values the flow would not run with.
4. **Pre-existing test failure repaired** — `FlowPanels.mount.test.tsx` failed on HEAD before this work (expected 'Queries your Notion deals database' / 'AI Agent'; the sanitizer has emitted 'Looks up…' / 'AI' since before this lane). Assertions updated to the real plain-language output.
5. **B3 error-responses section is derived, not stored** — no per-flow error-handling metadata exists, so the line derives from trigger type (scheduled flows note the next run still happens). Recorded so a future lane can replace it with real error-policy data (errors-as-events bus).
