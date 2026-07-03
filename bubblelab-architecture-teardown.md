# Bubble Lab — Architecture Teardown & Build Guide

> Purpose: a complete map of how Bubble Lab's open-core works, the reasoning behind each
> decision, and how to re-create the valuable parts with **Composio as the native integration
> access point** plus your own wrapper + compiler + tester.
>
> **Provenance discipline** (read this first):
> - ✅ **VERIFIED** = read directly in the `BubbleLab` repo.
> - 🏢 **PLATFORM** = referenced by docs but lives in the proprietary platform, not open-core.
> - 🧪 **YOURS** = a design recommendation for *your* build; NOT a Bubble Lab feature.
>   (rollback, idempotency keys, dry-run, read-only explorer credentials, probe-to-ground,
>   brain-backed schema hardening all fall here.)

---

## 1. Entities (technical)

| Entity | File (repo) | Kind | One-line role |
|---|---|---|---|
| `BaseBubble<TParams,TResult>` | `bubble-core/src/types/base-bubble-class.ts` | abstract class | The shape. Validates input in ctor, seals the `action()` lifecycle, validates output, masks creds. |
| `ServiceBubble` | `…/types/service-bubble-class.ts` | abstract (extends Base) | Wraps ONE external system (API **or** browser). Adds `chooseCredential()`, `testCredential()`. |
| `ToolBubble` | `…/types/tool-bubble-class.ts` | abstract (extends Base) | A capability an **LLM agent** can call. `toolAgent()` projects it into a LangGraph tool. |
| `WorkflowBubble` | `…/types/workflow-bubble-class.ts` | abstract (extends Base) | A reusable multi-step composition packaged as a single bubble. |
| `AIAgentBubble` | `…/service-bubble/ai-agent.ts` | ServiceBubble | The LLM, as a bubble. Has `tools` + `customTools` (other bubbles). Makes agency a per-node dial. |
| `BubbleFlow<Trigger>` | `…/bubble-flow/bubble-flow-class.ts` | abstract class (NOT a bubble) | Deployable, trigger-bound entry point. Has `handle(payload)`. The unit that gets parsed/run. |
| `BubbleFactory` | `…/bubble-factory.ts` | registry | Central registry; dynamic-imports + registers all bubbles; `listBubblesForCodeGenerator()`. |
| `BubbleScript` | `bubble-runtime/src/parse/BubbleScript.ts` | parser facade | Holds source + parsed bubbles + workflow tree + trigger + input schema. |
| `BubbleParser` | `…/extraction/BubbleParser.ts` | AST walker | Finds `new XBubble(...)`, builds dependency graph, clones per-invocation. |
| `BubbleInjector` | `…/injection/BubbleInjector.ts` | source rewriter | Injects credentials + logging + dep-graph by rewriting the source AST. |
| `validateAndExtract` | `…/validation/index.ts` | function (BUILD) | Static gate: syntax + structure + registered-bubble + lint + extraction. Never executes. |
| `BubbleRunner` | `…/runtime/BubbleRunner.ts` | executor (RUN) | Rewrites→temp file→sanitize→dynamic import→`handle()`. Real creds, real calls. |
| `get-bubble-details-tool` | `…/tool-bubble/get-bubble-details-tool.ts` | ToolBubble | Returns a bubble's schema + **synthesized** usage example (NOT a live call). |
| `bubbleflow-validation-tool` | `…/tool-bubble/bubbleflow-validation-tool.ts` | ToolBubble | Wraps `validateAndExtract` for the agent's self-correction loop. |
| `BubbleFlowGeneratorWorkflow` / Pearl | `bubblelab-api/src/services/ai/bubbleflow-generator.workflow.ts` | WorkflowBubble | The generation agent (own LLM) with a forced validate-until-clean loop. |
| `CredentialValidator` | `bubblelab-api/src/services/credential-validator.ts` | service | On credential add: instantiate bubble + `testCredential()` to verify key/scopes. |
| `MockDataGenerator` | `bubble-shared-schemas/src/mock-data-generator.ts` | util | Builds fake results from a result schema (testing; schema-derived, not live). |
| credential registry | `bubble-shared-schemas/src/credential-schema.ts` | config | ~141 credential types, `OAUTH_PROVIDERS`, `BUBBLE_CREDENTIAL_OPTIONS`. |

Two more `type` values exist on `BaseBubble` (`'ui'`, `'infra'`) — minor; not central.

## 2. Entities (conceptual / non-technical roles)

- **The shape** (BaseBubble): a contract that makes every external action *self-describing,
  self-validating, credential-isolated, and uniform at the call site*.
- **The leaf vs the composite**: Service = atomic capability; Tool = agent-facing capability
  (may compose services); Workflow = frozen multi-step pattern; Flow = deployable.
- **The two consumers that justify >1 layer**: deterministic code, and an LLM agent. (A third,
  the static pipeline, consumes the *shape* itself.)
- **The dial**: `AIAgentBubble`-as-a-bubble turns "deterministic vs agentic" into a per-node
  choice instead of an architectural wall. Governing rule (from the generation prompt):
  *"If deterministic tool calls and branch logic are possible, there is no need to use AI agent."*

## 3. Relationships

```
BaseBubble
 ├── ServiceBubble ──── AIAgentBubble (the LLM is just a service bubble)
 │                       ├── tools:        [registered ToolBubbles, by name]
 │                       └── customTools:  [inline funcs that instantiate OTHER bubbles]
 ├── ToolBubble  ──── (may compose ServiceBubbles inside performAction, e.g. AmazonShoppingTool→BrowserBase+Storage)
 └── WorkflowBubble ── (orchestrates Services/Tools)

BubbleFlow<Trigger>  (NOT a bubble)
 └── handle(payload) { ... instantiates bubbles ... }   ← the artifact that gets parsed & run

BubbleFactory  registers every bubble  →  used by parser, validator, generator, runner
```

Pipeline relationship (the spine):

```
NL prompt
  │  (LLM, own model — Pearl / generator)
  ▼
TypeScript code (a string)
  │  validateAndExtract  ← BUILD  (static; BubbleScript→BubbleParser, lint, structure)
  ▼
{ valid, errors, bubbleParameters, dependencyGraph, requiredCredentials, trigger, inputSchema }
  │  BubbleInjector       ← rewrites source: credentials + logging + dep-graph literal
  ▼
executable script (temp .ts)
  │  BubbleRunner.runAll  ← RUN  (sanitize → dynamic import → handle(payload))
  ▼
ExecutionResult + logs
```

## 4. The execution pipeline, verified stage by stage

`Code → Validate → Extract → Inject → Execute → Output`

1. **Code** — LLM emits a `BubbleFlow` subclass. One class per file; clean `handle()` orchestrator.
2. **Validate** (`validateBubbleFlow`) — basic syntax (`validateScript`); structural regex
   (`extends BubbleFlow`, has `handle`, exported); **only registered bubbles** allowed; lint rules
   via `ts.createSourceFile`. No execution.
3. **Extract** (`BubbleScript`/`BubbleParser`) — walk AST, find every `new XBubble(...)`, build the
   **dependency graph**, assign `variableId`s, **clone per call-site** (`hash("421:method#1")`) so
   the same bubble used twice gets distinct identity for creds/logs/usage. Pull out `inputSchema`,
   `trigger`, `requiredCredentials`/`optionalCredentials`.
4. **Inject** (`BubbleInjector`) — rewrite the source so each `new XBubble({...})` becomes
   `new XBubble({..., credentials:{...}}, {logger, variableId, dependencyGraph, ...})`. Nested
   bubbles inside `customTools` are rewritten bottom-up first, then parents refreshed. A frozen
   `__bubbleInvocationDependencyGraphs` map is injected for per-invocation lookups.
5. **Execute** (`BubbleRunner.runAll`) — write to temp `.ts`, `sanitizeScript` (block `process.env`),
   dynamic `import()`, find the flow class, `handle(payload)`. 🏢 Inngest/Temporal, state-storage,
   step-resume are PLATFORM — open-core `runStep`/`resumeFromStep` are stubs.
6. **Output** — `action()` validates each bubble's result against `resultSchema`, wraps in
   `{success, data, error, executionId, timestamp}`; logger captures the trace.

## 5. Build vs Run — the hard separation (precise)

| | BUILD | RUN |
|---|---|---|
| Module | `validation/validateAndExtract` | `runtime/BubbleRunner.runAll` |
| Executes bubbles? | **Never** (read or write) | **Yes**, all of them |
| External calls? | None | Real |
| Credentials | Only *discovered* (`findCredentials`) | Real values injected into source |
| Failure mode | Compile/lint/extract errors | Runtime exceptions, typed errors |
| LLM in loop? | Yes (generation) — but model never calls the API | No |

> Consequence: there is **no partial execution, no dry-run, no per-op write gating** in open-core.
> A flow is inert until `runAll`, then it runs whole. (This is exactly the gap 🧪 your
> probe-to-ground + read-only-explorer-credential design would fill.)

## 6. The wisdom (design principles, each tied to a mechanism)

1. **Keep the LLM out of the execution path.** Reasoning is non-deterministic; compiled code isn't.
   → *Mechanism:* generation freezes NL into typed TS once; `BubbleRunner` re-runs the code, never the model.
2. **Uniform call shape = machine-legibility.** Every action is `new X({...}).action()`.
   → *Mechanism:* `BubbleParser` can find/credential/clone/instrument every call by AST rewrite,
   without running anything. (Heterogeneous SDK calls would be unparseable.)
3. **Type the contract on both sides.** Zod input validated in ctor; Zod output validated in `action()`.
   → *Mechanism:* errors surface at instantiation/return, and the compiler is a correctness oracle the
   generation loop can iterate against.
4. **Make agency a dial, not a wall.** `AIAgentBubble extends ServiceBubble`.
   → *Mechanism:* deterministic ↔ agentic interleave per node; agent's `customTools` are bubbles too.
5. **Credentials are structural, never textual to the model.** `chooseCredential()` + `toJSON()` omits params.
   → *Mechanism:* injected at runtime by source rewrite, masked in logs; the LLM never sees secrets.
6. **Enforce iteration with a gate, not a guideline.** The generator can't return until validation passes.
   → *Mechanism:* `createWorkflow`/`editWorkflow` are the *only* exit, both route through `validateAndExtract`.
7. **Breadth is in-house, standardized in shape.** Each integration = a `ServiceBubble` subclass +
   credential entry + OAuth config.
   → *Trade:* per-operation type-safety & reliability, capped by headcount. (This is the seam you
   replace with Composio.)

## 7. Problem → solution mapping (each niche problem → feature/decision)

| Problem | Feature / architectural decision |
|---|---|
| LLM codegen is non-deterministic | Freeze NL→typed TS once; validate-until-clean gate; model absent at run |
| Runtime drift (agent re-decides each run) | Compiled deterministic flow; re-expose finished flow as ONE MCP tool |
| Integrations are hard / inconsistent to call | Uniform `ServiceBubble` shape + discriminated-union operations + `.describe()` everywhere |
| Agent must understand a tool before using it | `get-bubble-details-tool` returns schema + synthesized example (no live call) |
| Don't disrupt prod during R&D | Build never executes anything; execution is a separate, explicit RUN stage |
| Secrets leaking to model/logs | `chooseCredential()`, runtime source-injection, `toJSON()` omission, log masking |
| Same bubble used in many places, tangled logs/creds | Per-invocation cloning with hashed `variableId` + `uniqueId@callSite` |
| External apps with no API | Browser actuation hidden *inside* a ToolBubble (`AmazonShoppingTool`→`BrowserBaseBubble`); session-cookie credential type |
| Reliability of one operation | Two-sided Zod validation (input ctor + output `action()`); typed errors |
| Credential actually works / has scopes | `CredentialValidator.testCredential()` on credential add (separate from build) |
| Webhook/cron/event triggers | `BubbleFlow<'webhook/http' | 'schedule/cron' | …>` parameterizes `handle()` payload |
| Observability/audit | `BubbleLogger` per `variableId`; execution summary; result wrapping |

## 8. What Bubble Lab does NOT have (so you don't assume it)

- ❌ Company Brain / persistent permission-aware knowledge graph (only conversation `agent-memory` + traces). **Your moat.**
- ❌ Rollback / DB transactions around writes.
- ❌ Idempotency keys.
- ❌ Dry-run / per-operation write gating / partial execution.
- ❌ Step-resume / durable step state in open-core (🏢 platform only).
- ❌ Live probing of tools during build to ground generation (they use schema + synthetic examples).

## 9. Recreating it with Composio as the integration access point

> ⛔ **SUPERSEDED — Composio is rejected.** The build spec is **§12** (Composio-free). The Composio
> references in this section are retained only as the *rejected option*; disregard any pro attributed
> to it. Integration access in the real design is native/self-owned per §12.

You replace **principle #7** (hand-built service bubbles) with Composio, and keep the rest.

### 9.1 Layers to build
1. **Wrapper (the shape).** One `Capability` base class = your `BaseBubble`.
   - Static: `name`, `inputSchema` (Zod), `outputSchema` (Zod), `description`, `sideEffect: 'read'|'write'`.
   - Sealed lifecycle: `run()` → validate input → `perform()` → validate output → wrap result.
   - `perform()` body calls **Composio** for programmatic tools, or a browser driver for browser tools.
     Browser-vs-API stays hidden here (Bubble's lesson).
   - **Auto-generate** these from Composio tool schemas for breadth; **hand-tighten** the high-value ones.
2. **Compiler (build).** `validateAndExtract` equivalent:
   - Parse the candidate flow (TS or your DSL) to an AST; confirm only-registered-capabilities;
     extract a dependency graph; discover required credentials; type-check against the Zod schemas.
   - Never execute. This is the agent's iteration gate.
3. **Tester (the part Bubble under-builds — your edge).**
   - **Probe-to-ground:** during build, auto-execute **`read` capabilities only**, using a
     **read-only-scoped credential**, to capture real responses and *tighten the output schema*
     (turn Composio's loose schemas into ground-truth ones). 🧪
   - **Write safety:** for `write` capabilities, never hit prod at build — synthesize from schema,
     route to dry-run/sandbox, or DB transaction+ROLLBACK. 🧪
   - **Freeze:** once explored, freeze the tightened schema; runtime executes deterministically
     against the frozen contract (Bubble's determinism + your ground truth).
4. **Runner (run).** Inject real (write-scoped, approval-gated) credentials, execute the frozen flow.
   Add idempotency keys + audit here. 🧪

### 9.2 Where Composio changes the tradeoffs
- ✅ Breadth fast; auth lifecycle managed.
- ⚠️ You inherit Composio's **schema fidelity ceiling** → the Tester's probe-to-ground is what
  neutralizes it. Without it you've imported their weakest point.
- ⚠️ Composio in the **runtime path** = a dependency you don't control; for determinism-critical
  capabilities, consider calling the API directly at run time using the schema you already froze.

### 9.3 Dial + brain (your differentiators)
- Make `Agent` a capability (like `AIAgentBubble`) so deterministic/agentic interleaves per node.
- Feed probe responses + execution traces into the **Company Brain** so schema-hardening compounds
  per customer-month — a flywheel Bubble structurally lacks.

### 9.4 Minimum viable build order
1. `Capability` base (shape) + Zod two-sided validation.
2. Composio-schema → `Capability` auto-generator.
3. Compiler (static parse + extract + type-check) as the agent's gate.
4. Tester: read-only probe-to-ground + schema freeze.
5. Runner with write-scoped creds + idempotency + audit.
6. Add the `Agent` capability and brain-backed hardening last, once a second consumer exists.

> Rule of thumb (Bubble's real lesson): **layer count should track the number of distinct
> *consumers* of the artifact (deterministic code, LLM agent, static pipeline), not the number of
> integration types.** Browser vs API vs MCP is one wrapper, hidden inside `perform()`.

---

## 10. KIV — future features (Keep In View)

### 10.1 Live observe-and-intervene for browser-based tools 🧪
**Idea:** when a browser capability runs (especially during the Tester's exploration phase), stream
the live browser session to a human who can **watch, pause, interrupt, advise, or demonstrate** the
correct path — then capture that demonstration as a reusable artifact.

**Why it fits here:** browser tools are the least deterministic actuation mode (no typed API contract,
DOM drift, auth/session fragility). They're exactly where schema/probe grounding is weakest and where
a human's "do it this way" is highest-value. API tools rarely need this; browser tools do.

**Design sketch (when built):**
- **Stream:** expose the CDP/cloud-browser live view (Browserbase-style) over a websocket to a UI.
- **Pause points:** capability declares interruptible checkpoints (before a write/checkout/submit);
  runner blocks on a human ACK when "supervised mode" is on.
- **Takeover handoff:** human grabs control of the same session, performs the step manually, returns
  control — session/cookies continue uninterrupted.
- **Demonstration capture:** record the human's actions (selectors clicked, values entered, nav path)
  as a **trace**; replay it deterministically next time, and/or feed it to tighten the capability's
  steps + output schema (the browser analogue of probe-to-ground).
- **Advice channel:** human annotations attach to the trace ("prefer this selector", "this modal
  appears intermittently") and surface to the agent on the next generation pass.
- **Brain tie-in:** store traces + annotations per site in the Company Brain so browser know-how
  compounds per customer-month — the long-tail-SaaS knowledge Bubble structurally can't accumulate.

**Prereqs / dependencies:** the supervised-mode flag + interruptible checkpoints belong in the
**Runner**; the trace-capture + replay belongs in the **Tester**; both need the `sideEffect` tag and
the dual-credential model already noted in §9.3. Defer until the non-browser pipeline is solid.

---

## 11. Auth / credential subsystem (the part you own when you leave Composio)

### 11.1 Three credential "modes" and how they differ
| Mode | When | Secrets touched? | External call? | Mechanism |
|---|---|---|---|---|
| **Discover** (validate/build) | generation, save | No | No | `BubbleInjector.findCredentials()` → which credential *types* each bubble needs → `requiredCredentials`/`optionalCredentials` manifest. Drives "connect Slack" UI. |
| **Test** (onboarding) | when a user adds a credential | Yes (one) | Yes (one canned call) | `CredentialValidator.validateCredential()` → instantiate bubble w/ `createTestParameters()` → `setParam('credentials')` → `testCredential()`. Confirms the key works; DB bubbles also `getCredentialMetadata()`. |
| **Inject** (run) | execution | Yes (all) | Yes (real) | `CredentialHelper.getUserCredentials()` resolves IDs→decrypt→(OAuth refresh)→ `BubbleInjector.injectCredentials()` rewrites source w/ real secrets. |

### 11.2 Key invariant: code holds credential **IDs**, never secrets
Generated/stored flow code contains `credentials: { SLACK_CRED: 2 }` (a DB id). The real token is
resolved only at run-time injection, decrypted + refreshed, embedded into the temp file, and masked
in logs via `toJSON()`. → flow code is safe to store/version; secret lifetime = the execution.

### 11.3 OAuth lifecycle (`oauth-service.ts`)
- **initiate** — make `state` (CSRF, 10-min in-memory TTL), request `defaultScopes` + provider
  `authorizationParams` (Google `access_type=offline`+`prompt=consent`; FUB non-standard `response_type`).
- **callback** — validate state, exchange code→token (FUB manual; Jira also fetches `cloudId`),
  encrypt tokens (AES via `CredentialEncryption`), store w/ `oauthScopes`.
- **getValidToken** — **always refreshes** when a refresh token exists (freshest token; a refresh per resolution).
- **refresh / revoke** — decrypt refresh→exchange→update; revoke is best-effort (mostly not implemented) + DB delete.
- Encodings: Jira = base64(token+cloudId); browser session = base64(contextId+cookies); API-key creds = plain decrypt.

### 11.4 System vs user credentials
- `SYSTEM_CREDENTIALS` — auto-injected from env (AI model keys, default Resend); invisible in UI; work out of the box.
- User credentials — encrypted per-user, OAuth or API key, surfaced in UI, mapped per bubble var.
- `OPTIONAL_CREDENTIALS` — marks creds not strictly required.

### 11.5 Scope handling — REQUEST-time + REACTIVE (the gap)
- Scopes requested broadly at connect via `OAUTH_PROVIDERS[provider].credentialTypes[type].defaultScopes`
  (+ `adminScopes`/`userScopes` where relevant). Granted scopes stored in `oauthScopes` (display only).
- **No pre-flight check** that the granted scopes cover the operations the specific automation uses.
- Enforced **reactively**: bubble calls API → provider returns `missing_scope`/`not_allowed_token_type`
  → bubble surfaces a friendly "requires X scope, reconnect to grant" error (see slack.ts).
- 🧪 **Your improvement:** at Extract time you have every operation in the flow; have each capability
  declare `requiredScopes`, union them per credential, diff against the credential's stored granted
  scopes, and fail the build / prompt re-consent BEFORE running. Proactive scope audit Bubble lacks.

### 11.6 What you must build to replace Composio's auth
1. Registered OAuth apps per provider (client_id/secret) + `OAUTH_PROVIDERS`-style config (scopes, auth params, quirks).
2. State/callback/exchange/refresh/encrypt/revoke lifecycle + encrypted per-user/per-type credential store.
3. The ID-in-code / secret-at-runtime injection pattern.
4. The three modes (discover / test / inject).
5. (Edge) proactive scope audit (§11.5) — do better than Bubble here.
6. (Edge) the read-only "explorer" grant vs write-scoped "runtime" grant split from §9.3.

### 11.7 The resolver seam (migration-proof credential access) 🧪
**Goal:** flow code and capabilities depend on a credential **ID + scope intent**, never on *how* the
secret is obtained. Composio satisfies the seam today; your own OAuth service satisfies it later.
Swapping providers = swapping one resolver, not touching any flow code or capability.

```ts
// ---- Stable contract everything upstream depends on -------------------------
type CredentialId = string;          // opaque; stored in flow code (NOT the secret)
type Scope = string;

interface CredentialRef {            // what a capability/flow holds
  id: CredentialId;
  type: string;                      // 'SLACK', 'GOOGLE_SHEETS', ...
  requiredScopes: Scope[];           // declared per operation; unioned per flow
}

interface ResolvedCredential {
  secret: string;                    // bearer token / api key / base64 session blob
  grantedScopes: Scope[];
  expiresAt?: Date;
  metadata?: Record<string, unknown>; // e.g. Jira cloudId, R2 account, region
}

interface CredentialResolver {
  // RUN: id -> live secret (decrypt + refresh handled inside the impl)
  resolve(ref: CredentialRef, mode: 'read' | 'write'): Promise<ResolvedCredential>;
  // BUILD: proactive scope audit (§11.5) without fetching the secret
  grantedScopes(id: CredentialId): Promise<Scope[]>;
  // ONBOARD: did the user connect this, and does the key work?
  test(id: CredentialId): Promise<{ ok: boolean; error?: string }>;
}

// ---- Day 1: Composio behind the seam ---------------------------------------
class ComposioResolver implements CredentialResolver { /* calls Composio API */ }

// ---- Later: your own stack behind the SAME seam ----------------------------
class NativeOAuthResolver implements CredentialResolver { /* oauth-service + encrypted store */ }
```

**How the modes map onto it (mirrors §11.1):**
- *Discover/build*: never calls `resolve`; uses `grantedScopes()` for the proactive scope audit.
- *Onboard*: `test()`.
- *Run*: `resolve(ref, mode)` — and the `mode` arg is where the read-only-explorer vs write-scoped
  grant split (§9.3) lives: `'read'` returns a read-scoped token for probe-to-ground, `'write'`
  returns the approval-gated write token.

**Rules to keep the seam clean:**
1. Capabilities import only `CredentialRef` + the resolver interface — never Composio or your DB.
2. Injection asks the resolver at run time; flow code only ever carries `id`. (Bubble's invariant, §11.2.)
3. New providers/migrations implement `CredentialResolver`; nothing upstream recompiles.
4. The scope audit and the read/write split are interface-level, so they survive the Composio→native swap.

---

## 12. BUILD SPEC — non-optimalities, extracted principles, improvement layer (Composio-free)

> This section supersedes §9/§11's Composio framing. Integration access is **native/self-owned**.
> Legend: ✅ verified in repo · ⚠️ inferred from code · 🧪 your addition.

### 12.1 Full catalog of where Bubble Lab is NOT optimal

**A. Runtime & execution**
1. ✅ Credential/logging injection by **rewriting source strings** (`BubbleInjector` line-splice + shift tracking + re-reading params from source). Fragile. → pass secrets via a runtime **context object**, or transform via a real AST tool (ts-morph), never string-splice generated code.
2. ✅ Execution = write temp `.ts` → `sanitizeScript` **regex-blocks `process.env`** → dynamic `import()` → delete. Brittle denylist security + FS churn. → sandbox (worker/isolate/vm) with an allowlist, not a temp file.
3. ✅ Dynamic `import()` of **LLM-generated code** is a code-exec surface; the sanitizer is a bypassable denylist.
4. ✅ Step execution/resume **unimplemented** (`runStep`/`resumeFromStep` are `@ts-expect-error` stubs; `currentStep`/`savedStates` dead) → no durability/partial runs in open-core.
5. ✅ **All-or-nothing** execution; no partial/dry-run/per-op gating.
6. ✅ Per-invocation clone machinery (hash `variableId` + frozen global dep-graph map injected into code) is intricate. → a runtime context stack is simpler.

**B. Credentials & auth**
7. ✅ `getValidToken` **refreshes on every resolution** regardless of expiry → latency + refresh-token rotation churn. → refresh-on-expiry with a buffer.
8. ⚠️ **No distributed lock** on refresh → concurrent-refresh races across instances.
9. ✅ **Reactive-only scope** enforcement; granted scopes stored (`oauthScopes`) but display-only; no pre-flight audit.
10. ✅ **Reactive-only re-auth**; dead refresh-token discovered only at runtime failure.
11. ✅ `revokeCredential` best-effort/no-op (provider revocation unimplemented).
12. ✅ Credential validator uses **hand-maintained canned test params** per type (`createTestParameters` switch) — must be updated per credential.
13. ✅ **Two overlapping credential systems** (`SLACK_CRED` OAuth vs `SLACK_API` token) — user confusion.
14. ✅ **141 hand-maintained credential types** + per-provider `OAUTH_PROVIDERS` quirks — registry sprawl.
15. ✅ Jira "use first accessible site" **TODO** — multi-site unhandled.

**C. Integration authoring**
16. ✅ **12-location registration checklist** per new integration — high friction, documented failure modes.
17. ✅ **Monolithic single-file bubbles** (`slack.ts` ≈ 124 KB).
18. ✅ Manual per-service adapter + discriminated union — the **headcount ceiling**.
19. ✅ `get-bubble-details-tool` synthesizes **fake example values** (`"example string"`, `42`) → the LLM grounds on fiction, not real shapes.
20. ✅ **No probe-to-ground**; build never executes; grounding is schema + synthetic only.

**D. Contracts, testing, reliability**
21. ✅ **No output-contract ground-truthing** → schema drift found only at runtime.
22. ✅ **No contract knowledge base**; no learning from real responses (only conversation `agent-memory`).
23. ✅ `resultSchema.parse` then wraps the whole result incl. `operation`; strip-fields IIFE is hacky.
24. ✅ **No rollback / transaction / idempotency** for writes → unsafe repeated/failed writes.
25. ✅ No mock-vs-real distinction for writes at build (they simply never run).

**E. Product / UX**
26. ✅ Raw API-key / connection-string / **multi-part creds** (R2 = 3 credentials) not non-technical-friendly.
27. ✅ No **proactive** "this automation needs scope X you didn't grant" before a run.

### 12.2 Extracted design principles — wrap any app for MAX author-ease + MAX user-control

**Author-ergonomics (easiest to write):**
- **P1 — One base contract, one call shape.** `new X(params).run()`. The author implements only `perform()` + declares schemas; the sealed lifecycle (validate-in → perform → validate-out → wrap) is inherited.
- **P2 — Declare, don't wire.** Static metadata = `name`, input Zod, output Zod, `description`, `sideEffect: 'read'|'write'`, `requiredScopes`. The framework *derives* discovery, validation, injection, and scope-audit from declarations — the author writes none of that plumbing.
- **P3 — Adapter hidden in `perform()`.** API/SDK/MCP/browser is invisible above the wrapper; the author maps normalized params ↔ native call in exactly one place.
- **P4 — Registration by auto-discovery, not a checklist.** Drop a capability file → it's registered (filesystem/decorator registry). No 12-location edit.
- **P5 — Small modules, not monoliths.** One operation (or a few) per file.
- **P6 — Two-sided typed schemas.** Input validated at construct, output validated at return; the compiler + validator are the author's correctness oracle.
- **P7 — Credentials as opaque refs.** The author never touches secrets/storage — just declares credential `type` + `requiredScopes`; resolution is the framework's job.

**User granular-control (as much as possible):**
- **U1 — Per-operation scope intent + per-connection scope picker** (checkboxes, plain-language descriptions, sensible defaults pre-ticked; user narrows/broadens up front).
- **U2 — Per-node credential override** (bring your own account/key per step).
- **U3 — Read/Write mode dial** per feature (test vs run — see §12.3).
- **U4 — Opt-in dummy-data** for writes during test.
- **U5 — Contract-deviation policy** the user picks: notify / block / auto-learn.
- **U6 — Approval gates on writes; supervised mode for browser** (§10).
- **U7 — Visibility before run**: which scopes, which side effects, which contract each step depends on.

### 12.3 🧪 Improvement layer (sits ATOP the §12.2 principles)

**Credential handling**
- On connect/add, **test that the credential carries the scopes the automation needs — IF the provider exposes scope metadata.** Union the `requiredScopes` of every operation in the flow, diff against granted scopes, block/prompt re-consent before run.
- **If no scope metadata exists** (many API keys have no introspection), skip the pre-flight — the mismatch is only discoverable on the **first real run**, and at that point tell the user plainly: *"this could not be known beforehand; the provider exposes no scope metadata."* Honest, not a silent failure.
- Otherwise credentials are resolved + injected **at runtime only** (opaque-ref → live secret; §11.2 invariant kept).

**Two modes per integration feature: `test` and `run`**
- **Read-hinted tools → run for real in BOTH modes.** Reads ground the build with true responses (probe-to-ground).
- **Write-hinted tools →** default to **mocked input & output contracts** (no prod mutation); **deviance detection** runs the same way as the credential/scope check — validate the *would-be* call + the mocked response against the known contract.
  - **User opt-in:** allow write-hinted tools to **create dummy data** for real (user's explicit choice; user owns cleanup/consequences).
- The read/write hint is declared per operation (`sideEffect`); the mode is a per-run dial (U3).

**Contract knowledge base (the learning loop — Bubble has nothing here)**
- **Any detected deviation of the input OR output contract** (real response shape ≠ known contract) **immediately updates the per-integration contract KB.** The KB is the source of truth the validator checks against, and it *self-heals* from real traffic — turning loose/guessed schemas into ground truth over time. This is the flywheel §8/§11 said Bubble structurally lacks.
- **For web (browser) actions**, "contract" = the **required HTML/DOM environment** (expected selectors, page structure, required elements). Deviation = the page changed under the automation; same detect → KB-update loop, feeding the supervised-takeover/demonstration capture in §10.

**Watch-outs (so the spec is robust, not just clean):**
- 🧪 *Read ≠ always safe.* Some "read" ops have side effects (mark-as-read, audit logs, metered cost, rate limits). Treat the hint as a default, allow a per-op "not truly safe read" flag that requires confirmation.
- 🧪 *Dummy data is still a real write.* Opt-in dummy-data mutates the real system — pair it with a teardown/cleanup step or a sandbox tenant, and label it loudly in the UI.
- 🧪 *Don't let one anomaly poison the KB.* A single malformed/error response shouldn't rewrite the contract. Gate KB updates behind a confirmation threshold (N consistent observations) and **version** contracts so you can diff/roll back.
- 🧪 *Scope metadata coverage is uneven.* Build the pre-flight audit as best-effort per provider; the first-run-discovery fallback (with honest messaging) is the correct default where metadata is absent.

**One-line thesis:** keep Bubble's wisdom (uniform typed leaf, LLM-out-of-run-path, static analyzability, creds-as-refs), fix its non-optimalities (§12.1), and add the two things it never had — **real grounding (read-probe + write-mock with deviance detection)** and a **self-healing per-integration contract KB** — with the read/write hint and the contract policy exposed to the user as first-class dials.
