# Improvement Register — per-item, with Bubble Lab's current approach and the delta

Companion to `HANDOFF.md`. **IR = Improvement Requirement.**

Each entry: purpose → **what Bubble Lab does today** (the thing being upgraded) → the delta → what the
evidence says → verdict. Verdicts: **PORT** (verified, additive) · **SURGERY** (verified, but replaces a
load-bearing part of their runtime) · **RE-ANALYSE** (never proven — do not port on faith).

---

## Tier 1 — PORT NOW (verified, additive)

### IR-8 — Doc-grounded side-effect classifier
- **Purpose:** know whether an operation reads or writes, from the *documentation*, with a citation.
- **Bubble Lab today:** bubbles have **no read/write concept at all**. Nothing declares whether a tool mutates.
  There is no way to reason about safety before running.
- **Delta:** add `sideEffect` to bubble static metadata, derived from docs (MCP annotation > OpenAPI > prose),
  carrying `{confidence, source, citation}`. **Never classify from the HTTP method.**
- **Evidence:** **CONFIRMED** (19 tests). A POST that only reads → `read`. A GET that creates → `write`.
  Method is provably not the signal.
- **Verdict: PORT.** Effort LOW. **Prerequisite for the test-mode switch, IR-9/10, and IR-11.**

### IR-5 — Refresh-on-expiry + single-flight lock
- **Purpose:** stop pointless token churn and concurrent-refresh races.
- **Bubble Lab today:** `getValidToken` **refreshes on every single resolution** regardless of expiry, and
  there is **no distributed lock** — parallel instances race and rotate each other's refresh tokens.
- **Delta:** refresh only when actually expired (with a buffer); single-flight lock.
- **Evidence:** **CONFIRMED** — valid token → 0 refreshes; 10 concurrent resolves of an expired token →
  **exactly 1** refresh.
- **Verdict: PORT.** Effort LOW. Surgical, isolated, zero architectural risk. **Do this first** — it ships
  value immediately and proves the porting process.

### IR-6 / IR-7 — Proactive scope audit + honest fallback
- **Purpose:** fail *before* a run when a required scope was never granted.
- **Bubble Lab today:** scopes are enforced **reactively only**. Granted scopes are stored but display-only;
  you discover a missing scope when the provider rejects you mid-run.
- **Delta:** union each operation's `requiredScopes`, diff against granted, fail at build **naming the missing
  scope**. Where a provider exposes no scope metadata, say so honestly rather than fail silently.
- **Evidence:** **CONFIRMED** — ungranted scope fails the audit naming `chat:write`; metadata-less providers
  degrade with an explicit first-run message.
- **Verdict: PORT.** Effort LOW–MEDIUM. Needs per-op scopes declared.

### IR-9 / IR-10 — The Tester (probe-to-ground) + auto-run gate  ★ HIGHEST VALUE
- **Purpose:** ground contracts in *reality* instead of fiction, and catch documentation that lies.
- **Bubble Lab today:** **build never executes.** `get-bubble-details-tool` hands the code-generating LLM
  **synthesized fake values** from `MockDataGenerator`. Contract drift surfaces only when production explodes.
- **Delta:** insert a Tester between validate and run — **reads run for real** (recording the true response);
  **writes mock by default**; real writes only under an explicit per-operation grant.
- **Evidence:** **CONFIRMED, strongly** — 48/48 scenario cells, **0 production mutations in default mode**, and
  **4 operations whose docs said "read" were caught actually mutating state** and reclassified.
- **Verdict: PORT.** Effort MEDIUM. Needs IR-8 + a read-scoped credential mode. **This is the wall-breaker.**

### CG — Contract-first integration generation
- **Purpose:** stop hand-writing an integration per service.
- **Bubble Lab today:** every integration is **hand-written**, behind a **12-location registration checklist**,
  in monolithic files (`slack.ts` ≈ 124 KB). This is their **headcount ceiling**.
- **Delta:** generate the integration from the app's documentation. **Coexists** with hand-written bubbles —
  both register into the same factory, so adoption is incremental.
- **Evidence:** **CONFIRMED** — 0 network calls during generation; contract-derived schemas validated live
  responses **first-try**; **251 ms** from doc to live invocable tool.
- **Caveat:** today it requires **OpenAPI 3.x**. An agent-reads-prose-docs front end is **unbuilt**, and it is
  the true unlock for "wrap every business app."
- **Verdict: PORT.** Effort MEDIUM. Additive, no surgery.

---

## Tier 2 — SURGERY (verified, but replaces their core runtime)

### IR-11 / IR-12 — Self-healing Contract KB + anti-poison
- **Purpose:** contracts converge to reality; an API changing shape doesn't silently break every flow.
- **Bubble Lab today:** **nothing.** No learning from real responses, no contract memory. An API changes and
  the flow breaks forever, silently.
- **Delta:** ingest deviations keyed by their **existing call-site identity** (they already have it — see the
  retraction in HANDOFF §2); heal after **3 consistent observations** with an identical structural fingerprint;
  version with rollback. **Fully programmatic — no LLM anywhere in the heal path.**
- **Evidence:** **LAB ONLY.** Convergence and anti-poison both pass (it even **refused to learn from a mocked
  observation**). But in the reference build it was **blocked in production** by a bug: the drift error code
  collapsed to a generic failure at the wrapper boundary and **nothing consumed it**.
- **Verdict: SURGERY — and only after IR-9.** It has nothing to eat until reads are grounded.
  **Learning: preserve the drift code across the boundary, and give it a consumer.**

### IR-15 — Runtime-context injection, not source rewriting
- **Bubble Lab today:** `BubbleInjector` **rewrites the source text** of every bubble instantiation —
  line-splicing credentials in, tracking line shifts, re-reading params back out of the source. Their most
  fragile code.
- **Delta:** pass credentials and logging through a **runtime context object**. Delete the source rewriter.
- **Evidence:** **CONFIRMED** — step source byte-identical before/after a run; no `eval`, no `new Function`.
- **Verdict: SURGERY.** Effort HIGH — touches every bubble construction site.

### IR-16 — Sandboxed execution
- **Bubble Lab today:** writes LLM-generated code to a **temp `.ts` file**, regex-blocks `process.env`, then
  **`import()`s it**. A bypassable denylist guarding a live code-execution surface.
- **Delta:** execute in a worker/isolate with an **allowlist**. No temp file, no dynamic import of generated code.
- **Evidence:** **CONFIRMED** — `process.env` and disk unreachable except via allowlist.
- **Verdict: SURGERY.** Effort HIGH. **This is a genuine security fix, not a nicety.**

### IR-17 — Durable step execution + resume
- **Bubble Lab today:** `runStep` / `resumeFromStep` are **`@ts-expect-error` stubs** in open-core. Real
  durability lives only in their proprietary platform. A flow is all-or-nothing.
- **Delta:** implement real per-step state and resume. You are **filling a hole they left open**, not fighting
  their design.
- **Evidence:** **CONFIRMED** — interrupted flow resumes from the last completed step without re-running it.
- **Verdict: SURGERY (low-risk variant).** Effort MEDIUM–HIGH.

### IR-1 — Declarative AppSpec (kill the 12-location checklist)
- **Bubble Lab today:** adding one integration means editing **12 separate locations** — credential enum, env
  map, UI config, factory registration, exports, logo…
- **Delta:** a declarative spec + auto-discovery: drop one file, zero central edits. **Can run alongside their
  existing bubbles**, which makes it additive in practice.
- **Evidence:** **CONFIRMED** — 5 integrations discovered with zero central edits, zero network.
- **Verdict: SURGERY, but incrementally adoptable.** Effort HIGH.

---

## Tier 3 — RE-ANALYSE (never proven — do not port on faith)

### IR-14 — Browser observe-and-intervene
- **Bubble Lab today:** browser automation hidden inside a tool (BrowserBase). No supervision, no takeover, no
  DOM contract.
- **Delta:** supervised session with human takeover, captured as a replayable trace.
- **Evidence:** **BUILT BUT NEVER VALIDATED.** The only driver that ever existed is a **mock**. No real browser
  was ever driven.
- **Verdict: RE-ANALYSE.** See HANDOFF §7 (TinyFish-as-recorder + `agent-browser`-as-replayer).

### IR-2 — Author-ease / user-control levers
- **Bubble Lab today:** raw API keys and multi-part credentials; no per-op scope picker; no read/write dial.
- **Delta:** 7 author levers + 7 user levers.
- **Evidence:** **NO TEST WAS EVER WRITTEN.** The claim was never validated.
- **Verdict: RE-ANALYSE.** Re-derive from a real user need before building.

### IR-3 / IR-4 — Auth-method-per-app + resolver seam
- **Bubble Lab today:** **141 hand-maintained credential types**, plus two overlapping systems for the same app
  (`SLACK_CRED` OAuth vs `SLACK_API` token) that confuse users.
- **Delta:** one `AuthMethod` strategy per kind behind a single resolver seam; "OAuth or token" becomes two
  methods on one app, user's choice.
- **Evidence:** **seam CONFIRMED** (provider swap, zero upstream change) — but **only 3 of the 9 auth kinds were
  ever built**.
- **Verdict: PORT the seam; the remaining 6 kinds are unwritten work, not a port.**

---

## Summary

- **13 confirmed · 2 partial/untested · 1 built-but-unvalidated · 1 lab-only**
- **Retracted:** the AST-over-regex claim (they already have AST + call-site identity).
- **The gating dependency:** their build never executes. IR-9 breaks that wall; almost everything else waits
  behind it.
