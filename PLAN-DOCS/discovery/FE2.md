# FE2 — Agent silently remembers user default data across flows

Discovery/design brief. Status: design only, no code changed. Backlog row: FE2
(Phase 3, depends-on: none; F0.1 harness preferred for the test). Governed by
`DISPATCH-CONTRACT.md` (Pillar 2 event-based acceptance, Pillar 5 dependency
surface recorded below).

## Problem

While building flow A the user says "email me" (giving brennanowyong@gmail.com)
or "send me a telegram via @howardstelebotbot". Today that datapoint dies with
flow A's conversation: flow B's build re-asks for the same email/handle. The
agent must capture user-supplied defaults silently during any build and
auto-populate them in subsequent flows, with the user never seeing the
remembering happen (no tool chip, no "I'll remember that" message).

## Current architecture (what the design builds on)

- One build turn = one Claude Agent SDK `query()` in
  `services/builder-agent/src/builder.ts` (`runBuildTurn`). The system prompt is
  assembled fresh per turn by `systemPromptFor` (`src/prompts.ts:173`), already
  parameterized (`fixMode`) — a per-turn injection seam exists.
- The agent's only tools are the in-process MCP `builder` server
  (`src/tools.ts`); the pattern for a cross-cutting tool shared by both agent
  kinds exists (`makeReportMissingCredentialTool`, `tools.ts:127`).
- Everything the agent does is visible twice: live SSE frames (`frameFor`,
  `builder.ts:59`, surfaces every `tool_use` block) and rehydration
  (`simplifyTranscript`, `src/index.ts:65`). The studio closes tool chips by
  ORDER-matching `tool_result` frames to `tool_use` frames
  (`apps/bubble-studio/src/hooks/usePearlStream.ts:198`), so invisibility must
  suppress the tool_use AND its paired tool_result, never one alone.
- The raw transcript persists untouched in Postgres `session_entries`
  (`src/session-store.ts`) — a logged event source the test can assert on even
  when the UI stream hides the call (Pillar 2).
- User identity: the Bun API's build proxy (`apps/bubblelab-api/src/routes/build.ts`)
  resolves `getUserId(c)` for ownership but forwards nothing to the sidecar;
  `build_threads` has no user column. Dev fallback user is `'mock-user-id'`
  (`apps/bubblelab-api/src/db/seed-dev-user.ts:5`).
- Per-flow persistence of setup data already exists (`set_flow_defaults` →
  flow `default_inputs`); FE2 adds the cross-flow, per-user layer above it.

## Approach

Write path = a hidden MCP tool; read path = silent system-prompt injection.

1. **Store**: new Postgres table `user_defaults` keyed `(user_id, key)` holding
   canonical datapoints (`email`, `telegram_bot`, `telegram_chat_id`, free-form
   slugs) with value + provenance. Shared DB, same dual-declaration pattern as
   `build_threads` (canonical DDL in `apps/bubblelab-api/src/db/schema-postgres.ts`,
   re-declared in the sidecar's `src/db.ts`).
2. **Write**: new builder tool `remember_user_default(key, value, description?)`
   — upsert, newest wins. The SOP instructs the agent: whenever the user
   supplies a personal default in conversation (their email, a bot handle, a
   chat id, a recurring name/preference), call it in the same turn, and never
   mention remembering. Added to BOTH tool servers (flow + page) via a shared
   maker, matching `makeReportMissingCredentialTool`.
3. **Invisibility**: `frameFor` tracks the `tool_use` block ids of
   `remember_user_default` calls, drops those blocks from `assistant` frames,
   and drops the matching `tool_result` entries (raw SDK blocks carry
   `tool_use_id`, `builder.ts:86`) so the studio's order-matched chip pairing
   stays aligned. `simplifyTranscript` applies the same paired filter on
   rehydration (raw JSONL user entries carry `tool_use_id`; track hidden ids
   across entries). The RAW `session_entries` row is untouched — that is the
   logged event the test asserts on.
4. **Read**: `runBuildTurn` loads the user's defaults before `query()` and
   passes them into `systemPromptFor` as a new module: a `# Known user defaults
(silent context)` block listing key/value pairs plus the rules — use these
   when the user's request implies them ("email me" → the stored email as the
   input default via `set_flow_defaults`), never re-ask for a stored datapoint,
   never tell the user you remembered it, and treat an in-conversation
   correction ("use X instead") as an upsert. System-prompt injection is the
   invisible channel: system prompts never appear in frames or transcript
   (only `user`/`assistant` entries do), unlike prompt-prefixing (the
   deferred-setup notice at `builder.ts:147` DOES leak into the transcript —
   not the pattern to copy here).
5. **Identity plumbing**: the API build proxy forwards `x-user-id: getUserId(c)`
   on all three forwarded routes; the sidecar's `handleBuildRequest` reads it
   into `runBuildTurn` opts and the tool maker. Fallback when absent (direct
   sidecar hits): `'mock-user-id'`, matching the API's dev user so records line
   up across paths.
6. **Observability**: sidecar `GET /memory?userId=` returns the stored records
   (the Pillar-2 "stored user-memory record" the acceptance test reads; also
   the future seam for a user-visible settings surface if ever wanted).

Scope note: the flow agent is the acceptance target; the page agent gets the
same tool + injection for free through the shared maker (its SOP gains one
line). No durable-file/RBAC work (dropped per the backlog row).

## Files to create / modify

| File                                                                               | Change                                                                                                            | Why                                                                                                           |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/bubblelab-api/src/db/schema-postgres.ts` + new `drizzle-postgres/00XX_*.sql` | add `user_defaults` table                                                                                         | canonical DDL lives in the API migrations (stated invariant in sidecar `db.ts:4-9`)                           |
| `services/builder-agent/src/db.ts`                                                 | re-declare `userDefaults`, add to drizzle schema                                                                  | sidecar cannot import the Bun API's db layer                                                                  |
| `services/builder-agent/src/memory.ts` (new)                                       | `loadUserDefaults(userId)`, `upsertUserDefault`, `formatDefaultsPromptBlock`                                      | single module owning the store shape; keeps builder.ts/tools.ts thin                                          |
| `services/builder-agent/src/tools.ts`                                              | `makeRememberDefaultTool(userId, subjectId, kind)` in both servers; export the tool name constant                 | write path; shared-tool pattern already exists here                                                           |
| `services/builder-agent/src/prompts.ts`                                            | `systemPromptFor(kind, {fixMode, userDefaults})`; new SOP module (capture rules + use rules + never-mention rule) | read path + behavior contract; prompts.ts is the prompt-assembly seam                                         |
| `services/builder-agent/src/builder.ts`                                            | load defaults pre-turn; pass `userId` through; paired tool_use/tool_result filtering in `frameFor`                | injection point + live-stream invisibility                                                                    |
| `services/builder-agent/src/index.ts`                                              | read `x-user-id` in `handleBuildRequest`; same paired filter in `simplifyTranscript`; add `GET /memory`           | identity intake + rehydration invisibility + test endpoint                                                    |
| `apps/bubblelab-api/src/routes/build.ts`                                           | forward `x-user-id` header on message/resume/thread                                                               | the only place that knows the authenticated user                                                              |
| `scripts/event-test/fe2-memory.mjs` (new)                                          | the acceptance script below                                                                                       | Pillar 2 gate (thin script on F0.1's harness; standalone on the `gluu-fix-test.mjs` pattern until F0.1 lands) |

## Data model

```sql
CREATE TABLE user_defaults (
  user_id        text NOT NULL,           -- clerk id; 'mock-user-id' in dev
  key            text NOT NULL,           -- canonical slug: 'email', 'telegram_bot', 'telegram_chat_id', free-form
  value          text NOT NULL,           -- the datapoint as given
  description    text,                    -- agent's one-line label ("user's personal email")
  source_flow_id integer,                 -- provenance: the flow whose build captured it
  created_at     timestamp NOT NULL DEFAULT now(),
  updated_at     timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
```

Upsert on `(user_id, key)`, newest value wins. `value` stays `text` for MVP
(every motivating datapoint is a string); a structured need later migrates to
`jsonb` behind `memory.ts` without touching callers. State at runtime: defaults
are read once per turn into the system prompt — no in-process cache, no
staleness window beyond a single turn.

## User-facing clarifying question

1. Correction/visibility: when a stored default goes stale (new email, new
   bot), is conversational correction ("use bren@new.com from now on" → silent
   upsert) sufficient, or do you want a visible "My defaults" list in Settings
   to review/delete entries? The design keeps `GET /memory` as the seam either
   way; invisible-only is the default per the backlog row.
2. Anything the agent should NEVER remember (e.g. one-off values, other
   people's emails mentioned as recipients of a single flow)? Proposed rule:
   remember only datapoints the user presents as their own standing defaults,
   not per-flow recipients.

## Event-based acceptance test (Pillar 2)

`scripts/event-test/fe2-memory.mjs`, exit-coded, asserts on logged events and
stored records — never the DOM:

1. Create flow A (`POST /bubble-flow/empty`), then
   `POST /build/:A/message` with "…and email me the results at
   fe2-test@example.com". Await the SSE `done` frame.
2. **Capture asserted**: `GET <sidecar>/memory?userId=mock-user-id` contains
   `{key:'email', value:'fe2-test@example.com'}`.
3. **Write path proven, not hallucinated**: query `session_entries` (or a raw
   variant of the thread endpoint) — the RAW transcript contains a `tool_use`
   named `mcp__builder__remember_user_default` with that value.
4. **Invisibility asserted**: `GET /build/:A/thread` transcript contains NO
   block named `remember_user_default`, and its `tool_use`/`tool_result` block
   counts still pair off (no orphaned result — the chip-alignment invariant).
5. Create flow B, `POST /build/:B/message` "email me a daily one-line weather
   summary" (no email given). Await `done` with `status:'ready'`.
6. **No re-ask**: flow B reached `ready` in that single turn (no intermediate
   assistant question turn awaiting a user reply about the email address).
7. **Auto-populate asserted**: `GET /bubble-flow/:B` `defaultInputs` contains
   `fe2-test@example.com` (the flow's populated inputs, per the backlog accept).
8. Cleanup: delete both flows + the memory row so re-runs are hermetic.

`[USER-TEST]` card (taste only, after the event test is green): build two flows
as above in the studio and judge whether the second build feels like the agent
"already knows you" — no visible memory mechanics, no re-asking, nothing
surprising in the chat.

## Dependency surface (Pillar 5 pre-map)

Consumers of the modules being changed:

- `frameFor` — internal to `builder.ts`; its frames are consumed by
  `usePearlStream.ts` (studio) and `test/benchmark.mjs`. Chip pairing is
  order-based → the paired-suppression requirement above.
- `simplifyTranscript` — internal to `index.ts`; consumed by the studio's
  thread-rehydration hooks (`useBuildThreadStatus` / thread fetch in
  `apps/bubble-studio/src/hooks/`).
- `systemPromptFor` — callers: `builder.ts` only (verified by grep). Signature
  change is additive (options object).
- `tools.ts` servers — instantiated only in `builder.ts`.
- `routes/build.ts` — mounted in `apps/bubblelab-api/src/index.ts`; header
  addition is additive, no consumer change.
- `db.ts` (sidecar) — importers: `builder.ts`, `tools.ts`, `session-store.ts`,
  `page-data.ts`, `deferred.ts`. Table addition is additive.

## Risks

1. **Chip misalignment** (highest): suppressing a `tool_use` frame while its
   `tool_result` leaks (or vice versa) shifts every subsequent chip close in
   the studio's order-matched pairing. Mitigation: filter by `tool_use_id`
   pairs in both `frameFor` and `simplifyTranscript`; acceptance step 4 asserts
   pairing parity.
2. **Model compliance is probabilistic**: the agent may re-ask anyway, mention
   the remembering, or remember one-off recipients. Mitigation: explicit SOP
   rules with positive/negative examples (the call-site-trap section is the
   precedent that worked); acceptance steps 4 and 6 catch regressions; expect
   one prompt-iteration loop.
3. **Silent stale data**: an invisible wrong default (old email) is used with
   no user-visible cause. Mitigation: conversational upsert rule + the
   clarifying question above about a settings surface; `source_flow_id` +
   `updated_at` make records auditable via `GET /memory`.
4. **PII at rest in plaintext**: emails/handles are personal data; credential
   rows are encrypted (`CREDENTIAL_ENCRYPTION_KEY`) but `user_defaults` as
   designed is plaintext. Accepted for MVP (these values also live in plaintext
   in `default_inputs` and transcripts today); note for a later hardening pass.
5. **Identity fallback drift**: direct-to-sidecar calls default to
   `'mock-user-id'`; if prod auth lands later, unforwarded paths would silently
   write to the dev bucket. Mitigation: the proxy header is the only supported
   entry (studio already talks only to the API, `routes/build.ts:4-6`); the
   sidecar logs a warning when it falls back.
6. **Cross-checkout DB divergence** (memory `per-checkout-devdb-divergence`):
   the migration must run on the shared Postgres the live stack uses; the
   sidecar re-declaration must stay column-synced with `schema-postgres.ts`
   (existing stated invariant).

## Sources

- `services/builder-agent/src/{builder,prompts,tools,index,db,config}.ts` — read in full this discovery pass (2026-08-01).
- `apps/bubblelab-api/src/routes/build.ts`, `src/middleware/auth.ts:90-110`, `src/db/seed-dev-user.ts:5`.
- `apps/bubble-studio/src/hooks/usePearlStream.ts:90-230` (order-matched chip pairing).
- `DISPATCH-CONTRACT.md` Pillars 2/5; `BACKLOG.md` FE2 row.
