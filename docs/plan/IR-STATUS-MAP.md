# Project Roadmap & Status — BubbleLab integration engine

_Canonical source of truth. Lives on `main`. Updated on every merge with an after-action report (AAR)._
_Last updated: 2026-07-16._

This is the one place the roadmap lives. If something about status, review order, or decisions is not
written here, it does not count. Do not hold it in your head.

---

## 1. Where main stands

- **main = `d79b6ca`.** Three PRs merged, nothing else. Your in-depth review hold is intact.
- **Merged:** PR #1 repo-map (patch plan), PR #2 IR-8 side-effect metadata + a 59-operation backfill,
  PR #3 test-mode switch.
- **All branches with real work are now on remote** (`github.com/BrennanOwYong/BubbleLab`). The only
  local-only branch is `improve/contract-first-generation`, and it is empty (0 commits).

---

## 2. Review & merge queue — the order to work through the branches

Nothing merges until you approve each one. Order rationale: planning docs land first (a feature's plan
must be on main before the feature), then features in dependency order, with the one-shot demo reviewed
last because it showcases the rest. Each merge is a SQUASH (one commit per branch) and must append an AAR
to §6 below.

| #   | Branch                              | What it delivers                                                  | Commits / size               | Status                                                                                               |
| --- | ----------------------------------- | ----------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| P1  | _this doc_                          | the roadmap on main                                               | —                            | **landing now**                                                                                      |
| P2  | `plan/per-ir-docs`                  | 15 per-IR design docs (the IR reference set)                      | 1 commit                     | ready to review                                                                                      |
| P3  | `plan/add-app-feature`              | ADD-ANY-APP codegen pipeline + backfill method                    | 1 commit                     | ready; partly superseded by the Hot-load registry doc (§4, to write)                                 |
| 1   | `improve/auth-methods-from-docs`    | IR-3/4 auth derived from each app's docs                          | 5 commits, +2,387            | ready                                                                                                |
| 2   | `improve/ir6-scope-audit`           | IR-6/7 proactive scope audit                                      | 3 commits, +1,448            | ready                                                                                                |
| 3   | `improve/run-grounding-and-signoff` | IR-9/10 first-run grounding + sign-off gate                       | 5 commits, +2,262            | ready                                                                                                |
| 4   | `improve/ir5-refresh-on-expiry`     | IR-5 credential refresh-on-expiry + lock                          | 2 commits, +426 / **−3,691** | ⚠ INSPECT FIRST — large deletions suggest it branched before IR-8; likely needs rebase before merge |
| 5   | `improve/contract-kb-and-drift-fix` | IR-11/12 self-healing Contract KB + drift-signal fix (the moat)   | 7 commits, +3,095            | ready; largest                                                                                       |
| 6   | `improve/stitch-generator`          | one-shot prompt→workflow + static Zod param validator (your demo) | 4 commits, +1,101            | ready; review last                                                                                   |
| —   | `improve/contract-first-generation` | agentic add-a-tool                                                | **0 commits — EMPTY**        | never built; rebuild against the Hot-load registry design (§4), not the codemod path                 |

---

## 3. Decisions locked

1. **Build ON BubbleLab, not from scratch** (Apache-2.0). `integration_stitcher` is the evidence base only.
2. **All LLM use goes through OpenAI for now.** Provider dispatch is already generic (`ai-agent.ts` splits
   the model slug and routes `openai/*` → `ChatOpenAI` directly). Switching = swap the hardcoded `google/*`
   model literals in the generation path to `openai/*` + set `OPENAI_API_KEY` (done). Not a rewrite.
3. **Two-phase execution:** authoring on mock contracts (no calls, no creds); the first real run does
   grounding; a sign-off gate blocks write-hinted operations until the requester approves.
4. **Telemetry is a hard requirement:** distinct machine-branchable error codes; no blanket catch flattens a
   typed error; every code has a consumer; failures carry call-site identity.
5. **The moat = the Contract KB fed by real production traffic.** An accumulated record of what APIs
   actually do (and where their docs lie) does not commoditise as models improve.

## KIVs (keep-in-view, deferred, not rejected)

- **KIV-A — one LLM normalization layer** (OpenRouter or similar) so any high-quality model is selectable,
  including Chinese models. GLM (`openrouter/z-ai/glm-4.6/4.7`) and Kimi (`fireworks/.../kimi-k2p6`) are
  already in the `AvailableModels` enum and the OpenRouter dispatch path exists; the KIV is consolidating
  onto it plus a picker.
- **KIV-B — connectable agent step:** let people drive the agent step with their own agent setup, not only
  the internal LLM node. Recorded, not planned.
- **KIV — browser-based integrations:** recorder (TinyFish) + deterministic replayer (agent-browser).
- **KIV — permissive parsing / param-Venn error UX.**

---

## 4. Known gap — the Hot-load tool registry doc (to write)

Adding a tool without rebuilding the app is its own improvement area and has **no design doc yet**. It is
distinct from what exists: `ADD-ANY-APP.md` generates tool _source_ (and its registration step still edits
12 files and assumes a rebuild), and IR-16 is _execution sandboxing_ (a security boundary). The missing
piece is the runtime: a separate build service compiles a tool into an artifact, records it in a DB
registry, and the live app dynamically imports it with no rebuild and no service interruption. It composes
the others: IR-1 AppSpec is the registry record shape, ADD-ANY-APP is the producer, IR-16 is the safety
boundary. This doc must be written before `improve/contract-first-generation` is rebuilt.

---

## 5. What is testable right now

- **Base BubbleLab + merged deltas (IR-8, test-mode switch):** runnable from the installed main checkout
  with a DB and an LLM key. Tests the baseline, not your deltas.
- **One-shot workflow creator (your delta):** built on `improve/stitch-generator`, being wired to run on
  your OpenAI key. Blocker resolved this session: fresh `/mnt/c` worktrees fail `pnpm install`
  (`ERR_PNPM_EACCES`), so branch code runs from the installed main tree instead.
- **Agentic add-a-tool:** not built (empty branch). Needs the §4 doc, then a build.

---

## 6. Governance + after-action reports

Rule: a feature's plan lands on main first; it branches from main; builds + tests; SQUASH-merges to main
(one commit per feature); the merge appends an AAR here. No AAR ⇒ merge incomplete.

- **PR #1 · plan/repo-map** — file-level patch plan + build commands landed on main.
- **PR #2 · IR-8 side-effect metadata** — bubbles carry a doc-grounded read/write hint
  `{source, citation, confidence}`; 59-operation backfill across 6 bubbles. Prerequisite for Tester + KB.
- **PR #3 · test-mode switch** — a `testMode` flag on the run context; write-hinted operations return a
  mock above `performAction`, so no client is constructed and no credential is read. Reads still run.

---

## 7. Verification log

- **2026-07-16 · one-shot generator on OpenAI (branch `improve/stitch-generator`, commit `04d8faf`, pushed,
  NOT merged).** Wired generation to OpenAI (primary `openai/gpt-5.2`, summarize `openai/gpt-5-mini`; Boba
  precondition now requires only `OPENAI_API_KEY`; OpenRouter confirmed unused for generation). Ran
  `demo-one-shot.ts` end to end on the user's key:
  - Stage 1 (capability catalogue) PASS.
  - Stage 2 (bad literal rejected at compile, 0 network) PASS — the static param validator delta works.
  - Stage 3 (test-mode mocked write → `{"sent":true,"mocked":true}`, 0 network) PASS.
  - Stage 4a (real prompt → validated BubbleFlow code, 16 agent iterations on gpt-5.2) PASS.
  - Stage 4b (impossible prompt must fail loudly) DID NOT hold: gpt-5.2 reinterpreted the infeasible
    request into a valid flow instead of refusing (Gemini refused; gpt-5.2 substitutes a feasible reading).
    Model-behavior gap, not a wiring fault. See FU-1.
  - Reproduce: checkout `improve/stitch-generator` in the main tree, then
    `cd apps/bubblelab-api && ~/.bun/bin/bun run scripts/demo-one-shot.ts` (Linux bun by absolute path).

## Follow-ups (open)

- **FU-1 — infeasible-prompt refusal.** Add an instruction to `SYSTEM_PROMPT_BASE`
  (`bubbleflow-generator.workflow.ts:161`) to fail with an error when a requested capability has no bubble,
  instead of reinterpreting it into a feasible flow. Surfaced because gpt-5.2 is more eager than Gemini.
- **FU-2 — generated flows still default to Google.** Generated flows embed
  `google/gemini-2.5-flash-lite` in their own `AIAgentBubble` params (from the boilerplate / generation
  prompts), so a generated flow still needs Google credentials at flow runtime. Extend the all-LLM-via-OpenAI
  decision (§3.2) into the boilerplate so generated flows default to `openai/*`.
- **Note — main dist is branch-built.** The gitignored `packages/bubble-runtime/dist` in the main checkout
  was rebuilt from branch source during verification (includes the param validator). Rebuild on main before
  trusting main-only runtime behavior.
