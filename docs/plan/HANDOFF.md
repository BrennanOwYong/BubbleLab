# Handoff — Bolting the Verified Improvements onto Bubble Lab

**For the next session (Fable, Claude Code).** Everything below was verified against real code, not assumed.
Read this first, then `IMPROVEMENT-REGISTER.md` for the per-item detail.

---

## 0. Terminology

**IR = Improvement Requirement.** The source doc (`fable-build-reference.md` Part 2) never actually
expanded the acronym — it just numbered them IR-1…IR-17. We standardise on *Improvement Requirement*
from here.

---

## 1. Context change: we are no longer building from scratch

A clean-room implementation (`integration_stitcher`, 16 packages, 321 passing tests) was built to
*prove out* these improvements. **We are now grafting the verified ones onto Bubble Lab** (Apache-2.0,
so this is permitted; keep their copyright notices, mark changed files, don't use their marks).

`integration_stitcher` is now a **reference implementation + evidence base**, not the product. Every
improvement below has already been built and tested once — the code exists to copy the *design* from.

---

## 2. RETRACTION — do not build this

**The "AST beats regex" claim does not apply to Bubble Lab.**

Bubble Lab **already parses a real AST** (`@typescript-eslint/parser` in `BubbleParser`) and **already
assigns distinct per-call-site identity** (`hash("421:method#1")`, so one bubble used twice gets separate
identities for credentials, logs, and usage).

Our benchmark (AST F1 0.95 vs regex 0.34) compared our compiler against a *naive regex approach Bubble Lab
does not use*. It is a real result against a naive baseline; it is **not a delta over Bubble Lab**. The
teardown itself warned about this (§14.1: *"do not pitch 'we use the AST correctly' as the product edge"*).

**Do not spend time porting an identity layer they already have.** The real gap is that they never route
that identity to *observed reality* — see §3.

---

## 3. THE ONE WALL — everything valuable depends on breaking it

> **Bubble Lab's build never executes.**

Nothing in their pipeline calls a real API before run time. Grounding for their code-generating LLM comes
from `MockDataGenerator` — **synthesized fiction from the schema** (`"example string"`, `42`), see
`packages/bubble-shared-schemas/src/mock-data-generator.ts:44`.

Every genuinely valuable improvement (the Tester, contract grounding, the Contract KB, write-safety)
**requires the build to be able to execute a real read**. Break that wall once and most of the register
unlocks. Leave it and the additive features have nothing real to feed on.

---

## 4. HOW CREDENTIALS ACTUALLY WORK IN BUBBLE LAB (verified)

Three separate mechanisms — this matters for the test-mode design:

| Stage | What happens | Where |
|---|---|---|
| **Discover** (build) | `BubbleInjector.findCredentials()` works out which credential *types* each bubble needs. No secrets touched. | `bubble-runtime/src/injection` |
| **Inject** (run) | `BubbleInjector` **rewrites the source text**, splicing `credentials: { SLACK_CRED: 2 }` (a DB **id**, never a secret) into each `new XBubble({...})`. The real secret is resolved, decrypted, and embedded only at execution. | `BubbleInjector.injectCredentials()` |
| **Choose** (in-bubble) | Each bubble implements `protected abstract chooseCredential(): string \| undefined` to pick which injected credential to use. | `types/service-bubble-class.ts:27` |

**Critical finding — there is NO uniform "client" to swap.** Two incompatible patterns coexist:

- **SDK-client bubbles** — `resend.ts:375`: `this.resend = new Resend(apiKey)` (client built inside `performAction`).
- **Raw-fetch bubbles** — `github.ts`: **no client at all.** Bare `fetch()` calls, with `chooseCredential()`
  re-called *inside every single operation* (lines 834, 894, 955, 1017…).

So "swap the client for a mock" has **no single hook**, and would be per-bubble, per-auth-type work.
**Do not do that.** See §5.

---

## 5. ★ THE TEST-MODE DESIGN — cheaper than expected, and auth-agnostic

**Insight: intercept ABOVE `performAction`, not at the client.** Then no client is ever constructed, no
credential is ever used, no network call happens — and **auth type becomes irrelevant**.

The seam already exists. `BaseBubble.action()` (`types/base-bubble-class.ts:215`) is the single sealed
lifecycle every bubble flows through, and it **already short-circuits**:

```ts
// base-bubble-class.ts — EXISTING CODE
if (this.previousResult) {
  return savedResult;                       // ← returns WITHOUT calling performAction()
}
result = await this.performAction(this.context);   // line 247
```

Bubble Lab also **already ships mock generation on the base class**: `generateMockResult()` and
`generateMockResultWithSeed(seed)` (`base-bubble-class.ts:371`, `:379`).

### The change (small, one file, universal)

Add a `testMode` flag (on `BubbleContext`, so the runtime can set it per-run) and a `sideEffect` hint
(see IR-8), then in `action()`, **before** the `performAction` call:

```ts
if (this.context?.testMode && this.sideEffect === 'write') {
  return this.getRecordedMock() ?? this.generateMockResult();   // never touches the client
}
if (this.previousResult) { /* existing */ }
result = await this.performAction(this.context);
```

**Why this works across every bubble and every auth type:** it never reaches the code that builds a client
or reads a credential. `resend.ts` and `github.ts` behave identically because neither one runs.

### Read vs write (this is the point)

- **read-hinted + testMode** → **run for real** (probe-to-ground). Record the true response.
- **write-hinted + testMode** → **return a mock**, never call `performAction`.
- **write-hinted + explicit per-op user grant** ("dummy-data testing") → actually run the write, to catch
  cases where the docs are wrong.

### The upgrade over their existing mocks

`generateMockResult()` produces **fiction derived from the schema** — this is teardown complaint #19/#25,
and it's why their codegen LLM grounds on made-up values. Replace it (progressively) with **recorded real
responses** captured by the read-probe. `getRecordedMock()` is the new part; the interception seam is free.

### Requirements this creates
1. `sideEffect: 'read' | 'write' | 'read_with_side_effects'` on bubble static metadata → **IR-8**.
2. `testMode` on `BubbleContext` + threading it through the runner.
3. A store for recorded responses (the beginnings of the Contract KB → **IR-11**).

---

## 6. THE CODEGEN LLM MUST KNOW ABOUT TEST MODE

When the generation agent writes flow/stitching code it must be told, in the system prompt:
- which operations are `read` vs `write` (and that writes are mocked in test mode);
- that a mocked write returns a shape-valid result but **did not happen**;
- that it must not write flows whose correctness depends on a mocked write having taken effect.

This is a prompt/metadata change in the generation path (`bubbleflow-generation-prompts.ts`), not an
architectural one. Surface the `sideEffect` hint in the bubble catalogue the LLM reads.

---

## 7. BROWSER-BASED INTEGRATIONS — the TinyFish "record once, replay forever" idea

**The idea (owner's):** let TinyFish perform the action **once**, and have it report the exact HTML it
clicked/interacted with. Treat that captured DOM as a **pseudo-API contract**. Thereafter, replay
deterministically against that contract.

**Assessment: this is the right shape, and it maps exactly onto the DOM-contract work already validated.**

- It puts the expensive, non-deterministic agent **at authoring time only** — not in the run path. That
  preserves the core principle (*keep the LLM out of the execution path*) and keeps per-run cost at ~zero.
- The captured selectors/structure become the **DOM contract**; a later run that no longer satisfies it is
  **drift**, detected rather than silently misread. (Validated: DOM drift is flagged, not silent.)
- TinyFish bills **per agent step** (~$0.015), which would be ruinous on every cron fire — but it is
  perfectly priced as a **one-time recorder** and as a **healer** when drift is detected.
- Recommended split: **`agent-browser` (free, Apache-2.0, deterministic, accessibility-tree snapshots) as
  the replay driver; TinyFish as the recorder/healer.**

**Feasibility caveat (must verify before committing):** confirm TinyFish's API actually returns the
interacted-with element/DOM (selector + surrounding structure), not just the extracted data. If it only
returns results, the contract must be captured from the page snapshot ourselves.

**Status: KIV.** No real browser driver exists anywhere yet — the only driver ever built was a **mock**.
This is unproven work; do not schedule it before the API-side wins.

---

## 8. WHAT TO BUILD, IN ORDER

1. **IR-5 — refresh-on-expiry + single-flight lock.** Cheapest, isolated, zero architectural risk.
   *(Today `getValidToken` refreshes on **every** resolution, with no lock → token churn + races.)*
2. **IR-8 — doc-grounded `sideEffect` metadata.** Small, additive, and the **prerequisite for everything below.**
   *(Today bubbles have **no read/write concept at all**.)*
3. **★ Test-mode switch (§5).** Small, universal, unlocks safe testing of every tool.
4. **IR-9/10 — the Tester (break the wall).** Reads run for real and ground the contract; writes stay mocked.
   **Highest value item in this document.**
5. **IR-6/7 — proactive scope audit.** Cheap once operations declare scopes.
6. **Contract-first integration generation.** Attacks their headcount ceiling; coexists with hand-written bubbles.
7. **IR-11/12 — Contract KB.** Only after step 4 (it has nothing to eat until reads are grounded).
8. **IR-16 → IR-15 → IR-17** — sandbox, context-injection, durable resume. Deep surgery; do last, deliberately.
9. **Re-analyse** IR-14 (browser), IR-2 (never tested), and the 6 unbuilt auth kinds. Do not port unproven work.

---

## 9. EVIDENCE BASE (from the reference implementation)

| Claim | Result |
|---|---|
| Docs are enough to build an integration (no live probing) | **0 network calls**; contract validated live responses **first-try**; **251 ms** doc→live tool |
| Docs lie about read/write | **4 operations whose docs said "read" were caught mutating state** and reclassified |
| Write safety | **48/48 scenario cells**; **0 production mutations in default mode** |
| Anti-poisoning | one anomaly never mutates a contract (3 consistent observations required); it even **refused to learn from a mocked observation** |
| Durable resume | interrupted flow resumes from last completed step |
| Contract KB | **works in lab only** — blocked in production by a drift-code bug (see below) |

**Known bug to avoid repeating:** in the reference build, the drift signal (`OUTPUT_MISMATCH`) was thrown by
the adapter but **collapsed into a generic `PERFORM_FAILED`** at the wrapper boundary, and **nothing consumed
it** — so the KB could only learn from test runs, never from production traffic. **Preserve the drift code
across the boundary and give it a consumer.**

---

## 10. KIV (keep in view)

- **Browser-based integrations** — TinyFish-as-recorder + `agent-browser`-as-replayer (§7). Unproven.
- **LLM agent connections** — wiring agents as first-class nodes, and letting an agent author the flow
  end-to-end (a natural-language prompt → runnable workflow generator **does not exist anywhere yet** —
  it is a genuine build, not a wiring job).
- **Agent-reads-prose-docs front end** — contract generation currently requires OpenAPI 3.x. Many business
  apps ship no spec. An agent that reads prose docs and emits the machine-readable contract is unbuilt, and
  it is the true unlock for "wrap every popular business app."
