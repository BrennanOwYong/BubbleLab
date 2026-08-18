# Wrapping Composio in BubbleLab: implementation guide

Companion to `COMPOSIO-VS-BUBBLELAB-ADVISORY.md`. The advisory answers whether to do this. This
answers how, and it is written as contracts and seams rather than as a step-by-step recipe, so the
executing agent keeps room to course-correct.

Nothing here has been built. Every code reference points at existing BubbleLab or Gluu source read
during the research spike, and every Composio behaviour cited was measured live on 2026-08-01.

---

## 0. The invariant this whole design protects

> A generated flow never contains a credential, and the set of connections a flow actually used is
> recorded from execution rather than inferred from source.

Everything below serves that sentence. The current system violates both halves: credentials get
written into the source by `BubbleInjector.injectCredentials`
(`packages/bubble-runtime/src/injection/BubbleInjector.ts:447`), and the credential checklist is
derived from static parsing that silently misses nested tools and unrecognised call sites
(`packages/bubble-runtime/src/extraction/BubbleParser.ts:1384-1394`).

---

## 1. Architecture: where the seam sits

```
   agent-written flow (TypeScript)
            |
   [ BubbleLab: parser, type system, canvas, provenance ]     <- stays yours
            |
   generated Composio bubble family        existing hand-written bubbles
            |                                        |
   [ Composio: vault + transport ]          direct vendor calls
            |                                        |
      1,069 SaaS toolkits              postgres, s3, redshift, bigquery,
                                       insforge, agi-inc, and 11 others
```

Three rules that fall out of the measurements:

1. **Composio never becomes the agent-facing interface.** A single Notion tool schema is a median
   19 KB. Exposing raw tool slugs to the model costs 5,000 tokens per tool and abandons the
   operation-shaped facade that makes bubbles legible.
2. **The data plane never migrates.** 13 of your 53 integrations have no Composio equivalent, and
   the residue is a category rather than a backlog: databases, warehouses, object storage, private
   services. Those bubbles are permanent.
3. **Hybrid is the steady state, not a transition.** Flows will mix generated Composio bubbles with
   hand-written ones. The AST injector keeps running for the second group, so its failure modes
   persist until (and unless) those bubbles migrate. Plan for coexistence rather than cutover.

---

## 2. Phase 0: prove the thesis before building the machine

Do not start the codegen pipeline until these four answers exist. Full detail in advisory §8.

| # | Question | Pass condition | Kills the thesis if |
|---|---|---|---|
| 1 | Does generated typing survive live payloads? | `OutputSchema.parse` succeeds on three real Notion tool results | Schemas describe a shape the API does not return |
| 2 | Is the vendor pin stable? | An append-block call with `after` succeeds against a live workspace | Composio sends a newer version header with older field names |
| 3 | What does the hop cost? | Under 300 ms added latency on a write | Interactive flows become sluggish |
| 4 | Does the provenance join work? | "This flow used these connections" renders from runtime rows alone | `logId` or `connectedAccountId` is absent or unreliable |

Question 2 exists because §3.9 predicts a pass and the prediction rests on inference from schema
shape rather than on observing the wire. Confirm it rather than trusting it.

---

## 3. Phase 1: the codegen pipeline

### 3.1 What it consumes

`GET /api/v3/tools?toolkit_slug=<slug>&toolkit_versions=<pin>`. Always pass the version parameter.
Raw v3 defaults to the frozen base snapshot `00000000_00`, which for Notion means 28 tools with no
data-source support. The SDK defaults to `latest` and hand-rolled HTTP does not.

Per tool the response carries `slug`, `name`, `description`, `input_parameters`,
`output_parameters`, `is_deprecated`, `tags`, `scopes`, `version`.

### 3.2 What it emits

For each selected tool, at a pinned toolkit version:

- a Zod schema for `input_parameters`
- a Zod schema for `output_parameters`, resolving `$defs` and `$ref` (100% of sampled latest tools
  use them)
- TypeScript types inferred from both
- one entry in a generated manifest: tool slug, toolkit, pinned version, human name, description,
  behavioural tags, source schema hash

The manifest is what Phase 3 and Phase 4 read. Treat it as the build artifact, not the code.

### 3.3 Rules the generator enforces

- **Reject `is_deprecated: true` at generation time.** Do not emit a wrapper and do not warn. A
  model with older training data will reach for `SLACK_CHAT_POST_MESSAGE`, and the call succeeds,
  which is exactly why it has to fail earlier.
- **Pin the version in the generated artifact.** A version bump is a code change: regenerate, diff
  the types, let the compiler point at every flow that breaks.
- **Fail the build on a schema hash change under an unchanged pin.** Composio rebuilds toolkits
  without changing the surface contract, and you want to know when that assumption breaks.
- **Curate before generating.** Do not emit 871 GitHub wrappers. The `important` tag (39 of 56
  Notion tools, 28 of 100 Slack) is a reasonable first filter, and human selection beats it.

### 3.4 The boundary parse, which is the whole point

`ToolExecuteResponse.data` is declared `Record<string, unknown>` in `@composio/core`. Consuming it
raw is where `as any` would enter the codebase and violate your standing rule. The wrapper parses:

```
execute -> { data: unknown, error, successful, logId }
        -> OutputSchema.parse(data)
        -> typed result, or a loud parse failure naming the tool and pinned version
```

A parse failure is a signal worth surfacing rather than swallowing: it means Composio's published
schema and Composio's actual response disagree, which is the one failure mode no amount of desk
research can predict.

### 3.5 How the generated family registers

Existing bubbles register through `BubbleFactory.register(name, class)`
(`packages/bubble-core/src/bubble-factory.ts:93`, defaults at `:511` onward). A generated family
needs the same treatment, and this forces one design decision worth making deliberately:

**Decision: one bubble per toolkit, or one bubble per tool?**

Per toolkit matches the existing model (`notion` bubble with an `operation` discriminated union,
the pattern used by all 53 integrations) and keeps agent-facing schemas small. Per tool matches
Composio's granularity and generates more simply. The advisory's reasoning favours per toolkit,
since operation-shaped facades are the product. Confirm it against the `BubbleName` union, which is
a closed string union in `packages/bubble-shared-schemas/src/types.ts` and will need a generation
step of its own either way.

---

## 4. Phase 2: bridging the credential model

### 4.1 What changes

Today a step binds to a secret, and `BubbleInjector` writes that secret into the source. Under
Composio a step binds to a `connectedAccountId`, and nothing is written into the source at all.

`ToolExecuteParams` accepts an optional `connectedAccountId`, so per-step binding survives intact.
Your credential-pool code exists because one user can hold several accounts for one provider, and
that maps onto pinning the account per step rather than resolving by `userId` alone.

### 4.2 What stays

`CredentialType` (68 members), per-step binding semantics, the Setup tab, the pool concept. The
model is sound. The storage and refresh layer underneath it is what Composio replaces.

### 4.3 The `userId` mapping decision

Composio keys connections by `userId`. Resolve this before writing code, since it decides whether
the wrapper passes `userId` alone or pins `connectedAccountId` per step. Your existing per-step
model points at the second. Getting it wrong means either users cannot pick which account a step
uses, or every step carries an account id it does not need.

### 4.4 One requirement that survives regardless of platform

**A missing credential must fail loudly, at the earliest possible point.** Composio surfaces a
missing connected account as `successful: false` at execution, which is late. A pre-flight check
that lists connected accounts for the flow's toolkits before the first call closes that gap. Both
current BubbleLab failures (unrecognised call site, nested tool) are silent, and silence is the
actual defect rather than the mechanism that produced it.

---

## 5. Phase 3: provenance, and why it is runtime-first

### 5.1 The two sources, and their standing

| Source | Produces | Standing |
|---|---|---|
| Static AST pass at save time | Predicted tool list, credential checklist before the first run | **Predicted.** Never authoritative |
| Execution wrapper, per call | Actual tool slug, connected account, log id, outcome | **Authoritative** |

Static analysis resolves a Composio call by reading a string literal off a call expression, which
needs no call-site whitelist and therefore handles ternaries, `.map()` bodies and nested tools that
the current injector cannot. A working prototype at `ast-detector/` scores 14/14 on realistic
patterns, 5/5 adversarial, 3/3 negative controls (advisory §5.4). Start from it rather than from
scratch.

Four implementation notes carried from building it:

- **The hard part is client binding, not call-site context.** Handle `new Composio()`, factory
  returns, `const { tools } = composio`, and `this.composio` as a class field. Each was a miss in
  the first version.
- **Bind a loop variable to exactly the array it iterates.** The first version attributed every
  const string array in scope, so an unused slug array produced phantom tools. A checklist listing
  connections the flow never uses is worse than no checklist.
- **Gate the relaxed tier on the import.** Accepting any `<receiver>.tools.execute(...)` once the
  file imports `@composio/core` recovers bindings the strict tier cannot trace, with no measured
  false positives.
- **Emit typed unresolved records.** Dynamic slugs (`execute(slug, ...)`, `'SLACK_' + verb`) and
  toolkit filters (`tools.get(u, { toolkits: ['slack'] })`) cannot resolve, and both must produce a
  record with kind, line and expression text. Silence is the current injector's actual defect; a
  flow that cannot be statically resolved should say so on the canvas.

### 5.2 Shape

```
flow_tool_usage          flow_id, tool_slug, toolkit_slug, source('static'|'runtime'),
                         first_seen, last_seen
flow_connection_usage    flow_id, connected_account_id, toolkit_slug, user_id, last_used_at
execution_tool_call      execution_id, flow_id, tool_slug, connected_account_id,
                         composio_log_id, successful, duration_ms, called_at
```

`execution_tool_call` is written by the wrapper on every call. The other two are projections.

### 5.3 Reconciliation is a feature, not cleanup

After each run, compare runtime rows against the static prediction. A runtime slug with no static
row means the agent used a tool the flow never declared. Surface that rather than hiding it. It is
the single most useful thing this table can tell a user, and the current system cannot produce it
at all.

---

## 6. Phase 4: the non-technical view

Each platform holds exactly the half the other lacks, so the render is an assembly rather than a
build.

| Element | Source | Coverage measured |
|---|---|---|
| Node order, edges, nesting, branches | BubbleLab `dependencyGraph`, `dependencies`, `invocationCallSiteKey`, line numbers | Composio has none |
| Node label in prose | Composio tool `name` | 209/209, zero slug-like |
| Node subtitle | Composio `description` | 209/209 |
| Icon | Composio toolkit `meta.logo` | 1,069/1,069 |
| Grouping | Composio toolkit `meta.categories` | 1,069/1,069, 88 categories |
| Risk badge | Composio `destructiveHint` tag | 13 Slack tools, 6 Notion, 8 Sheets |
| Safe badge | Composio `readOnlyHint` tag | 56 of 100 Slack tools |

```
[drive logo] Create a document            (creates)
     |
[notion logo] Query data source           (read-only)
     |
[slack logo] Send message to #sales       (creates, external)
```

Two rules:

- **Render from reconciled Phase 3 data**, not from the static pass alone, so agent-chosen tools
  appear rather than vanish.
- **Treat `destructiveHint` as a first-class UI signal**, not a tag. It is the one field that lets
  a non-technical reviewer spot the step that deletes something, and no hand-authored bubble
  currently carries an equivalent.

One field will not cooperate. `scopes` is inconsistent across toolkits: Notion returns human labels
on 18 of 56 tools, Slack returns scope strings on 93 of 100, Google Sheets returns raw API URLs on
53 of 53. Rendering "what this step is allowed to do" needs your own mapping table, so budget for
it or drop the feature.

---

## 7. Per-toolkit adoption gate

Before any toolkit joins the generated family, answer three questions. §3.9 explains why the first
one carries most of the weight.

1. **Does the vendor version its API?** Notion (indefinite support) and GitHub (24-month floor)
   need no ongoing vigilance. Slack and Google retire methods globally, so those need the vendor's
   changelog on a watch list plus one live call per tool before shipping.
2. **Is managed auth available?** 122 of 1,069 toolkits have a Composio-hosted OAuth app. For the
   rest the user brings their own app or key, which is the same burden your bubbles already impose.
   45 toolkits are OAuth-only with no managed app and no key fallback, including `xero`, `twitter`,
   `docusign` and `snowflake`.
3. **Does the depth justify the swap?** Ratios run from 1x (`telegram`, 13 ops against 18 tools) to
   26x (`docusign`, 13 against 335). Swapping a 1x integration buys nothing and costs a hop, a
   billing event and a dependency.

---

## 8. What not to build

- **Do not widen the AST call-site whitelist for Composio calls.** Reading a literal needs no
  whitelist. The whitelist exists because the injector rewrites arguments, and the generated family
  removes the reason to rewrite anything.
- **Do not build a picker around discovered auth schemes.** `auth_schemes` under-reports (github
  accepts BEARER_TOKEN while advertising OAUTH2 only), and chasing it is low value since github has
  managed OAuth and users reach for OAuth anyway.
- **Do not trust catalog metadata for counts or freshness.** The same toolkit reports three
  different tool counts, and `meta.version` tracks Composio's rebuild rather than the vendor's API.
  Execute to verify.
- **Do not migrate the data-plane bubbles.** There is nothing to migrate them to.

---

## 9. Open decisions, ranked by how much they constrain what follows

1. **Bubble granularity: per toolkit or per tool** (§3.5). Decides the shape of everything
   generated, and the `BubbleName` union has to change either way.
2. **`userId` versus `connectedAccountId` binding** (§4.3). Decides whether per-step account
   selection survives.
3. **Where generated code lives.** A new package, or generated files inside `bubble-core`. Affects
   the build graph and whether regeneration can be a routine operation.
4. **Whether Gluu and BubbleLab share one Composio integration** or maintain two. Gluu runs 0.10.0
   against a 0.14.1 current, so this is already a live maintenance question rather than a new one.
5. **Whether the data path is acceptable.** Every payload transits Composio, self-hosting is
   Enterprise-only. Commercial rather than technical, and it will surface in a customer's first
   security review.

---

## 10. Verification per phase

Following your standing rule that the builder runs everything with an objective pass or fail, and
the human judges only what needs taste:

| Phase | Builder verifies | Human judges |
|---|---|---|
| 0 Pilot | All four questions in §2, live, against a real connected account | Whether the latency number is acceptable |
| 1 Codegen | Generated Zod parses live payloads for every emitted tool; build fails on deprecated slugs and on schema-hash drift | Which tools make the curated set |
| 2 Credentials | A step bound to a specific `connectedAccountId` reaches that account; a missing credential throws before business logic runs | Whether the Setup tab still reads clearly |
| 3 Provenance | Runtime rows written for every call including agent-chosen tools; reconciliation flags an undeclared tool | Whether the surfaced discrepancy is understandable |
| 4 Visual | Every node renders a label, icon and risk badge from the manifest; graph edges match the parsed dependency graph | Whether a non-technical person can read the flow without help |

---

## References

- Advisory and all measurements: `COMPOSIO-VS-BUBBLELAB-ADVISORY.md`, machine-readable asks matrix
  at `asks-matrix.json`, probes at `probes/`
- Composio toolkit versioning: https://docs.composio.dev/docs/tools-direct/toolkit-versioning
- Composio connected accounts: https://docs.composio.dev/docs/auth-configuration/connected-accounts
- Composio custom auth configs: https://docs.composio.dev/docs/custom-auth-configs
- Composio rate limits: https://docs.composio.dev/reference/rate-limits
- BubbleLab seams referenced above, all in `/home/unix/bubblelab-suite`:
  `packages/bubble-runtime/src/injection/BubbleInjector.ts:447`,
  `packages/bubble-runtime/src/extraction/BubbleParser.ts:1384-1394`,
  `packages/bubble-core/src/bubble-factory.ts:93`,
  `packages/bubble-core/src/types/service-bubble-class.ts` (`chooseCredential`),
  `packages/bubble-shared-schemas/src/types.ts` (`CredentialType`, `BubbleName`)

