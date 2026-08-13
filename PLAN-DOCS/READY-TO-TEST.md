# Ready-to-test — independent verification report

_Generated 2026-08-01. Method: `scripts/event-test/run.mjs` (F0.1 harness) executed
directly against the live-rebuilt stack (API :3102, sidecar :3103, studio :3104,
branch `phase4-builder-harness`), read assertion-by-assertion from the raw JSON
report — not the builder's self-report. This is real event-based evidence per
DISPATCH-CONTRACT.md Pillar 2/7._

**Note on independence:** the planned 19-agent contract-fidelity audit (a
separate subagent reading each test against its frozen `_Accept:` clause) could
not run — both the Agent tool and Workflow tool are currently hard-blocked
account-wide on a Fable-5 usage limit, reproduced twice with `model:'sonnet'`
explicitly pinned and confirmed unaffected by the `/model sonnet` default
change. In its place, the coordinating session personally read the raw
mechanical evidence and spot-checked the two highest-risk items against source
(below) — weaker than a fully separate agent, but grounded in real logged
events, not self-report. Re-run the fidelity audit once `/usage-credits`
clears; it may surface additional gaps like the S1a one found here.

## Headline

**17 of 19 tracked backend/UX/feature items are CONFIRMED** by real mechanical
event-test evidence. **2 items have real, specific gaps** — not flaky tests,
not self-report — found by directly reading source and test code:

| id   | verdict                 | evidence                                                                                                           |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| F0.1 | CONFIRMED               | harness itself: ran all 18 downstream tests successfully                                                           |
| S1a  | **REFUTED — not built** | `BubbleInjector.ts:312,389` still has the exact broken `new Function(...)` string-eval S1a was supposed to replace |
| S1b  | CONFIRMED               | `s1_platform_credentials.test.mjs` 8/8                                                                             |
| S2   | CONFIRMED               | `s2_ternary_lint.test.mjs` 18/18                                                                                   |
| S3   | CONFIRMED               | `s3_capability_discovery.test.mjs` 13/13                                                                           |
| S4   | CONFIRMED               | `s4_requirement_completeness.test.mjs` 24/24                                                                       |
| S5   | CONFIRMED               | `s5_error_identity.test.mjs` 14/14                                                                                 |
| S6   | CONFIRMED               | `s6_fixer_triage.test.mjs` 20/20 (incl. 2 live agent turns)                                                        |
| S7   | CONFIRMED               | `s7_oauth_state.test.mjs` 14/14 (real cross-process proof)                                                         |
| S8   | **PARTIAL — 9/10**      | `s8_auth_refresh.test.mjs`; substance holds, 1 assertion fails on a flag-scoping bug, see below                    |
| U-1  | CONFIRMED               | `u-1_credential_request.test.mjs` 6/6                                                                              |
| U-3  | CONFIRMED               | `u-3_drag_persist.test.mjs` 6/6                                                                                    |
| U-4  | CONFIRMED               | `u-4_edge_labels.test.mjs` 5/5                                                                                     |
| U1   | CONFIRMED               | `u1_curated_view.test.mjs` 9/9 (incl. F0.5 no-leakage lens)                                                        |
| U2   | CONFIRMED               | `u2_result_surfaces.test.mjs` 15/15                                                                                |
| U3   | CONFIRMED               | `u3_overflow.test.mjs` 4/4                                                                                         |
| U5   | CONFIRMED               | `u5_setup_completeness.test.mjs` 11/11 (incl. F0.5 no-leakage lens)                                                |
| FE1  | CONFIRMED               | `fe1_credential_gap_autorun.test.mjs` 21/21                                                                        |
| FE2  | CONFIRMED               | `fe2_user_memory.test.mjs` 16/16                                                                                   |
| FE4  | CONFIRMED               | `fe4_native_capability.test.mjs` 16/16                                                                             |
| FE5  | CONFIRMED               | `fe5_builder_mode.test.mjs` 14/14                                                                                  |

Full per-assertion evidence: `scripts/event-test/.reports/latest.json` (this
run) and the individual `*-<timestamp>.events.json` dumps per test.

## Gap 1 — S1a nested-tool AST detection: not built

`BACKLOG.md`'s frozen S1a contract calls for replacing the broken
`new Function('return ' + toolsParam.value)` string-eval in
`packages/bubble-runtime/src/injection/BubbleInjector.ts` (throws on any
variable reference, silently returns `[]`) with the AST-walk prototype already
proven at `composio-eval/ast-detector/` (12/12, later re-confirmed 14/14
including 11 hard cases the current code drops). Direct read of the file
(2026-08-01) shows lines 312 and 389 are unchanged — still the old string-eval.

The `s1_platform_credentials.test.mjs` test that reports green only exercises
`tools: [{name:'web-search-tool'}]` — a single literal array, which the _old_
code already parses correctly (it's in BACKLOG's own "8/12 today" bucket). It
never exercises const-array, spread, ternary, or dynamic/unresolved variants —
the exact cases S1a exists to fix. The exec workflow that self-reported S1
"done" built S1b (classification) only and never touched `BubbleInjector.ts`.

**This needs an actual dispatch**, not a re-verify: port the AST walk from
`composio-eval/ast-detector/` into `extractToolCredentials` /
`extractCapabilityCredentials` in `BubbleInjector.ts`, replacing both
`new Function(...)` call sites, then extend `s1_platform_credentials.test.mjs`
(or a new `s1a_ast_detection.test.mjs`) to cover the const/spread/ternary/
dynamic variants per the frozen accept clause.

## Gap 2 — S8 auth frame: flag-scoping bug, not a functional break

9 of 10 real assertions pass — no 401, no `auth_error` frame, the build turn
reaches `ready`, the dead-credentials negative control correctly reports
`error`. The one failure: `authIdx=-1` — no `auth` SSE frame in the build
stream carries `{repaired:true, expired:false}`.

Root cause (`services/builder-agent/src/claude-auth.ts`): `ensureClaudeAuth()`
sets `repaired=true` only on the call that performs the fix. The test's first
call (`GET /health/auth`) performs and reports the repair; the build SSE
stream's own `ensureClaudeAuth()` call is the _second_ call in that process —
nothing left to fix, so `repaired:false` is the correct answer for that call,
not a bug in the repair logic itself.

Two legitimate fixes, either is small: (a) loosen the test to assert
`expired:false && linked:true` regardless of `repaired` (the actual S8
guarantee), or (b) make the auth frame report "repaired at any point this
process" rather than "repaired this exact call." Recommend (a) — cheaper,
matches what S8's contract actually promises.

## What's still open (not blocking, tracked separately)

- **Contract-fidelity audit** (does each passing test actually assert the full
  frozen contract, not just what it happened to check) — blocked on subagent
  dispatch (Fable-5 limit), pending user's `/usage-credits`. Worth re-running:
  it's exactly the process that would have caught the S1a gap systematically
  instead of by manual spot-check.
- **S9** (true credential disconnect) — not yet dispatched.
- **User's own Google Cloud dashboard actions** — port-range registration
  (`docs/oauth-google-cloud-setup.md`) and consent-screen publish, status
  unconfirmed.
- **Composio C0 pilot** — Notion reconnect link expired, needs a fresh probe
  run when the user is ready.

## [USER-TEST] — features worth a human look

Everything above is event-verified; nothing here needs re-checking for
correctness. These are worth _feeling_, not testing, on the live stack at
`http://localhost:3104`:

1. **Result node** (U2) — build any flow, run it once, click the canvas
   result node and check the convo's result widget. Judge: does the artefact
   link / outcome list read clearly to a non-technical eye?
2. **Curated node view** (U1) — expand an AI-agent node and a tool node.
   Judge: is the reduced param set (model/prompt/tools/memory; description/
   credential) actually less overwhelming, and does "Advanced" feel
   discoverable but out of the way?
3. **Inline credential button** (U-1) — start a flow needing an unconnected
   credential. Judge: does the in-convo connect button feel natural mid-chat?
4. **Movable nodes / no "otherwise" labels** (U-3/U-4) — drag a node, look at
   a branching flow's edges. Judge: does the canvas feel less cluttered?

Already verified by the agent (do not re-check): every event fires, every
state persists across rebuild, no technical leakage (raw `*_CRED` names,
machine slugs) in any of the four surfaces above — F0.5 lens, event-proven.
