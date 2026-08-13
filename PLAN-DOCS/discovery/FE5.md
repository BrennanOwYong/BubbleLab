# FE5 — Sidecar as a switchable backend subroutine

Discovery/design brief. Status: design only, no code changed. Backlog row: FE5
(Phase 3, depends-on: none; F0.1 harness preferred for the test). Governed by
`DISPATCH-CONTRACT.md` (Pillar 2 event-based acceptance, Pillar 5 dependency
surface recorded below). Origin KIV: memory `firecrawl-nested-cred-inconsistency`
("make the Claude Code builder harness a backend SUBROUTINE the API can switch
on/off, instead of a separate always-on Node server").

## Problem

The builder harness runs as an always-on standalone Node server
(`services/builder-agent`, default :3010) that three API routes proxy to via a
module-constant `BUILDER_AGENT_URL` (`apps/bubblelab-api/src/routes/build.ts:21`,
`build-page.ts:18`, `pages.ts:23`). The API has no control over it: it cannot
start it, stop it, restart it (the S8 stale-401 heal is a manual restart today),
or refuse builds cleanly when it is down — a dead sidecar surfaces as an opaque
fetch failure inside the SSE proxy. Nothing records which process served a
build, so "did this build go through the sidecar?" is unanswerable from logged
events. FE5 makes the harness a subroutine the API owns: a runtime mode flag
routes builds through a managed child process, through an external sidecar, or
refuses them ("around" the sidecar), and every build thread records the exact
process that served it.

## Current architecture (what the design builds on)

- The sidecar is a Hono/Node HTTP server (`services/builder-agent/src/index.ts`)
  serving `/build`, `/build-page` (SSE build turns + thread rehydration) and the
  page data plane `/page/:id/render|submit`. It requires Node >= 24
  (`package.json` engines; Node-native TS execution) — it cannot be imported
  into the Bun API in-process.
- One build turn = one Agent SDK `query()` in `src/builder.ts` (`runBuildTurn`);
  thread state persists in Postgres `build_threads` keyed
  `(flow_id, agent_kind)` (`src/db.ts:30`), dual-declared with
  `apps/bubblelab-api/src/db/schema-postgres.ts:310` (canonical DDL in the API
  migrations, stated invariant at sidecar `db.ts:4-9`; a sqlite twin exists in
  `schema-sqlite.ts`).
- The API proxies are pass-through streams: ownership check, then
  `fetch(BUILDER_AGENT_URL + path)` with the body piped untouched
  (`routes/build.ts:39-66`). The env var is read once at module load — no
  runtime switch exists.
- Sidecar config is env-driven (`src/config.ts`): `BUILDER_PORT`,
  `GLUU_API_URL`, `DATABASE_URL`, `BUILDER_CLAUDE_CONFIG_DIR`. `dev-stack.sh`
  launches it as one of three stack processes (`scripts/dev-stack.sh:83-87`)
  and records its pid in the pidfile.
- Concurrency guard is in-process: `activeBuilds` Set in `index.ts:48` — one
  build per subject per sidecar process. `/health` returns `{ok, service,
port}` only (no pid, no active-build count).
- No legacy in-API build path exists ("around the sidecar" cannot mean a
  fallback code generator; the harness is the only builder).

## Approach

One runtime manager in the API owns mode + target + child lifecycle; the three
proxy routes ask it for a target per request; the sidecar stamps its identity
on every thread it serves.

1. **Runtime manager** (`apps/bubblelab-api/src/services/builder-runtime.ts`,
   new): holds `{mode: 'external' | 'managed' | 'off'}` in memory, initialized
   from env `BUILDER_MODE` (default `external` — current behavior, zero-risk
   rollout). Exposes:
   - `getTarget(): string | null` — base URL when routable (`external` →
     `BUILDER_AGENT_URL`; `managed` → the child's URL; `off` → null).
   - `setMode(mode)` — on `managed`: probe a free port, spawn the child
     (`NODE` env-resolved binary, `node src/index.ts` with cwd
     `services/builder-agent`, env: `BUILDER_PORT`, `GLUU_API_URL` = this API,
     `DATABASE_URL`, `BUILDER_CLAUDE_CONFIG_DIR`, `BUILDER_SERVE_MODE=managed`),
     pipe stdout/stderr to a log file, poll `/health` until ready. On leaving
     `managed`: drain (poll `/health.activeBuilds === 0`, force-kill by exact
     pid after a timeout — never a pattern kill, per the supervisor gotchas
     memory), then SIGTERM the child. API shutdown hook kills the child by pid.
   - `restart()` — kill + respawn (the S8 heal seam: a stale-401 sidecar
     becomes one API call to fix instead of a manual op).
   - `status()` — `{mode, target, child: {pid, port, startedAt} | null,
health}` for the ops endpoint and the acceptance test.
2. **Toggle endpoint** (`apps/bubblelab-api/src/routes/build-runtime.ts`, new):
   `GET /build-runtime` → `status()`; `PUT /build-runtime {mode, url?}` →
   `setMode` (optional `url` overrides the external target — the test uses it);
   `POST /build-runtime/restart`. Auth-gated like `/build` (ops control only —
   no studio UI, per the F0.5 non-technical principle).
3. **Route the proxies through the manager**: `routes/build.ts`,
   `build-page.ts`, `pages.ts` replace the module-const `BUILDER_AGENT_URL`
   with `builderRuntime.getTarget()` per request. `null` target → `503
{error: 'builder_disabled'}` and a structured `[TELEMETRY]`-style server log
   line `build_rejected_builder_off {path, subjectId}` (the logged event for
   the off case). The three copies of the forward helper stay separate
   (ownership models differ); only the target lookup changes.
4. **Serve-identity stamp**: `build_threads` gains a `served_by` jsonb column
   `{pid, port, mode, hostname, startedAt}`. The sidecar writes it in
   `upsertThread` at turn start (`builder.ts:33-56`) from `process.pid` +
   `config` + new env `BUILDER_SERVE_MODE` (`external` when launched by
   dev-stack/hand, `managed` when spawned by the API; default `external`).
   `runBuildTurn` also emits an SSE frame `served_by` with the same object at
   turn start, and `threadResponse` (`index.ts:111`) returns `servedBy` — the
   Pillar-2 event the acceptance test asserts on.
5. **Health enrichment**: sidecar `/health` adds `{pid, activeBuilds:
activeBuilds.size, serveMode}` so the manager can drain before kill and the
   test can correlate pids without shelling out.
6. **dev-stack integration** (`scripts/dev-stack.sh`): honor `BUILDER_MODE`.
   Default unchanged (`external`: launch the sidecar, export
   `BUILDER_AGENT_URL` + `BUILDER_SERVE_MODE=external`). With
   `BUILDER_MODE=managed`, skip the sidecar launch and pass `BUILDER_MODE=managed`
   - `BUILDER_CLAUDE_CONFIG_DIR` to the API; the stack becomes two processes
     and the API supervises the third.

Scope notes: mode is process-local, in-memory, env-defaulted — no DB-persisted
setting (an API restart returns to the env default; acceptable for an ops
toggle, revisit if prod wants durable state). The page data plane
(`/page/:id/render|submit`) shares the target lookup, so `off` also darkens
published pages — flagged as clarifying question 2.

## Files to create / modify

| File                                                                                                    | Change                                                                                                            | Why                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/bubblelab-api/src/services/builder-runtime.ts` (new)                                              | mode state, child spawn/drain/kill, free-port probe, `getTarget`/`setMode`/`restart`/`status`                     | single owner of the switch and the child lifecycle; keeps routes thin                                         |
| `apps/bubblelab-api/src/routes/build-runtime.ts` (new)                                                  | GET/PUT `/build-runtime`, POST `/build-runtime/restart`                                                           | the toggle surface the accept test drives; the S8 heal seam                                                   |
| `apps/bubblelab-api/src/index.ts`                                                                       | mount `/build-runtime` behind auth; shutdown hook kills the managed child                                         | route registration lives here (`:111-114`)                                                                    |
| `apps/bubblelab-api/src/routes/build.ts`, `build-page.ts`, `pages.ts`                                   | per-request `getTarget()`; null → 503 `builder_disabled` + logged event                                           | the three proxy sites currently frozen to a module-load env read                                              |
| `apps/bubblelab-api/src/db/schema-postgres.ts` + `schema-sqlite.ts` + new `drizzle-postgres/0022_*.sql` | add `served_by` jsonb to `build_threads`                                                                          | canonical DDL invariant; additive column (no PK change, avoids the drizzle-kit PK-rename gotcha)              |
| `services/builder-agent/src/db.ts`                                                                      | re-declare `servedBy` on `buildThreads`                                                                           | sidecar cannot import the API db layer; must stay column-synced                                               |
| `services/builder-agent/src/config.ts`                                                                  | add `serveMode` from `BUILDER_SERVE_MODE` (default `external`)                                                    | the child cannot infer who launched it                                                                        |
| `services/builder-agent/src/builder.ts`                                                                 | stamp `served_by` in `upsertThread`; emit `served_by` SSE frame at turn start                                     | the logged event Pillar 2 keys on                                                                             |
| `services/builder-agent/src/index.ts`                                                                   | `/health` gains pid/activeBuilds/serveMode; `threadResponse` returns `servedBy`                                   | drain support + test-readable identity                                                                        |
| `scripts/dev-stack.sh`                                                                                  | `BUILDER_MODE` switch: external (launch sidecar, export `BUILDER_SERVE_MODE`) vs managed (skip, pass envs to API) | the stack script is the only launcher today                                                                   |
| `scripts/event-test/fe5-sidecar-toggle.mjs` (new)                                                       | acceptance script below                                                                                           | Pillar 2 gate (thin script on F0.1's harness; standalone on the `gluu-fix-test.mjs` pattern until F0.1 lands) |

## Data model / state

```sql
ALTER TABLE build_threads ADD COLUMN served_by jsonb;
-- {pid: number, port: number, mode: 'external'|'managed',
--  hostname: string, startedAt: iso8601}
```

Written by the sidecar at every turn start (last-writer-wins — the column
answers "which process served the most recent turn", which is what the accept
asks). Runtime state in the API: `{mode, child: ChildProcess | null, target:
string | null}` inside `builder-runtime.ts`; no cross-process coordination
(one API process per stack today; multi-instance API is out of scope and noted
as a risk).

Mode semantics:

| mode       | `getTarget()`                                    | child process                                         | meaning                                                                      |
| ---------- | ------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `external` | `BUILDER_AGENT_URL` (or PUT-supplied url)        | none                                                  | today's behavior; dev default (sidecar restartable independently of the API) |
| `managed`  | spawned child's `http://localhost:<picked port>` | API-owned, drained+killed on mode exit / API shutdown | the FE5 subroutine: harness on = API turns it on                             |
| `off`      | null → 503 `builder_disabled`                    | none (managed child drained then killed)              | builds routed _around_ the sidecar: refused with a clean, logged error       |

## User-facing clarifying questions

1. **Off-mode UX in the studio**: a refused build surfaces today as the
   generation-error path. Is a plain "The builder is temporarily offline, try
   again shortly" message in the chat panel enough (small studio string
   change), or should the composer be disabled preemptively while mode=off
   (needs the studio to poll `/build-runtime`)? Design assumes the message-only
   version.
2. **Page data plane during off**: `off` also 503s `/page/:id/render` and
   `/submit` (published pages go dark, not just builds). Acceptable, or should
   `off` gate only `/build*` while the page plane stays routable? Design
   assumes off = everything dark (one switch, one meaning); easy to split later
   since the lookup is per-route.
3. **Default mode per environment**: design defaults `external` everywhere
   (zero-risk). Flip the live stack to `managed` once proven, so the always-on
   :3010 server disappears from ops? (That flip is one env var, no code.)

## Event-based acceptance test (Pillar 2)

`scripts/event-test/fe5-sidecar-toggle.mjs`, exit-coded, asserts on HTTP
responses, SSE frames, and stored `build_threads` records — never the DOM:

1. Setup: bring a stack up with `BUILDER_MODE=external`; create a scratch flow
   (`POST /bubble-flow/empty`).
2. **Managed serve asserted**: `PUT /build-runtime {mode:'managed'}` →
   response/`GET /build-runtime` shows `child.pid` = P_managed and health ok.
   `POST /build/:flowId/message` (minimal build prompt); consume SSE: assert a
   `served_by` frame with `{mode:'managed', pid: P_managed}`; after `done`,
   `GET /build/:flowId/thread` → `servedBy.pid === P_managed`,
   `servedBy.mode === 'managed'`.
3. **Off refuses and logs**: `PUT /build-runtime {mode:'off'}` → status shows
   `child: null`; assert P_managed is gone (`process.kill(P_managed, 0)`
   throws ESRCH). `POST /build/:flowId/message` → HTTP 503,
   `{error:'builder_disabled'}`. `GET /build/:flowId/thread` → `servedBy.pid`
   still P_managed (no new serve happened — the build went _around_ the
   sidecar).
4. **External serve asserted**: start a standalone sidecar on a probed free
   port (P_external = its `/health` pid, `serveMode:'external'`);
   `PUT /build-runtime {mode:'external', url:'http://localhost:<port>'}`;
   `POST /build/:flowId/message`; assert thread `servedBy.pid === P_external
!== P_managed`, `servedBy.mode === 'external'`.
5. **Restart heal seam**: `POST /build-runtime/restart` under `managed` →
   status shows a new pid; next build's `servedBy.pid` is the new pid (S8's
   future automated heal is proven callable).
6. Cleanup: kill the standalone sidecar by exact pid, delete the scratch flow,
   restore the original mode. Structured JSON report
   `{passed, assertions:[…]}`, non-zero exit on any failure.

`[USER-TEST]` card (taste only, after the event test is green): with mode=off,
send a build message in the studio and judge whether the failure message reads
calm and non-technical (no port numbers, no "sidecar"); flip to managed and
confirm the build experience is indistinguishable from today.

## Dependency surface (Pillar 5 pre-map)

- `BUILDER_AGENT_URL` readers (verified by grep, non-test): `routes/build.ts:21`,
  `routes/build-page.ts:18`, `routes/pages.ts:23` — the complete set of proxy
  sites the manager replaces.
- `build_threads` consumers: sidecar `builder.ts` / `tools.ts` /
  `deferred.ts`; API schema declarations `schema-postgres.ts` /
  `schema-sqlite.ts` / `schema.ts` (dialect switch). Column addition is
  additive; no reader breaks.
- Thread endpoint consumers: studio `useBuildChat.ts` (rehydration) and
  `usePearlStream.ts:355` (`useBuildThreadStatus`) — additive `servedBy` field,
  ignored by existing readers. New `served_by` SSE frame falls into
  `usePearlStream`'s unknown-event handling (verify it drops unknown events
  silently during build; if not, whitelist it).
- `scripts/dev-stack.sh` launch seam (`:83-87`) and its `wait_http` health
  gate (`:100`) — managed mode must skip both the launch and the sidecar
  health wait (the API's own health implies the child when managed).
- `test/benchmark.mjs` and `gluu-fix-test.mjs` hit the sidecar directly —
  unaffected (direct hits keep working in every mode; they bypass the API
  switch by design).

## Risks

1. **Orphaned managed child**: the API dying hard (SIGKILL, WSL reap) leaks a
   child sidecar holding a port. Mitigation: shutdown hooks for
   SIGINT/SIGTERM/exit; child pid recorded in `status()` and the API log so it
   is findable and killable by exact pid; the child dies naturally on next
   `setMode`. Never pattern-kill (supervisor-gotchas memory).
2. **Kill mid-build**: SIGTERM during an active turn strands the thread
   `building` and drops the user's SSE stream. Mitigation: drain-before-kill
   via `/health.activeBuilds`, force-kill only after timeout; `resume` +
   sticky-status already recover a dropped turn.
3. **Bun-spawns-Node quirks**: `Bun.spawn`/`child_process` under Bun on WSL,
   plus PATH poisoning (Windows node/bun on /mnt/c PATH — memory
   `wsl-mntc-pnpm-eacces`). Mitigation: resolve the binary from `NODE` env
   (dev-stack already has this convention), absolute cwd, log-file capture;
   probe with a throwaway script before wiring (then record learnings per the
   memory rule).
4. **Concurrency guard split-brain**: `activeBuilds` is per-sidecar-process;
   external + managed sidecars running at once (test step 4) could serve the
   same flow concurrently if toggled mid-build. Mitigation: only one target is
   routable at a time and toggling drains first; a DB-level build lock is a
   follow-up row if parallel sidecars ever become intentional.
5. **Free-port race**: probe-then-spawn can lose the port between probe and
   listen. Mitigation: retry spawn on bind failure (bounded); port range kept
   off the OAuth-registered API range (Pillar 3 does not apply — the sidecar
   terminates no OAuth redirects).
6. **`off` darkens published pages** (see clarifying question 2) — a user with
   a live page sees render failures while builds are paused. Split the gate if
   the answer to Q2 is "pages stay up".
7. **Multi-instance API**: mode is in-memory; two API processes could disagree
   (one managed child each). Out of scope today (one API per stack); noted so
   a prod scale-out revisits the state location.

## Sources

- `services/builder-agent/src/{index,builder,config,db}.ts`,
  `services/builder-agent/package.json` — read in full this discovery pass
  (2026-08-01).
- `apps/bubblelab-api/src/routes/{build,build-page,pages}.ts`,
  `src/index.ts:78-114`, `src/db/schema-postgres.ts:310`.
- `scripts/dev-stack.sh:60-112` (launch + pidfile + health-wait seams).
- `DISPATCH-CONTRACT.md` Pillars 2/5; `BACKLOG.md` FE5 row; memory
  `firecrawl-nested-cred-inconsistency` (KIV origin), `supervisor-restart-gotchas`,
  `wsl-mntc-pnpm-eacces`, `self-test-tool-and-binary-fixer` (S8 stale-cred
  context).
