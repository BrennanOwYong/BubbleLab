# Fable 5 Build Reference — Central Guide

Single source of truth for the Fable 5 build agent. **Part 1** = design-principle wisdom to *keep*
(extracted from the BubbleLab main project). **Part 2** = the build checklist (what to build), parsed
from the owner's differentiation spiel. Deep mechanics + provenance live in
`bubblelab-architecture-teardown.md` (§ references below point there).

---

## Part 1 — Design-principle wisdom (KEEP these; they are the foundation)

- **W1 — One base contract, one call shape.** `new X(params).run()`. Author implements only
  `perform()` + declares schemas; the sealed lifecycle (validate-in → perform → validate-out → wrap)
  is inherited. *Why:* uniformity is what makes the whole system machine-legible and one-shot-generatable.
- **W2 — Keep the LLM out of the execution path.** Compile NL → typed code once; run deterministically;
  the model never re-decides per run. *Why:* determinism = reliability. (teardown §6.1)
- **W3 — Static analyzability.** Every external call has the identical shape, so a static pass can
  find / credential / instrument / validate it **without executing**. *Why:* safe build-time reasoning
  + injection. (§6.2, §4)
- **W4 — Two-sided typed schemas.** Zod input validated at construct, Zod output validated at return.
  *Why:* the compiler/validator is the correctness oracle the generation loop iterates against. (§6.3)
- **W5 — Credentials as opaque refs; secret resolved at runtime only.** Flow code carries IDs, never
  secrets. *Why:* safe to store/version, LLM never sees secrets, migration-proof. (§11.2, §11.7)
- **W6 — Adapter hidden in `perform()`.** API / SDK / MCP / browser is invisible above the wrapper;
  normalized params ↔ native call mapped in exactly one place. *Why:* heterogeneity absorbed, façade
  uniform. (§12.2 P3)
- **W7 — Agent-as-a-capability dial.** The LLM is just another capability; deterministic ↔ agentic
  interleave per node. *Rule:* use agency only where determinism runs out. (§ wisdom, §12.2)
- **W8 — Declare, don't wire + auto-discovery registration.** Capabilities declare metadata (name,
  input/output Zod, description, `sideEffect`, `requiredScopes`); the framework derives discovery,
  validation, injection, scope-audit; drop-a-file registration. *Why:* author ease; kills the
  12-location checklist. (§12.2 P2/P4)
- **W9 — Enforce iteration with a gate, not a guideline.** Generation cannot exit until static
  validation passes — the validator is the only exit. *Why:* forces self-correction. (§6.6)
- **W10 — Layer count tracks *consumers*, not integration types.** The consumers are: deterministic
  code, the LLM agent, the static pipeline. Browser vs API vs MCP is one wrapper. (§ rule of thumb)

---

## Part 2 — Build checklist (WHAT to build; owner's improvements)

Each item: `[ ]` to check off, an **AC** (acceptance criterion = done-definition), and a teardown ref.

### A. Native integration access point (self-owned; NO Composio)
- [ ] **IR-1 — `AppSpec` / `Operation` model.** One capability = declared input/output Zod +
  `requiredScopes` + doc-grounded `sideEffect` + a native `adapter()`. **AC:** a new integration is
  added by authoring/generating one `AppSpec` file, auto-discovered, no central registry edit. (§13.1, §12.2)
- [ ] **IR-2 — Author-ease + max user-control.** Wrapping is easiest-possible for the dev (declare,
  don't wire); user gets granular control (per-op scope pick, per-node credential override, read/write
  mode, dummy-data opt-in, contract-deviation policy). **AC:** the 7 author + 7 user levers (§12.2) exist. 

### B. Auth (per-app methods behind one seam)
- [ ] **IR-3 — Auth-method-per-app.** `AuthMethod` strategy per kind: `oauth2`, `oauth2_jwt`,
  `api_key`, `pat`, `basic`, `connection_string`, `multi_field`, `browser_session`, `xoauth2`. One app
  may offer several; user picks. **AC:** each strategy owns collect/test/applyToRequest/refresh and the
  Connect UI renders from `collect()`. (§13.2)
- [ ] **IR-4 — Credential resolver seam.** `id`-in-code, secret-at-runtime; `resolve(ref, mode)` with
  `mode: 'read' | 'write'` = explorer-grant vs runtime-grant split. **AC:** capabilities import only the
  ref + resolver interface; provider swap = new resolver impl, nothing upstream changes. (§11.7, §9.3)
- [ ] **IR-5 — Refresh-on-expiry + rotation.** Refresh with a buffer (NOT refresh-always); persist
  rotated refresh tokens; distributed lock for multi-instance. **AC:** no refresh when token valid; no
  concurrent-refresh race. (fixes §12.1 #7/#8)
- [ ] **IR-6 — Proactive scope audit.** Union each op's `requiredScopes`, diff vs granted scopes at
  build; block / prompt re-consent BEFORE run. **AC:** a flow needing an ungranted scope fails the build
  with a named scope, not a runtime error. (§11.5)
- [ ] **IR-7 — Credential scope test w/ honest fallback.** On connect, test the credential carries the
  needed scopes **if** the provider exposes scope metadata; if not, discover on first real run and tell
  the user plainly *"could not be known beforehand — no scope metadata."* **AC:** both paths implemented;
  no silent scope failure. (§12.3)

### C. Doc-grounded side-effects + test/run modes
- [ ] **IR-8 — Doc-grounded `sideEffect` classifier (provenance-carrying).** Source hierarchy: MCP
  annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`) > OpenAPI (method + prose) > doc-NLP >
  manual. Never method-only. Each classification carries `confidence`, `source`, `citation`.
  **Definition (binding):** an op is **write-hinted** if the docs say it **creates a new record — even
  as a side effect**; otherwise it is **read-hinted** (self-explanatory). **AC:** every op's read/write
  hint is derived from a cited source, not hand-typed, using this definition. (§13.3)
- [ ] **IR-9 — The Tester: run individual functions for real to catch docs-are-wrong (deviation check).**
  Two modes per feature (`test` / `run`); execution policy is set by the hint:
  - [ ] **Read-hinted → run for real in BOTH modes** (probe-to-ground). **AC:** reads ground the build
    with true responses; deviation vs the known contract is detected.
  - [ ] **Write-hinted, default → mock** the input/output contracts (no prod mutation) + run deviance
    detection against the mocked call. **AC:** zero prod writes in this default path.
  - [ ] **Write-hinted, "Dummy-data testing" (named, user-permitted) →** actually invoke the write op to
    **create dummy records**, specifically to catch cases where the docs are wrong; user grants explicit
    permission and owns cleanup. **AC:** never runs without explicit per-op user permission; produces a
    real contract observation; results feed the KB. (§12.3)
- [ ] **IR-10 — "Auto-run in test" gate.** `read && !destructive && confidence ≥ threshold &&
  authoritative source`; everything else → mock path (or Dummy-data testing only with permission).
  Runtime verification downgrades a "read" to `read_with_side_effects` if a state change is detected.
  **AC:** a doc-said-read that actually creates/mutates is caught and reclassified. (§13.3)

### D. Contract knowledge base (the learning loop Bubble lacks)
- [ ] **IR-11 — Self-healing per-integration contract KB.** Any detected deviation of the input OR
  output contract immediately updates the per-integration KB; the KB is the validator's source of truth.
  **AC:** loose/guessed schemas converge to ground truth from real traffic. (§12.3)
- [ ] **IR-12 — Anti-poison + versioning.** A single anomalous response must not rewrite a contract;
  gate KB updates behind N-consistent-observations + version contracts (diff/rollback). **AC:** one 500
  never mutates the KB. (§12.3 watch-out)
- [ ] **IR-13 — Web/DOM contract.** For browser actions, "contract" = required HTML environment
  (selectors/structure); deviation = page changed; same detect → KB-update loop. **AC:** DOM drift is
  detected and recorded, not silently failed. (§12.3, §13.3)

### E. Differentiators (things Bubble structurally lacks)
- [ ] **IR-14 — Browser observe-and-intervene.** Stream the live browser session; human can watch,
  pause, interrupt, advise, take over, and demonstrate; capture the demonstration as a replayable trace
  that tightens the capability + feeds the contract KB. **AC:** supervised mode with takeover + trace capture. (§10)

### F. Non-optimalities to AVOID (Bubble's mistakes — do the opposite)
- [ ] **IR-15 — Runtime-context injection, not source-string rewriting.** Pass creds/logging via a
  runtime context object (or AST transform), never splice generated code. **AC:** no line-shift string
  manipulation of generated flows. (fixes §12.1 #1)
- [ ] **IR-16 — Sandboxed execution, not temp-file + dynamic import.** Run in a worker/isolate/vm with
  an allowlist, not a `process.env` regex denylist. **AC:** no temp `.ts` + `import()` exec path. (fixes §12.1 #2/#3)
- [ ] **IR-17 — Durable step execution/resume.** Implement real step state + resume (not stubs). **AC:**
  a flow can resume from a step; partial runs exist. (fixes §12.1 #4)

---

### How to present progress (for the Fable agent)
Treat each `IR-#` as a build item. Report status per item using the owner's factory states:
`BACKLOG → READY → IN_PROGRESS → NEEDS_VALIDATION → BUILT → DONE`. An item is **DONE** only when its
**AC** passes independent (fresh-context, different-model) adversarial validation against a running
artifact. Keep this checklist as the live scoreboard; check `[x]` only at DONE.
