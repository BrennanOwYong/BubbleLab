# Delta: IR-8 — doc-grounded per-operation side-effect metadata (+ backfill)

Branch: `improve/ir8-side-effect-metadata`. BubbleLab previously had no read/write concept:
nothing declared whether an operation mutates, which blocked the Tester (IR-9/10), the scope
audit (IR-6/7), and the write-safety gate (test-mode switch).

## What changed

### 1. Classification type with provenance (`packages/bubble-shared-schemas/src/operation-metadata-schema.ts`)

`OperationSideEffectMetadataSchema` (Zod) carrying
`{ sideEffect: 'read'|'write'|'read_with_side_effects', destructive, idempotent, confidence,
source: 'observed'|'mcp'|'openapi'|'prose'|'manual', citation, requiredScopes?, unverified? }`.
Citation has `min(1)` — no classification exists without its source. `requiredScopes` is declared
(optional) for the IR-6/7 scope audit but not yet populated. Exported from the package index.

### 2. Doc-grounded classifier (`packages/bubble-core/src/utils/side-effect-classifier.ts`)

Ported from the reference build (`integration_stitcher/packages/contracts/src/classifier.ts`),
renamed sources to BubbleLab's enum. Binding rule: `write` iff the docs say the operation CREATES
A NEW RECORD (even as a side effect); `read_with_side_effects` for mutation without record
creation (update/delete/mark — `destructive` carries the delete signal); `read` when the docs say
no mutation. The HTTP method is NEVER the class signal; in the OpenAPI path it only corroborates
idempotency (RFC 9110 §9.2.2). Evidence hierarchy `mcp > openapi > prose > manual`; evidence with
no prose yields nothing and falls through; no signal at all throws `ClassificationError` instead
of guessing. Exported from `@bubblelab/bubble-core`.

### 3. Per-operation declaration + runtime resolution

- `ServiceBubble` gains `static readonly operationMetadata?: BubbleOperationMetadata`
  (`packages/bubble-core/src/types/service-bubble-class.ts`).
- `BaseBubble` gains `get sideEffect()` and `get operationSideEffectMetadata()`
  (`packages/bubble-core/src/types/base-bubble-class.ts`): resolves the instance's CURRENT
  `operation` param against the static map. Fail-safe default: unknown operation, no metadata, or
  no `operation` param → `'write'`. This is the hook the test-mode switch intercepts on.
- `BubbleFactory.getMetadata()` exposes `operationMetadata`
  (`packages/bubble-core/src/bubble-factory.ts`) — classifications reachable at runtime without
  instantiating the bubble.

### 4. Catalogue surfacing (what the code-generating LLM reads)

- `get-bubble-details-tool` result gains `operationSideEffects` (one line per operation:
  class, flags, source, confidence, citation) and usage-example operation headers are tagged
  `[side-effect: read|write|read_with_side_effects]`.
- `scripts/bubble-metadata-bundler.ts` adds `operationMetadata` per bubble to the generated
  `bubbles.json` manifest (regenerated on `pnpm --filter @bubblelab/bubble-core build`; the studio
  copy `apps/bubble-studio/public/bubbles.json` picks it up on its next regeneration).
- NOT yet done (follow-up for the codegen prompt pass): teaching
  `apps/bubblelab-api/src/config/bubbleflow-generation-prompts.ts` and the codenamed AI workflow
  variants (`boba/milktea/pearl/coffee/rice`) to reason about the hint. That belongs to the
  test-mode/prompt task; the data now flows to every tool they already call.

### 5. Backfill: 6 bubbles, 59 operations, zero unverified

`packages/bubble-core/scripts/backfill-operation-metadata.ts`
(`pnpm --filter @bubblelab/bubble-core backfill:operation-metadata`, run after `build:types`):
walks each params schema's discriminated union on `operation`, classifies from a curated
vendor-doc citation table (deep link + vendor quote per operation; quote is the classifier input,
URL makes it auditable), falls back to the operation's schema `.describe()` prose (still cited,
lower trust), and emits colocated `src/bubbles/service-bubble/<name>.metadata.ts` files imported
by each bubble class as its static — no 13th central registry location. No doc signal → fail-safe
`write` + `unverified: true` + confidence 0.2 (never a silent guess).

Backfilled: resend (3 ops), gmail (17), google-calendar (6), google-drive (12), github (10),
airtable (11). Examples proving the binding rule over intuition: gmail `delete_email` is
`read_with_side_effects` + `destructive` (mutation, no new record), `copy_doc` is `write`
("Creates a copy of a file"), drive `share_file` is `write` (permissions.create creates a
permission record).

## Why this design

- Per-operation, colocated, factory-derived: avoids the 12-location checklist becoming 13
  (REPO-MAP risk #3) and avoids merge contention on monolithic bubble files (risk #5).
- The fail-safe `'write'` default means the future test-mode gate blocks anything unclassified —
  safe by construction for the ~55 bubbles not yet backfilled; backfilling a bubble is purely
  additive precision.
- The script is the mechanism, not the artifact: new operations rerun the script; the guard test
  (below) fails the build if a bubble that opted in ships an operation without a classification.
- `source: 'observed'` is reserved for the runtime correction channel (REPO-MAP §4a step 5);
  precedence observed > doc-derived is encoded in the enum ordering and classifier docs.

## How it was verified

Environment gate (REPO-MAP §2): `pnpm build && pnpm typecheck && pnpm test:core &&
pnpm lint:check` from the repo root — results recorded in the final section below.

New tests (all real behavior, no mocking of the unit under test):

- `packages/bubble-core/src/utils/side-effect-classifier.test.ts` (14 tests): acceptance
  criterion — a POST that only reads classifies `read`, a GET that creates classifies `write`,
  method+no-prose yields nothing (method proven not to be the signal); binding-rule cases
  (mark-as-read, permanent delete, negation handling); empty citation / missing evidence throw;
  every produced classification parses against the shared Zod schema with non-empty
  source+citation; hierarchy ordering; MCP spec defaults.
- `packages/bubble-core/src/utils/operation-metadata.test.ts` (7 tests): per-operation runtime
  resolution on the real `ResendBubble` (`get_email_status` → read, `send_email` → write, with
  citations); fail-safe write for no-operation bubbles and unmapped operations; factory
  reachability for all 6 backfilled bubbles; the coverage guard (every declared op exists in the
  schema, every schema op is classified, every entry carries provenance — iterates the whole
  registry); `get-bubble-details-tool` emits `operationSideEffects` and `[side-effect: ...]` tags
  for a real factory bubble.

## Environment learnings (WSL `/mnt/c`)

- `pnpm build:core` wall time: ~10m14s cold. `registerDefaults()` first call scans ~280 bubble
  source files for dependency inference and can exceed vitest's 120s `hookTimeout` — the factory
  test passes an explicit 360s hook timeout.
- Commit hooks (lint-staged + prettier via npx) take ~40-60s per commit; budget for it.
- The backfill script imports from `../dist/`, so it needs `build:types` (or full build) first —
  same pattern as the existing bundler scripts.

## References (vendor doc URLs backing the citations; verified 2026-07-15)

- Resend: https://resend.com/docs/api-reference/emails/send-email
- Gmail: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
- Google Calendar: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- Google Drive: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/copy
- GitHub REST: https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28
- Airtable: https://airtable.com/developers/web/api/create-records
- MCP ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations

## Gate results (2026-07-15, WSL `/mnt/c`)

- `pnpm build`: PASS, 6/6 tasks — after switching to Linux bun. The `bun` on PATH
  (`/mnt/c/usr/local/bun`) is a wrapper exec'ing the WINDOWS `bun.exe`, which fails with `EACCES`
  reading pnpm-symlinked `node_modules` in the worktree (`bubblelab-api#build`), regardless of
  branch. Fix used: `curl -fsSL https://bun.sh/install | bash` then
  `PATH="$HOME/.bun/bin:$PATH" pnpm build`. First `pnpm build:core` cold run: 10m14s.
- `pnpm typecheck`: PASS (all 6 projects).
- `pnpm test:core`: bubble-core 397 passed / 12 failed / 48 skipped, bubble-runtime unaffected.
  Every one of the 12 failures is a literal `Test/Hook timed out` (60s/120s) in a suite whose
  first action is `BubbleFactory.registerDefaults()` — the ~287-file source scan alone takes
  2–6 minutes on `/mnt/c`. Zero assertion failures. Evidence the failures are environmental, not
  from this branch:
  1. The same suites rerun serially on this branch: the IR-8 suites pass fully
     (`operation-metadata.test.ts` 7/7, `factory-integration.test.ts` 6/6); the pre-existing
     tool-bubble suites still time out at the same call sites.
  2. Baseline on `origin/main` (same worktree, same environment):
     `list-bubbles-tool.test.ts` fails the exact same 2 tests (:26, :35) with the same 60s
     timeouts — without any IR-8 change present.
     The 21 new IR-8 tests all pass (`side-effect-classifier.test.ts` 14/14 in the full gate run;
     `operation-metadata.test.ts` 7/7 serially, with explicit 600s budgets for the factory scan).
- `pnpm lint:check`: no findings in any file this branch touches. The run exits 1 on 4
  pre-existing `Definition for rule 'react-hooks/...' was not found` errors in
  `apps/bubble-studio` (missing eslint plugin wiring on main), plus ~150 pre-existing warnings.
- Catalogue end-to-end: regenerated `dist/bubbles.json` (and the studio build's copy to
  `public/bubbles.json`, gitignored build artifact) carries `operationMetadata` for all 6
  backfilled bubbles, 59 operations, every entry cited.
