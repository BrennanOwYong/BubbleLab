# Dispatch Contract — checks & balances for every flow-builder task

The enforced definition-of-done for any task dispatched against this repo. A
task is not complete until **every** pillar below holds. `BACKLOG.md` is the
single source of truth for what is in flight; this file is the rulebook for how
each item gets built, tested, shipped, and recorded.

One task = one branch = one PR = one `BACKLOG.md` row.

---

## Pillar 1 — Roadmap-first planning (plan like a PM)

Before any code on a task:

1. The task exists as a row in `BACKLOG.md` with: id, type (systemic / UX / feature / foundation), status, `depends-on`, target files, and its **event-based acceptance test** (Pillar 2).
2. Dependency order is respected. A task does not start while a `depends-on` task is unfinished. The roadmap phases in `BACKLOG.md` encode this (foundations → systemic resolution → UX → features).
3. Every user-facing change carries a `[USER-TEST]` breakpoint: a scenario card (setup script, what-to-do, what-you-are-judging = taste/UX only, already-verified-by-agent). This is a **human taste check, never the automated gate**.
4. A written brief accompanies the dispatch: problem, purpose, loose approach (not step-by-step), resources, contract-shaped required outputs, and the deviation clause (surface course-corrections, never silently force-fit).

## Pillar 2 — Testing reads logged events, not the screen

Visual/DOM inspection is unreliable and is **never** the acceptance gate. Every
task ships an automated test that drives the real path and asserts on **logged
events**, exiting non-zero on failure. The event substrate already exists:

| Source        | Endpoint / artifact                                              | What it proves                                                                                                   |
| ------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Flow run      | `POST /bubble-flow/:id/execute-stream` (SSE `StreamingLogEvent`) | `bubble_execution_complete{result.success}`, `execution_complete{success, finalResult}`, `error`/`fatal`, `warn` |
| Run history   | `GET /bubble-flow/:id/executions?limit=N` → `items[].result`     | persisted final result of a specific run                                                                         |
| Error signals | studio `collectRunErrorSignals(events)`                          | canonical failed-step / HTTP / run-level failures (the same list the UI keys on)                                 |
| Agent turn    | `GET /build/:flowId/thread` → `transcript[].blocks[]`            | what the agent said + which tools it called (`tool_use{name,input}`)                                             |
| Client errors | `POST`/`GET /telemetry` (in-memory ring buffer)                  | studio console/network errors, queryable by curl                                                                 |
| Headless UI   | `agent-browser` (`vercel-browser-agent/studio-test.mjs`)         | console/network/telemetry/DOM, exit-coded — reads logs, not pixels                                               |

**Rule:** if a behavior can be asserted from a logged event, the test asserts
on the event. New behavior that has no observable event MUST emit one — the
architectural decision is to log almost everything so the tester never relies on
looking at the website. The reusable harness for this lives at
`scripts/event-test/` (Foundation F0.1); every task's test is a thin script on
top of it that returns a structured pass/fail report.

**UX acceptance lens (F0.5):** every UX task's event test also includes a
"no technical leakage" assertion derived from `PRODUCT-PRINCIPLES.md` — the
render-feeding data (telemetry payloads, node view-models, setup-panel data)
contains none of the checklist's banned items (raw param names, `*_CRED`
constants, jargon labels, code internals). See that doc's per-task lens table
for the exact check per task.

## Pillar 3 — Multi-port OAuth so parallel branches work

Port drift only bites under parallel branch testing: `scripts/dev-stack.sh`
auto-allocates a free trio per branch from `PORT_BASE=3100` (API = first free
≥3100, then sidecar, then studio), so stacked branches land API ports ~3100,
3103, 3106… none of which are registered as OAuth redirect URIs.

Two-part fix (Foundation F0.3):

1. **Register the whole range in Google Cloud.** Add
   `http://localhost:<p>/oauth/google/callback` for every candidate API port
   `p` in `3100..3130` (≥10 parallel stacks; Google allows ~100 redirect URIs),
   keeping legacy `3000`/`3001`. Any branch's auto-picked port is then recognized.
2. **`dev-stack.sh` exports per-stack OAuth env.** When it launches the API it
   must set `NODEX_API_URL=http://localhost:$API_PORT` (redirect_uri Google
   receives) and `DASHBOARD_URL=http://localhost:$STUDIO_PORT` (post-callback
   return). Today it sets neither, so OAuth silently targets the wrong port.

## Pillar 4 — Auto-PR on end-to-end green

When a task branch **builds** and its **event tests pass**, it auto-opens a PR
via `gh` against `BrennanOwYong/BubbleLab`. The PR is the surgical hand-off
document — written so another coding agent can examine, exhume, refactor, or
revert this exact deliverable in isolation. Required body sections:

```
## Problem            — the inciting reason (bug/want)
## Root cause         — how diagnosed + the actual cause (file:line / probe output)
## What was built     — features, each tied back to the root cause / why it follows
## How verified       — exact test command + which event assertions passed (pass/fail, not "it works")
## Files touched      — every path with file:line anchors
## Surgical map       — entry points, the invariant this change holds, how to
                        safely exhume/refactor without breaking dependents
## Backlog            — the BACKLOG.md row id this closes/advances
```

A PR that does not build or whose event tests fail is not opened — it stays a
draft with the failing test output attached.

## Pillar 5 — Refactors grounded in deep research

No architectural change from memory or assumption. Any refactor/overhaul opens
with a research pass, recorded **in the branch before a line changes**:

1. **Dependency surface** — grep every importer/dependent of the touched module and list them explicitly (see CLAUDE.md "Refactoring — map dependent files").
2. **Authoritative docs** — for any external SDK/API, read the vendor's own reference and persist the exact deep links in a `## Sources` block on the changed module or plan doc.
3. **Architecture map** — a short note of the current design being changed and why the new design follows, so the decision is auditable.

After the build passes: delete importers made unreferenced by the change, and
remove dead code (orphaned functions/types) the change created.

## Pillar 6 — `BACKLOG.md` is updated on every PR

`BACKLOG.md` is the canonical tracker — never a parallel file. A task's PR is
**not complete** until, in the same PR, its `BACKLOG.md` row is updated:

- status → `In review` on PR open, `Done` on merge;
- the PR link recorded on the row;
- the `verified-by` test command recorded on the row;
- any newly discovered follow-up added as a fresh `Not started` row (with its own event test), never dropped silently.

If a change alters scope, the row's acceptance test is updated in the same PR so
the tracker never drifts from reality.

## Pillar 7 — PRD + agreement contract + INDEPENDENT verification

The builder never grades its own homework. Every dispatched task has three
separable artifacts and a separate verifier:

1. **PRD** — the task's discovery brief (`PLAN-DOCS/discovery/<id>.md`) is the
   Product Requirements Document: problem, approach, files, data model. No task
   is dispatched without one.
2. **Agreement contract** — the row's `_Accept:_` clause states, in
   event-based terms, exactly what "done" means. It is frozen before the build
   and is what the verifier checks against — not the builder's self-report.
3. **Independent verification subagent** — after the builder finishes, a
   **separate** subagent (never the one that built it) autonomously runs the
   agreement contract's event tests against the real path and returns a
   CONFIRMED / REFUTED verdict with the evidence. A task is not "verified" on
   the builder's own typecheck+test; it is verified only when the independent
   agent confirms the contract holds. Refuted → back to the builder with the
   failing evidence.

**Reviewable delta (backend / non-user-facing).** For any task the user does
not test by hand, the completion report includes a **delta for review**: the
`git diff` (or, pre-commit, the diff of the touched files) plus a plain-language
"what changed and why" so the change can be reviewed without re-deriving it.

**Awareness split.** User-facing features → a `[USER-TEST]` card the user is
explicitly handed (they test the feel). Everything else → the independent
verdict + the delta; the user reviews, never hand-tests.

**Tracker liveness.** A row moves to `WIP` when dispatched, `LOCAL`/`REVIEW`
when built + independently verified, `DONE` on merge. Build subagents do NOT
edit `BACKLOG.md` (write-race); the coordinator reconciles the row on each
task's completion so the tracker reflects reality continuously, not only at PR.

---

## Definition of Done (the composite gate)

A task is Done only when ALL hold:

- [ ] Has a PRD (discovery brief) and a frozen event-based agreement contract (P1, P2, P7)
- [ ] Deep research recorded in-branch if it touched architecture (P5)
- [ ] Builds clean (typecheck + lint) and the event tests pass, exit 0 (P2)
- [ ] **Independently verified** — a separate subagent ran the contract and returned CONFIRMED (P7)
- [ ] Reviewable delta produced for backend tasks; `[USER-TEST]` card for user-facing (P7, P1)
- [ ] Auto-PR opened with the full surgical body (P4)
- [ ] `BACKLOG.md` row updated: status, PR link, verified-by (P6)
- [ ] OAuth-touching work honors the multi-port rule (P3)
