# FND discovery: F0.1 event-assertion harness + F0.2 auto-PR-on-green

Status: DISCOVERY ONLY. No source file modified. Branch: `phase4-builder-harness`.
Backlog rows: `BACKLOG.md:21` (F0.1), `BACKLOG.md:22` (F0.2, depends-on F0.1).
Contract: `DISPATCH-CONTRACT.md` Pillar 2 (lines 22-41) and Pillar 4 (lines 61-80).

---

## 0. What exists today (the ad-hoc scripts being generalized)

Three scripts implement the same primitives independently; F0.1 factors them
into one library so every later task's test is a thin file on top.

| Script               | Location                                            | Primitives it carries                                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drive-fix-loop.mjs` | session scratchpad (not in repo)                    | save code via `POST /bubble-flow/validate`, run via `POST /bubble-flow/:id/execute-stream` SSE, port of `collectRunErrorSignals`, compose `[RUN ERROR REPORT]` message, sidecar `POST /build/:id/message` SSE, re-run + verdict                                        |
| `gluu-fix-test.mjs`  | `/home/unix/vercel-browser-agent/gluu-fix-test.mjs` | fixture seeding (`/bubble-flow/empty` + `/validate`), `sseCollect`, `runErrorSignals`, build-thread polling (`GET /build/:flowId/thread` transcript, `tool_use` blocks, sessionId identity), agent-browser wrapper `ab()`, `assert`/`report`/`finish` with exit coding |
| `studio-test.mjs`    | `/home/unix/vercel-browser-agent/studio-test.mjs`   | agent-browser console/errors/network/telemetry collection, text/visible assertions, one-JSON-on-stdout + exit-coded verdict                                                                                                                                            |

Duplication to kill: `runErrorSignals` now exists in three JS copies plus the
canonical TS at
`apps/bubble-studio/src/utils/executionErrorSignals.ts:53`
(`collectRunErrorSignals`). The harness ships ONE port and every test uses it.

Event substrate confirmed against source:

- `POST /bubble-flow/:id/execute-stream` streams SSE `StreamingLogEvent` frames
  (`data:` lines, `\n\n` delimited); `execution_complete.additionalData.success`
  is the run verdict.
- `GET /bubble-flow/:id/executions?limit=N&offset=M` returns
  `{ items: [{ id, status: 'running'|'success'|'error', payload, result, error?, startedAt, completedAt?, webhook_url, code? }], total }`
  (`apps/bubblelab-api/src/routes/bubble-flows.ts:1069-1096`).
- Sidecar: `GET /build/:flowId/thread` (`services/builder-agent/src/index.ts:140`)
  returns `{ sessionId, status, transcript: [{ role, blocks: [{type:'text',text}|{type:'tool_use',name,input}|...] }] }`;
  `POST /build/:flowId/message` (`index.ts:213`) streams the agent turn as SSE.
- `POST /telemetry` / `GET /telemetry?type=&flowId=&since=&limit=` is a
  2000-event in-memory ring buffer with server-stamped `seq`
  (`apps/bubblelab-api/src/routes/telemetry.ts`); `since` is an ISO timestamp,
  `type` accepts a comma list. Buffer resets on API restart, so tests must take
  a baseline (`seq` high-water mark) before acting and filter after.
- Stack ports per branch come from `scripts/dev-stack.sh`:
  `.dev-stack/<SLUG>.pids` with lines `<pid> <svc> <port>`, `svc` one of
  `api|sidecar|studio`; `SLUG = branch | tr '/ .' '___'`
  (`dev-stack.sh:21-25`). Live example on this branch:
  `1287 api 3100 / 6024 sidecar 3101 / 1289 studio 3102`.

---

## F0.1 — Event-assertion test harness at `scripts/event-test/`

### Purpose

One reusable library that drives a real path (API, sidecar, optionally headless
studio), collects all four event sources, asserts on logged events per Pillar 2,
emits one structured JSON report on stdout, and exits coded. Every later task
(S1-S8, U*, FE*) writes a thin `tests/<id>.test.mjs` on top; none re-implements
SSE parsing, signal collection, or reporting.

### Files

```
scripts/event-test/
  package.json            # { "type": "module" }; zero npm deps (node >= 20 built-ins only)
  harness.mjs             # createHarness() facade; the ONLY import tests need
  lib/stack.mjs           # port/stack resolution (flags > env > pidfile), health probe
  lib/api.mjs             # json fetch helper + sseCollect (both SSE framings seen in repo)
  lib/signals.mjs         # runErrorSignals: 1:1 port of studio collectRunErrorSignals
  lib/sources.mjs         # collectors: executeStream, executions, buildThread, buildMessage, telemetry
  lib/fixtures.mjs        # seedFlow (/bubble-flow/empty + /validate w/ syncInputsWithFlow), deleteFlow
  lib/browser.mjs         # optional agent-browser wrapper (shells to /home/unix/vercel-browser-agent)
  lib/report.mjs          # assert/section/finish, report assembly, event-dump writer
  run.mjs                 # CLI runner: executes N test files, aggregates, writes .reports/latest.json
  tests/
    _smoke.test.mjs       # harness self-acceptance (see below)
  .reports/               # gitignored; per-run report + full event dumps
```

Placement inside the repo (unlike the current `/home/unix/vercel-browser-agent`
scripts) is deliberate: the harness ships with the branch it tests, so F0.2 and
CI can run it from any checkout. `lib/browser.mjs` resolves the agent-browser
binary from `AGENT_BROWSER_BIN` env, falling back to
`/home/unix/vercel-browser-agent/node_modules/.bin/agent-browser`; browser use
stays optional because Pillar 2 prefers logged events over DOM.

### Interfaces (harness.mjs exports)

```js
// Resolution order per value: explicit opts > EVENT_TEST_{API,SIDECAR,STUDIO}_URL env
// > .dev-stack/<slug>.pids for the current branch (pids liveness-checked with
// kill -0 + one HTTP probe) > hard error with exitCode 3 (stack-unavailable).
export async function createHarness(opts?: {
  name: string;              // test id, e.g. "S6.gluu-fix.sheet-id"
  backlogId?: string;        // BACKLOG.md row this test verifies
  api?: string; sidecar?: string; studio?: string;
  timeoutMs?: number;        // global budget, default 8 min (agent turns run 1-5 min)
}): Promise<Harness>;

interface Harness {
  // raw transports
  api(path, init?)                    -> { status, body }        // JSON in/out vs API base
  sse(base, path, payload, timeoutMs) -> events[]                // parsed data: frames
  // event-source collectors (Pillar 2 table, one method per row)
  executeStream(flowId, payload?)     -> { events, success, signals }  // signals = runErrorSignals(events)
  executions(flowId, limit?)          -> items[]                 // GET /bubble-flow/:id/executions
  buildThread(flowId)                 -> { sessionId, status, transcript }
  buildMessage(flowId, message)       -> { events, toolCalls, assistantText } // sidecar SSE turn
  awaitThreadTurn(flowId, { markerText, timeoutMs }) -> { thread, markerIdx, afterMarker } // poll until status leaves 'building'
  telemetryBaseline()                 -> seq                     // high-water mark before acting
  telemetry({ type?, flowId?, sinceSeq?, limit? }) -> events[]   // filters client-side on seq
  // fixtures
  seedFlow({ name, prompt, eventType, code, defaultInputs? }) -> flowId  // registers auto-cleanup
  cleanup(fn)                                                    // extra teardown, LIFO on finish
  // optional headless UI (only when a behavior has no logged event yet; Pillar 2
  // says such behavior MUST gain an event, so browser use is a temporary bridge)
  browser(session?)                   -> { open, evalJs, clickText, consoleErrors, close }
  // verdict
  assert(name, pass, detail?)         // records + mirrors PASS/FAIL to stderr
  section(label)                      // groups subsequent assertions in the report
  finish()                            -> never                   // prints report JSON, exits coded
}
```

`lib/signals.mjs` must carry a header comment pinning it to
`apps/bubble-studio/src/utils/executionErrorSignals.ts:53` with the rule: any
change to the studio function updates this port in the same PR (S5 touches that
file; its row already depends on F0.1).

### Report JSON shape (stdout, one document; stderr = human PASS/FAIL lines)

```json
{
  "test": "S6.gluu-fix.sheet-id",
  "backlogId": "S6",
  "branch": "phase4-builder-harness",
  "stack": {
    "api": "http://localhost:3100",
    "sidecar": "http://localhost:3101",
    "studio": "http://localhost:3102",
    "source": "pidfile"
  },
  "startedAt": "2026-08-01T03:00:00.000Z",
  "durationMs": 184211,
  "assertions": [
    {
      "section": "run-1",
      "name": "error surfaced as FAILED STEP signal",
      "pass": true,
      "detail": "google-sheets: Requested entity was not found"
    }
  ],
  "artifacts": {
    "flowIds": [91],
    "executionIds": [412, 413],
    "sessionId": "b2c…"
  },
  "eventCounts": { "executeStream": 42, "buildThread": 12, "telemetry": 3 },
  "eventDumpPath": "scripts/event-test/.reports/S6.gluu-fix.sheet-id-1754017200.events.json",
  "pass": false,
  "exitCode": 1
}
```

Full raw events go to `eventDumpPath` (never inlined; agent turns produce
hundreds of frames). Exit codes are load-bearing for F0.2:

- `0` all assertions pass
- `1` at least one assertion failed (a real red)
- `2` usage/config error (bad flags, unknown test file)
- `3` stack unavailable (no live pidfile stack, health probe failed): infra
  problem, NOT a code failure; F0.2 must refuse to act on it rather than open a
  "failing" draft

### Runner (`run.mjs`)

```
node scripts/event-test/run.mjs [--api URL --sidecar URL --studio URL] \
     [--report path] tests/a.test.mjs [tests/b.test.mjs ...]
```

Runs each test file as a child process, captures its stdout JSON, aggregates to
`{ pass, exitCode (max of children), reports: [...] }`, writes
`scripts/event-test/.reports/latest.json` (the fixed path F0.2 reads), prints
the aggregate to stdout, exits with the max child exit code.

### Acceptance test (F0.1 is itself gated by Pillar 2)

`tests/_smoke.test.mjs`, run against the live branch stack:

1. `seedFlow` a minimal cron flow (open-meteo HttpBubble, no credentials);
   assert validate saved it.
2. `executeStream` it; assert `execution_complete` present with
   `additionalData.success === true` and `signals.length === 0`.
3. `executions(flowId, 1)`; assert `items[0].status === 'success'` and the
   persisted `result` matches the streamed `finalResult` run.
4. `telemetryBaseline()` then `POST /telemetry` one synthetic event via
   `t.api()`; assert `telemetry({ sinceSeq })` returns exactly it.
5. `buildMessage(flowId, "In one sentence, what does this flow do? Do not change anything.")`
   then `buildThread(flowId)`; assert `sessionId` non-null and the transcript
   contains the user turn.
6. Negative-path harness checks, run by a tiny wrapper (`_smoke` invokes itself
   as a child): (a) a deliberately failing assertion produces `pass:false` +
   exit 1 + valid report JSON; (b) `createHarness({ api: 'http://localhost:1' })`
   exits 3 without opening a report claiming assertions ran.

Verified-by command for the BACKLOG row:
`node scripts/event-test/run.mjs scripts/event-test/tests/_smoke.test.mjs`

---

## F0.2 — Auto-PR-on-green hook

### Purpose

One command a task branch runs when it believes it is done. It enforces the
Pillar-4 gate mechanically: build + event tests green opens a real PR with the
surgical body; red opens/updates a DRAFT with the failing report attached;
stack-unavailable refuses to do anything. Idempotent per branch.

### Files

```
scripts/event-test/pr-on-green.mjs     # the hook (lives beside the harness it consumes)
PLAN-DOCS/pr-bodies/<backlog-id>.md    # per-task authored body sections (see below)
```

No git hook installation: the builder agent invokes it as the final step of a
task (the DISPATCH-CONTRACT DoD is checked by the dispatching session, not by
git plumbing). A later CI wiring can call the same script unchanged.

### Interface

```
node scripts/event-test/pr-on-green.mjs \
  --id S6 \                                    # BACKLOG row; also picks PLAN-DOCS/pr-bodies/S6.md
  --title "S6: fixer binary-triage robustness" \
  --tests "scripts/event-test/tests/S6.gluu-fix.test.mjs [...]" \
  [--base <branch>]      # default: gh repo view --json defaultBranchRef
  [--skip-build]         # event tests only (build already proven this session)
  [--dry-run]            # run all gates, print composed body + intended action, no gh calls
```

Gates, in order (each timed, each recorded):

1. Preconditions: current branch is not the base branch; `git status --porcelain`
   empty (all work committed); branch pushed (`git push -u origin HEAD` if not).
2. Build: `pnpm typecheck && pnpm lint:check` at repo root (the DoD line is
   "builds clean (typecheck + lint)", `DISPATCH-CONTRACT.md:115`; full
   `pnpm build` stays opt-in via `--full-build` because turbo build of the
   whole workspace is minutes-long and typecheck subsumes tsc errors).
3. Event tests: `node scripts/event-test/run.mjs --report .reports/latest.json <tests>`;
   consume the aggregate report.

### Body composition (the Pillar-4 surgical body)

The four judgment sections cannot be generated; the two mechanical ones must
never be hand-written. Split:

- Authored by the task agent in `PLAN-DOCS/pr-bodies/<id>.md` (checked in on
  the branch, so the body is reviewable before the PR exists):
  `## Problem`, `## Root cause`, `## What was built`, `## Surgical map`,
  `## Backlog` (row id + status change this PR carries per Pillar 6).
- Injected by the hook at compose time:
  - `## How verified`: the exact runner command, then a table of every
    assertion (`section | name | pass | detail`) from the report JSON, plus the
    report's `eventDumpPath` reference. Pass/fail facts, never "it works".
  - `## Files touched`: `git diff --name-status $(git merge-base HEAD <base>)..HEAD`
    with per-file line anchors from `git diff --stat`.

The hook validates the authored file contains all five of its headings and
refuses (exit 2) if any is missing, so a PR can never open with a hollow body.

### gh commands (gh 2.94.0 present at /usr/bin/gh; remote = BrennanOwYong/BubbleLab)

```bash
# base resolution (once):
gh repo view BrennanOwYong/BubbleLab --json defaultBranchRef --jq .defaultBranchRef.name
# idempotency probe:
gh pr list --repo BrennanOwYong/BubbleLab --head "$BRANCH" --state open --json number,isDraft --jq '.[0]'
# green, no existing PR:
gh pr create --repo BrennanOwYong/BubbleLab --base "$BASE" --head "$BRANCH" \
  --title "$TITLE" --body-file "$COMPOSED_BODY"
# red, no existing PR (failing aggregate report appended under '## Failing event tests'):
gh pr create --repo BrennanOwYong/BubbleLab --base "$BASE" --head "$BRANCH" \
  --title "DRAFT: $TITLE" --draft --body-file "$COMPOSED_BODY_WITH_FAILURES"
# existing PR (green or red): refresh body, then promote if newly green:
gh pr edit "$PR_NUMBER" --repo BrennanOwYong/BubbleLab --body-file "$COMPOSED_BODY"
gh pr ready "$PR_NUMBER" --repo BrennanOwYong/BubbleLab        # only when draft -> green
```

Note `git symbolic-ref refs/remotes/origin/HEAD` in this clone points at
`integration/live-testing`; the hook must trust `gh repo view` (server truth),
never the local symref.

### Hook report JSON (stdout) + exit codes

```json
{
  "branch": "task/S6-fixer-triage",
  "base": "integration/live-testing",
  "gates": {
    "preconditions": { "pass": true },
    "typecheck": { "pass": true, "durationMs": 41000 },
    "lint": { "pass": true, "durationMs": 22000 },
    "eventTests": {
      "pass": false,
      "exitCode": 1,
      "reportPath": "scripts/event-test/.reports/latest.json",
      "assertions": 14,
      "failed": 2
    }
  },
  "action": "draft-created",
  "prUrl": "https://github.com/BrennanOwYong/BubbleLab/pull/123",
  "exitCode": 1
}
```

`action` is one of `created | updated | ready | draft-created | draft-updated |
refused-stack-unavailable | refused-preconditions | dry-run`. Exit: `0` real PR
open/ready; `1` gates red (draft state); `2` usage/preconditions/missing body
sections; `3` propagated stack-unavailable (nothing opened, nothing edited).

### Acceptance test

Scriptable end-to-end on a throwaway branch (`f02-acceptance`), using `_smoke`
plus a deliberately-failing twin (`_smoke_red.test.mjs`, one inverted
assertion):

1. Red path: `pr-on-green --id F0.2 --tests _smoke_red --dry-run` exits 1,
   `action:"dry-run"`, composed body contains `## Failing event tests` with the
   inverted assertion listed.
2. Green path: same with `_smoke` exits 0 and the composed body contains all
   seven Pillar-4 headings, with the `## How verified` table row count equal to
   the smoke report's assertion count.
3. Guard path: point the harness at a dead port; hook exits 3 and emits
   `action:"refused-stack-unavailable"`, proving no draft claims a code failure.
4. One real (non-dry-run) invocation on the throwaway branch against GitHub:
   red first (draft PR opens), then flip the twin to green and re-invoke
   (same PR edited + `gh pr ready`), then close the PR and delete the branch.

Verified-by command for the BACKLOG row: the three dry-run/guard invocations
above wrapped as `scripts/event-test/tests/_pr_hook.test.mjs` (the hook is
itself exercised through the harness, so F0.2's own gate is event-shaped).

---

## Build order and dependency notes

1. F0.1 lands first (F0.2's `--tests` gate and its acceptance both consume it);
   matches `depends-on` in `BACKLOG.md:22`.
2. Every systemic row S1-S8 already depends on F0.1; their discovery docs
   (PLAN-DOCS/discovery/S\*.md) should name their `tests/<id>.test.mjs` path in
   the verified-by column once F0.1 merges.
3. `.reports/` needs a `.gitignore` entry inside `scripts/event-test/` so event
   dumps never enter a PR.
4. `pr-bodies/` under PLAN-DOCS keeps authored sections in-branch per Pillar 5's
   "recorded in the branch before a line changes" spirit; the F0.2 PR itself
   ships `PLAN-DOCS/pr-bodies/F0.2.md` as the first instance.

## Sources

- `DISPATCH-CONTRACT.md:22-41` (Pillar 2), `:61-80` (Pillar 4), `:109-119` (DoD)
- `apps/bubblelab-api/src/routes/bubble-flows.ts:1069-1096` (executions shape)
- `apps/bubblelab-api/src/routes/telemetry.ts` (ring buffer, GET filters, seq)
- `services/builder-agent/src/index.ts:140,213` (thread + message routes)
- `apps/bubble-studio/src/utils/executionErrorSignals.ts:53` (canonical signals)
- `scripts/dev-stack.sh:21-25,52-56` (SLUG + pidfile format, port allocation)
- `/home/unix/vercel-browser-agent/gluu-fix-test.mjs`, `studio-test.mjs` (patterns generalized)
- gh CLI manual, `pr create`/`pr edit`/`pr ready`/`pr list` (gh 2.94.0 local)
