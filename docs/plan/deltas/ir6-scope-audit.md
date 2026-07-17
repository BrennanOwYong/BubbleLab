# Delta: IR-6/7 — proactive scope audit + honest fallback

Branch: `improve/ir6-scope-audit`. BubbleLab enforced scopes REACTIVELY only: `oauth_scopes`
was stored on the credential row but display-only, and a missing scope surfaced as a provider
rejection mid-run (teardown §12.1 #9/#27). This graft makes the check proactive at
validation ("build") time, and honest where verification is impossible.

## What changed

### 1. Scope requirements declared per operation, doc-literal (`packages/bubble-core/scripts/backfill-operation-metadata.ts` + regenerated `*.metadata.ts`)

IR-8's `requiredScopes` field (declared, never populated) is now populated for the three
Google bubbles whose credentials carry recorded grants: gmail (17 ops), google-calendar (6),
google-drive (12). Encoding, documented on the schema
(`packages/bubble-shared-schemas/src/operation-metadata-schema.ts`): each entry is one
requirement, ALL entries must hold; within an entry `'|'` separates ALTERNATIVES, any one of
which satisfies it. This mirrors Google's per-method "requires one of the following OAuth
scopes" sets EXACTLY — a flat all-of list (the reference build's shape) would false-fail a
user whose `gmail.modify` grant legitimately covers `messages.send`. Every set was copied from
the live method reference page (fetched 2026-07-15; URLs below and on each operation's
citation). Nuances the doc-literal rule captured: `messages.delete` accepts ONLY
`https://mail.google.com/`; `permissions.create` (drive share_file) accepts only
`drive|drive.file`.

Bubbles without documented scope vocabularies (resend, github PATs, airtable) stay
undeclared — the audit degrades honestly rather than guessing (below).

### 2. Pure audit (`packages/bubble-core/src/utils/scope-audit.ts`)

Ported from the reference implementation's `packages/auth/src/scope-audit.ts`
(pass / missing_scopes / unknown_grants triad) and extended:

- `collectScopeRequirements(callSites)`: unions requirements across the flow's call sites,
  deduplicated by alternative-set, each requirement carrying `requiredBy` (bubble, variable,
  operation) for attribution. A call site whose `operation` param is not a static string
  literal is audited conservatively: every operation the bubble declares scopes for
  contributes, marked "operation not statically resolvable".
- `auditCredentialScopes(input)`: four verdicts, never a silent pass:
  - `pass` — every requirement covered by the recorded grants;
  - `missing_scopes` — build-failing; the message NAMES each missing scope (with its accepted
    alternatives) and the operations that need it;
  - `unknown_grants` — the credential row has no recorded grants (providers without scope
    introspection): explicit "the provider exposes no scope metadata … can only surface on
    first run … not a verified pass";
  - `no_scope_metadata` — the operations declare no `requiredScopes`: explicit "nothing to
    verify against … can only surface on first run".
- Normalization trims trailing `/` (`https://mail.google.com/` vs stored no-slash variants);
  case preserved per RFC 6749 §3.3.

### 3. Result contract (`packages/bubble-shared-schemas/src/scope-audit-schema.ts`)

Zod schemas (`FlowScopeAuditSchema`, `CredentialScopeAuditSchema`, `ScopeRequirementSchema`)
shared by API and studio; `validateBubbleFlowCodeResponseSchema` gains optional `scopeAudit`.

### 4. API wiring (`apps/bubblelab-api/src/services/scope-audit-service.ts` + `routes/bubble-flows.ts`)

`auditFlowScopes()` resolves each parsed bubble's static `operation`, collects assigned
credential ids (request `credentials` mapping keyed by variableId or variableName, plus
`credentials` parameters already merged into the parsed bubbles), loads the user-owned rows'
`oauth_scopes` (persisted by `oauth-service.ts`), and runs the pure audit per credential.
`POST /bubble-flow/validate` runs it after `validateAndExtract` and BEFORE the flow update:
`missing_scopes` returns `valid: false` with the naming message in `errors` and the structured
`scopeAudit`, and skips persisting the flow — the build fails atomically. Unverifiable
credentials keep `valid: true` and surface in `scopeAudit.warnings`. The studio needs no code
change to show failures (they ride the existing `errors` channel); rendering the structured
warnings in the credential UI is a follow-up.

## Why this design

- Per-operation requirements + per-credential grants is the only shape that catches the real
  incident class: a Gmail credential connected with `gmail.send` only (BubbleLab's own scope
  picker allows deselecting `gmail.modify`) driving a flow that also lists emails.
- The audit reads the SAME `operationMetadata` statics the test-mode gate and catalogue read
  (IR-8) — no 13th registry location, backfill script remains the single mechanism.
- Failing the build only on VERIFIABLE mismatches (and never on unknown grants) keeps the
  audit trustworthy: false failures would train users to ignore it, silent passes would
  reintroduce the mid-run surprise it exists to kill.

## How it was verified

Environment gate (REPO-MAP §2): `pnpm build && pnpm typecheck && pnpm test:core &&
pnpm lint:check` — results in the final section.

- `packages/bubble-core/src/utils/scope-audit.test.ts` (12 tests, vitest, real backfilled
  metadata): AC-1 at unit level (readonly grant + send_email → `missing_scopes` naming
  `gmail.send` and the operation; delete_email needs full `mail.google.com`; drive share_file
  rejects readonly); any-of alternatives (each of send's four accepted scopes passes
  individually); trailing-slash normalization; AC-2 at unit level (`unknown_grants` and
  `no_scope_metadata` messages state "first run" and "not a verified pass"); requirement
  dedup + attribution; conservative dynamic-operation union; coverage guard asserting every
  gmail/calendar/drive operation declares well-formed `requiredScopes`; results parse against
  the shared Zod schema.
- `apps/bubblelab-api/src/routes/bubble-flows-scope-audit.test.ts` (4 tests, bun, real Hono
  app + real parser + real sqlite): AC-1 through the route (seeded readonly-only GMAIL_CRED →
  `valid:false`, `errors` naming scope/operation/credential id, `scopeAudit.ok === false`);
  pass case with `gmail.send` granted; AC-2 through the route (OAuth row with NULL
  `oauth_scopes` → `valid:true` + `unknown_grants` warning containing "provider exposes no
  scope metadata" and "first run"); no-credentials flow → empty audit, no failure.

## Environment learnings

- (carried from IR-8) `/mnt/c` WSL: cold `pnpm build:core` ~10 min; the `bun` on PATH is the
  WINDOWS bun behind a wrapper and fails with EACCES on pnpm symlinks — use Linux bun
  (`~/.bun/bin`) for `bubblelab-api` build/tests.
- Concurrent `pnpm install` runs from parallel builder worktrees serialize on the shared pnpm
  store; installs that look hung are usually queued.

## References (fetched and verified 2026-07-15)

Gmail method scope sets: users.messages/{send,list,get,modify,delete,trash},
users.drafts/{create,send,list}, users.labels/{list,create}, users.threads/{list,modify},
users.messages.attachments/get under
https://developers.google.com/workspace/gmail/api/reference/rest/v1/
Calendar: events/{list,get,insert,update,delete}, calendarList/list under
https://developers.google.com/workspace/calendar/api/v3/reference/
Drive: files/{create,get,list,delete,update,copy}, permissions/create under
https://developers.google.com/workspace/drive/api/reference/rest/v3/
Docs: documents/{get,batchUpdate} under
https://developers.google.com/workspace/docs/api/reference/rest/v1/
Scope-string casing/semantics: RFC 6749 §3.3; insufficient-scope surfacing at run time:
RFC 6750 §3.1.
Reference design: `integration_stitcher/packages/auth/src/scope-audit.ts` (+ its
`scope-audit.test.ts`).

## Gate results (2026-07-15, WSL `/mnt/c`)

(to be filled after the gate run)
