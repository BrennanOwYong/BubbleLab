# ADD-A-TOOL WORKFLOW — the pipeline as steps with explicit logic gates

This document describes the entire add-a-tool pipeline: every step, the decision gates inside
each step, and the rule the pipeline applies at each gate. It is grounded in real code, and it
labels each piece with its status:

- **BUILT** = implemented on branch `improve/add-a-tool-mvp` (`packages/bubble-appgen/` plus the
  generated `packages/bubble-core/src/bubbles/service-bubble/snowflake-sql-api/`), verified by
  the commands recorded in commit `974593b`.
- **DESIGNED** = specified in `docs/plan/ADD-ANY-APP.md` (branch `plan/add-app-feature`) but not
  implemented.
- **UNBUILT** = acknowledged gap with no design doc yet (the Hot-load registry,
  `docs/plan/IR-STATUS-MAP.md` §4).

Companion docs: `ADD-ANY-APP.md` (the S1–S8 stage design, Snowflake + Databricks worked
examples), `packages/bubble-core/CREATE_BUBBLE_README.md` (the 12-location registration
checklist), `docs/plan/IR-STATUS-MAP.md` (roadmap; §4 names the Hot-load gap).

---

## 1. The pipeline at a glance

```
INPUT: app name + source (spec file/URL | docs URL | SDK repo) + AppGenConfig
  │
  ▼
[G0  MODE SELECTION] ─ does the app ship a usable OpenAPI spec?
  │                                  │                          │
  │ YES                              │ NO                       │ NEITHER
  │ deterministic spec path          │ prose/SDK fallback       │ FAIL LOUDLY
  │ (BUILT: bubble-appgen)           │ (DESIGNED: Databricks    │ (no bubble is
  ▼                                  │  walk, ADD-ANY-APP §5)   │  ever guessed)
S1  SPEC ACQUISITION (DocPack)       └──────────┐               ▪
  [G1 usable-spec gate]                         │
  ▼                                             ▼
S2  OPERATION EXTRACTION ──────────── OperationDraft[] (same shape from either path)
  [G2a selection] [G2b collision] [G2c header/cookie policy]
  [G2d body shape] [G2e response shape]
  ▼
S3  CONTRACT DERIVATION (JSON Schema -> Zod source)
  [G3 coverage gates: $refs, unions, formats, optionality — map / throw / heuristic]
  ▼
S4  SIDE-EFFECT CLASSIFICATION
  [G4 carrier -> doc classifier -> fail-safe write+unverified]
  ▼
S5  AUTH  [G5: config-supplied today; securitySchemes inference DESIGNED]
  ▼
S6  CODE EMISSION (5 files) -> repo prettier
  [G6 idempotent-regeneration gate]
  ▼
S7  VALIDATION
  [G7a tsc] [G7b generated schema tests] [G7c metadata coverage guard]
  [G7d runtime factory probe] [G7e human sign-off on `unverified` — DESIGNED]
  ▼
S8  REGISTRATION — the 12-location checklist
  [G8 wired-vs-manual map + coexistence rule for an existing hand-written bubble]
  ▼
S9  BUILD / AVAILABILITY
  [G9 today: rebuild shared-schemas -> bubble-core -> api;
      end-state: Hot-load registry, dynamic import, no rebuild — UNBUILT]
  ▼
RUNTIME SAFETY NET (outside the pipeline, merged on main):
  base class classifies unknown operations as 'write' fail-safe;
  test mode mocks every non-read without an approved write grant.
```

Invariant the whole pipeline holds: **a wrong schema or a wrong guess is worse than a loud
gap.** Every unmapped situation throws at generation time; every unknowable side effect
defaults to `write` and is flagged; nothing silent ever reaches the runtime.

---

## 2. G0 — Input intake and mode selection

**What decides the branch:** whether an official OpenAPI document for the target surface
exists and parses.

| Situation                                                                                                                                                                 | Branch                                                                                                                              | Status                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Vendor ships an official OpenAPI 3.0 spec (Snowflake: `snowflakedb/snowflake-rest-api-specs`, `sqlapi.yaml`)                                                              | Deterministic spec path: zero LLM, zero network at generation time                                                                  | **BUILT** (`packages/bubble-appgen/src/cli.ts`)                                  |
| No public spec, docs are a JavaScript-rendered SPA (single-page application) shell, but the vendor generates SDKs from an internal spec (Databricks: `databricks-sdk-go`) | SDK-docstring mining -> the same `OperationDraft[]`, treated as prose-tier evidence with a mandatory human review gate              | **DESIGNED** (ADD-ANY-APP §3 S2 "SDK path", §5)                                  |
| Static-HTML prose docs only                                                                                                                                               | LLM-assisted extraction with verbatim-quote grounding (a quote that is not a substring of the fetched page rejects the draft field) | **DESIGNED** (ADD-ANY-APP S2 "prose path")                                       |
| An MCP (Model Context Protocol) server                                                                                                                                    | `tools/list` maps 1:1 onto drafts, annotations feed S4                                                                              | **DESIGNED**                                                                     |
| None of the above                                                                                                                                                         | Fail loudly. No heuristic invents an operation surface.                                                                             | Enforced by construction: every BUILT stage throws on missing input (see G1, G2) |

**What the MVP actually does at G0:** nothing automatic. The CLI _requires_ `--spec` and
`--config` and exits with usage otherwise (`cli.ts:27–34`). Mode selection is a human decision
encoded in the config file (`examples/snowflake-sql-api.config.json` names the spec, the
operations, the credential type). The S1 discovery ladder (user spec -> vendor repo probe ->
MCP -> prose crawl -> SDK mining) is design, not code.

---

## 3. S1 — Spec acquisition (the DocPack)

**DESIGNED discovery order** (first hit wins, ADD-ANY-APP S1): user-supplied spec ->
vendor spec-repo probe -> MCP `tools/list` -> static prose crawl -> SPA fallback via
generated-SDK mining. The DocPack caches raw documents with `{url, retrievedAt, sha256}` so a
re-run can diff vendor drift; it is never committed.

**BUILT reality:** the DocPack is a vendored local file, `packages/bubble-appgen/fixtures/sqlapi.yaml`
(853 lines, the official Snowflake SQL API v2 spec). `loadOpenApi()` reads it offline.

**G1 — usable-spec gate** (`packages/bubble-appgen/src/openapi.ts`):

- YAML must parse to an object, else throw (`Spec did not parse to an object`).
- Every `$ref` must be local (`#/…`); an external ref throws
  (`Only local $refs are supported by the MVP generator`).
- Every `$ref` must resolve; a dangling pointer throws (`Unresolvable $ref`).
- A **cyclic `$ref` throws** (`Cyclic $ref not supported: a -> b -> a`). The code comment calls
  this an honest MVP limitation: recursive vendor schemas need named-schema emission, which is
  not built. Rule at this gate: throw, never truncate the cycle.

Output: a fully dereferenced `OpenApiDocument`, deterministic (same file, same object).

---

## 4. S2 — Operation extraction

`extractOperations(doc, config.operations, config.specName)` normalizes selected operations to
`OperationDraft` (`packages/bubble-appgen/src/types.ts`): snake_case name, method,
pathTemplate, summary/description, a JSON-pointer citation
(`sqlapi.yaml#/paths/~1api~1v2~1statements/post`), flattened `WireField[]`, merged 2xx
response properties, spec examples, and the operation's `securitySchemes`.

Gates, in execution order (`packages/bubble-appgen/src/extract.ts`):

**G2a — selection.** Only `operationId`s listed in the config generate. An id not found in the
spec throws (`operationIds not found in spec: …`). Output order equals config order
(deterministic regeneration). Rationale (ADD-ANY-APP §7): a curated slice, never all endpoints
of a 900-path spec. Path-level and operation-level parameters merge; the operation level wins
on a duplicate.

**G2b — collision.** Path + query params + JSON body properties flatten into ONE params object
per operation (composeInput flattening). Two fields with the same name in different wire
locations throw (`input field collision on "x"`), never a silent rename. The wire binding
(`path` | `query` | `body`) is kept per field and drives request building in S6.

**G2c — header and cookie policy.**

- Managed headers (`accept`, `accept-encoding`, `content-type`, `user-agent`, and anything
  containing `authorization`) are dropped from params: the request builder stamps them from
  config, callers never supply them.
- Any OTHER header parameter throws (`header parameter "x" is not in the managed-header set;
extend the request-builder policy before generating`).
- **Cookie parameters throw** (`cookie parameters are unsupported`). Rule: throw loudly, no
  cookie heuristic.

**G2d — request-body shape.**

- A `requestBody` without an `application/json` schema throws.
- A **non-object JSON body throws** (`only object request bodies are flattened by the MVP
generator`); arrays or scalars as a whole body are unmapped by design.
- The spec's `requestBody` example, when object-shaped, is captured (`requestExample`) and
  becomes a generated test fixture.

**G2e — response shape.**

- Every documented 2xx JSON response contributes; **a non-object 2xx schema throws**; an
  operation with **no documented 2xx JSON response throws**.
- Fields shared across statuses (the 200/202 envelope case) merge; when the same field name
  carries a _different_ shape in two statuses, the first occurrence wins and a loud
  `console.warn` records the divergence (the one heuristic in S2, and it is logged, not
  silent).
- Response examples are captured per status and become result-schema test fixtures.

---

## 5. S3 — Contract derivation (JSON Schema -> Zod source)

`packages/bubble-appgen/src/zod-emit.ts` projects each schema node to a Zod source-code
expression. The stated rule in the file header: coverage is the OpenAPI 3.0 subset the MVP
needs; **anything unhandled throws rather than guesses**.

Gate table — the coverage-gap situations and the rule applied to each:

| Situation                                               | Rule                                                                                                                                                                                                                                     | Where                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Cyclic `$ref`                                           | **throw** (caught earlier, at G1 dereference)                                                                                                                                                                                            | `openapi.ts` `deref()`          |
| External `$ref`                                         | **throw**                                                                                                                                                                                                                                | `openapi.ts` `resolvePointer()` |
| `oneOf` / `anyOf`                                       | **map**: `z.union([...])`; a single variant unwraps                                                                                                                                                                                      | `zodFor()`                      |
| `allOf`                                                 | **heuristic**: merge member object properties + required lists into one object                                                                                                                                                           | `zodFor()`                      |
| `enum` on string                                        | **map**: `z.enum([...])`                                                                                                                                                                                                                 | `zodFor()`                      |
| `format: uuid`                                          | **map**: `.uuid()`                                                                                                                                                                                                                       | `zodFor()`                      |
| `format: uri`                                           | **deliberately NOT mapped** to `.url()`: vendors return relative URIs (Snowflake's `statementStatusUrl` is `/api/v2/statements/{handle}`), and `z.string().url()` would reject live responses. Encoded as a NOTE comment in the emitter. | `zodFor()` string case          |
| `minLength`/`maxLength`, `minimum`/`maximum`, `integer` | **map** to `.min/.max/.int()`                                                                                                                                                                                                            | `zodFor()`                      |
| Object with no declared properties                      | **map** per JSON Schema semantics: an open map, `z.record(z.string(), z.unknown())` (typed `additionalProperties` supported), NOT `z.object({})`                                                                                         | `isOpenObject()`                |
| Schema with no `type` but with `properties`             | **heuristic**: treat as object; with neither, `z.unknown()`                                                                                                                                                                              | `zodFor()`                      |
| Any other `type` value                                  | **throw** (`Unhandled JSON Schema type`)                                                                                                                                                                                                 | `zodFor()` default case         |
| `nullable: true`                                        | **map**: `.nullable()`                                                                                                                                                                                                                   | `zodFor()`                      |

**Optional-vs-required rules (the fidelity gate):**

- A path/query parameter is required iff the spec says `required: true`.
- A body field is required **iff** `requestBody.required === true` AND the field name appears in
  the body schema's `required` list. Both must hold.
- Consequence observed on Snowflake: `statement` is emitted `.optional()` because `sqlapi.yaml`
  marks the requestBody required but declares **no** `required` list on the body schema. The
  generator reproduces the spec, it does not "know better". Fixing that means fixing the
  evidence (spec overlay / human review), not the emitter.
- **Every result-payload field is `.optional()`**: the 2xx responses merge across statuses and
  presence varies by status code (stated in the generated doc comment on each
  `…PayloadSchema`).
- Every leaf carries `.describe()` from the spec's own prose, because `.describe()` is what the
  downstream codegen LLM and `get-bubble-details-tool` read.

Assembly (in `emit-bubble.ts`): params = `z.discriminatedUnion('operation', [...])`, one branch
per operation, each branch = `operation` literal + the required `baseUrlParam`
(`accountUrl: z.string().url()`) + wire fields (sorted path, body, query) + the BubbleLab
`credentials` record. Results = a discriminated union of `{operation, success, error}` merged
with the per-operation payload schema.

---

## 6. S4 — Side-effect classification gate

`packages/bubble-appgen/src/classify.ts` delegates to the SHIPPED classifier
(`packages/bubble-core/src/utils/side-effect-classifier.ts`, merged on main via PR #2 / IR-8),
so generated metadata matches the backfill pipeline. Decision ladder:

1. **Carrier detection.** The operation is a carrier (executes caller-supplied SQL/code) when
   its prose matches `/\b(execut\w*|submit\w*|run\w*)\b/i` AND a body field is a string named
   in `carrierFields` (default: `statement, sql, query, code, command`). Result: fail-safe
   `write`, confidence 0.85, citation carries the carrier note ("executes caller-supplied SQL;
   fail-safe write until statement-level verb refinement is applied"). The statement-level SQL
   verb refinement itself is DESIGNED (ADD-ANY-APP S4), not built.
2. **`classifyFromOpenApi`.** Prose-only: the HTTP method never picks the class (it only
   corroborates idempotency for PUT/DELETE writes). Negated clauses ("does not modify…") are
   stripped before matching. Signal precedence: creates-new-record (`write`, not idempotent)
   > mutates-without-creating (`read_with_side_effects`, idempotent) > reads (`read`). No
   > prose or no signal returns `undefined` (honest fall-through).
3. **Fail-safe.** `write` + `unverified: true` + confidence 0.2, citation `no doc signal in
"…"; fail-safe write pending human review`. Never a silent guess.

**What Snowflake actually produced** (`snowflake-sql-api.metadata.ts`):

| Operation              | Result                            | Why                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `submit_statement`     | `write` @ 0.85                    | Gate 1: carrier (`statement` body string + "Submits… for execution")                                                                                                                                                                                                     |
| `get_statement_status` | `read_with_side_effects` @ 0.85   | **KNOWN FALSE POSITIVE.** The description "…returns the requested partition of the result **set**" trips `\bsets?\b` in `MUTATION_PATTERNS` (the noun "result set", not the verb "sets"); mutates outranks reads, so a pure read classifies as `read_with_side_effects`. |
| `cancel_statement`     | `write` @ 0.2, `unverified: true` | Gate 3: "Cancels" appears in none of the four pattern lists (creation/destructive/mutation/read), so there is no signal at all.                                                                                                                                          |

**How the false positive is handled:** it is NOT silently corrected. The mis-class errs in the
restrictive direction only (a read treated as side-effecting gets mocked in test mode and
gated at sign-off; it can never cause an unintended write). Correction channels, in order:
the S7.5 human review gate (DESIGNED), a `classifyFromManual` override (BUILT in the classifier,
citation mandatory: who asserted it and on what basis), and runtime `observed` classifications
which outrank everything doc-derived (classifier header). The coverage guard (§9) allows
`unverified` entries but rejects uncited ones, so both fail-safes stay visible.

---

## 7. S5 — Auth gate

**BUILT reality: config-supplied, not inferred.** The emitter hardcodes
`static readonly authType = 'apikey'`; the credential type (`SNOWFLAKE_PAT`), the static auth
headers (`X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN`,
`User-Agent: bubblelab/1.0`), and the per-account `baseUrlParam` all come from the config
file. `Authorization: Bearer <token>` is always stamped from the chosen credential.
`chooseCredential()` reads exactly one `CredentialType` from the params credentials record.

**DESIGNED inference** (ADD-ANY-APP S5): map OpenAPI `securitySchemes` onto BubbleLab's
credential system — `apiKey`/bearer/basic -> `'apikey'`; `oauth2` authorizationCode ->
`'oauth'` with URL + scope wiring; DB-style connect (host/account + secret, keypair JWT
(JSON Web Token)) -> `'apikey'` with `credentialConfigurations` extras or
`'connection-string'`. S2 already captures `draft.securitySchemes` per operation (Snowflake:
`KeyPair`, `ExternalOAuth`, `SnowflakeOAuth`, `ProgrammaticAccessToken`), **but the emitter
does not read them today** — the field is plumbing for this gate, unused.

**Still unhandled anywhere:** oauth2 flow wiring for generated bubbles, keypair-JWT minting,
connection-string credentials, multi-scheme resolution inside `chooseCredential()`, api-keys
delivered in query params or custom header names. Related unmerged work: branch
`improve/auth-methods-from-docs` (IR-3/4, auth derived from an app's docs) sits in the review
queue (IR-STATUS-MAP §2) and should be reconciled with this gate when reviewed.

---

## 8. S6 — Code emission

`emitBubble()` produces exactly five files (the compliance target of ADD-ANY-APP §1, with two
deltas noted in §13):

| File                   | Satisfies                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<app>.schema.ts`      | Params discriminated union on `operation`; result union with the `{success, error}` envelope merged per branch; exported `…Params`, `…ParamsInput`, `…Result`, per-op `Extract<>` types.                                                                                                                                                                      |
| `<app>.metadata.ts`    | `BubbleOperationMetadata` const: sideEffect/destructive/idempotent/confidence/source/citation (+`unverified`) per operation, from S4.                                                                                                                                                                                                                         |
| `<app>.ts`             | `class <App>Bubble extends ServiceBubble` (raw-fetch pattern, github.ts-style, zero vendor SDK deps): statics (`type/service/authType/bubbleName/operationMetadata/schema/resultSchema/short/longDescription/alias`), `performAction` switch over operations delegating to per-op private handlers, `chooseCredential()`, `testCredential()`, inline helpers. |
| `<app>.schema.test.ts` | Generated vitest suite (see G7b).                                                                                                                                                                                                                                                                                                                             |
| `index.ts`             | Public exports (class, metadata const, schemas, types).                                                                                                                                                                                                                                                                                                       |

Emission details, each grounded in `emit-bubble.ts`:

- **Per-op handler:** parse `this.params` through the union -> `chooseCredential()` (a missing
  credential returns a typed error result, no throw) -> `buildQuery` over query fields /
  `pruneUndefined` over body fields -> `fetch` with path params
  `encodeURIComponent()`-substituted into the template -> non-OK responses return
  `{success:false, error: '<app> API error (status): body'}` -> the JSON payload parses
  through the operation's `PayloadSchema` (drift throws, is caught, and returns an error
  result: **drift = fail, not warn**).
- **Helpers are inlined**, and only when needed: `trimBaseUrl` always; `buildQuery` iff any
  operation has query fields; `pruneUndefined` iff any has body fields. There is no
  `<app>.utils.ts` (design delta, §13).
- **`testCredential()`:** `pickProbe()` selects a `read`-classified GET; failing that, ANY GET
  (a GET carries no body, so a probe with a synthesized path handle cannot execute work);
  failing that, **generation throws** (`no GET operation available for testCredential()`).
  The probe fetches with synthesized path params; `401/403` = credential rejected, any other
  status (including 404 for the fake handle) = accepted. Snowflake: the false positive in S4
  meant no `read`-classified GET existed, so the any-GET fallback picked
  `get_statement_status` with a synthesized UUID handle.
- **Constructor default params = the probe operation's synthesized params**, never a
  write-shaped default (fixed in commit `2b6b732`: the first cut defaulted to
  `submit_statement`; the regeneration switched it to `get_statement_status`). This default is
  load-bearing for registration gate #7 (§10).
- Every file opens with a `GENERATED by @bubblelab/bubble-appgen from <spec> — do not
hand-edit; re-run …` header. No `as any` appears in emitted code; the files must pass repo
  typecheck as-is.

**G6 — idempotent-regeneration gate.** The CLI pipes the output directory through the repo
prettier. Reason (commit `2b6b732`): the pre-commit hook prettifies committed files, so raw
emitter output diverged from the committed files on re-run. With formatting applied, a second
generator run produces a zero diff (verified). Rule: regeneration must be a no-op diff or the
generator is broken.

---

## 9. S7 — Validation gates

What must pass before a generated tool counts as done. Gates a–d are BUILT and were run
(commit `974593b`); e is DESIGNED.

- **G7a — static.** `tsc --noEmit` clean across shared-schemas, bubble-core, bubble-runtime,
  bubble-studio, bubblelab-api, bubble-appgen; eslint clean.
- **G7b — generated schema tests** (`<app>.schema.test.ts`, 12/12 pass for Snowflake). Per
  operation: a spec-example request is ACCEPTED; a type-corrupted request (first string field
  set to a number) is REJECTED; the spec's own response example parses through the result
  schema. Plus: missing `accountUrl` rejected, unknown operation rejected.
- **G7c — coverage guard** (inside the same test file, and the repo-wide
  `operation-metadata.test.ts` guard, 7/7): every operation literal in the params union has a
  metadata entry with non-empty `source` and `citation`. `unverified` is allowed; uncited is
  not.
- **G7d — runtime factory probe**
  (`packages/bubble-appgen/scripts/validate-snowflake-sql-api.ts`): `registerDefaults()`
  registers the bubble; `factory.getMetadata('snowflake-sql-api')` exposes params/result
  schemas + operationMetadata; live Zod accept/reject round-trips; result-schema drift
  rejection (`statementHandle: 'not-a-uuid'` fails); direct class instantiation.
- **G7e — human sign-off gate (DESIGNED).** Mandatory review of every `unverified`
  classification and every prose-derived draft before the tool is trusted. Not implemented:
  Snowflake's `cancel_statement` sits flagged `unverified` in the committed metadata, awaiting
  exactly this gate. The live credentialed probe (`testCredential()` + read-only smoke,
  ADD-ANY-APP S7.6) was also not run for the MVP (no credential in the loop).

**Runtime safety net behind all of this** (merged on main, outside the pipeline): the base
class classifies any unknown/unlisted operation as `'write'` fail-safe
(`base-bubble-class.ts` `get sideEffect`), and test mode intercepts ABOVE `performAction`,
returning a mock for every non-`read` operation unless the exact call site carries an approved
write grant (`base-bubble-class.ts:286–313`, `hasApprovedWriteGrant`). A mis-generated or
mis-classified tool therefore degrades to blocked writes, never to silent writes.

---

## 10. S8 — Registration gate: the 12 locations

`CREATE_BUBBLE_README.md:1050` enumerates 12 locations. The MVP wired them **by hand** (the
`scripts/register-bubble.ts` codemod from ADD-ANY-APP S8 does not exist; verified by search).
Status per location for the Snowflake MVP:

| #   | Location (README)                 | Real file                                                                                                                                                                                                                           | MVP status                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CredentialType enum               | `packages/bubble-shared-schemas/src/types.ts`                                                                                                                                                                                       | **wired** (`SNOWFLAKE_PAT`)                                                                                                                                                                                                                                                                                                                  |
| 2   | CREDENTIAL_CONFIGURATION_MAP      | `packages/bubble-shared-schemas/src/bubble-definition-schema.ts`                                                                                                                                                                    | **wired** (`accountUrl: STRING`)                                                                                                                                                                                                                                                                                                             |
| 3   | CREDENTIAL_ENV_MAP                | `packages/bubble-shared-schemas/src/credential-schema.ts`                                                                                                                                                                           | **wired** (`SNOWFLAKE_PAT`)                                                                                                                                                                                                                                                                                                                  |
| 4   | Frontend credential config        | CREDENTIAL_TYPE_CONFIG actually lives in `packages/bubble-shared-schemas/src/credential-schema.ts` (README says `CredentialsPage.tsx`: stale); the `typeToServiceMap` half is in `apps/bubble-studio/src/pages/CredentialsPage.tsx` | **wired** (both halves)                                                                                                                                                                                                                                                                                                                      |
| 5   | BUBBLE_CREDENTIAL_OPTIONS         | `credential-schema.ts`                                                                                                                                                                                                              | **wired**                                                                                                                                                                                                                                                                                                                                    |
| 6   | BubbleName union                  | `types.ts`                                                                                                                                                                                                                          | **wired** (`'snowflake-sql-api'`)                                                                                                                                                                                                                                                                                                            |
| 7   | Credential-validator test params  | `apps/bubblelab-api/src/services/credential-validator.ts` `createTestParameters`                                                                                                                                                    | **deferred, mitigated by design**: the validator passes `undefined` when no case exists (`credential-validator.ts:53–58`) and the bubble falls back to its constructor defaults, which the generator synthesizes as the complete probe params (§8). A generated bubble validates with no per-app case as long as its defaults stay complete. |
| 8   | SYSTEM_CREDENTIALS auto-injection | `apps/bubblelab-api/src/services/bubble-flow-parser.ts`                                                                                                                                                                             | **deliberately NOT wired**: service credentials are never auto-injected (README note + ADD-ANY-APP #8 "default NO").                                                                                                                                                                                                                         |
| 9   | Factory registerDefaults          | `packages/bubble-core/src/bubble-factory.ts`                                                                                                                                                                                        | **wired** (import + register)                                                                                                                                                                                                                                                                                                                |
| 10  | listBubblesForCodeGenerator       | same file                                                                                                                                                                                                                           | **wired** (the bubble is discoverable by flow generation)                                                                                                                                                                                                                                                                                    |
| 11  | Core index exports                | `packages/bubble-core/src/index.ts`                                                                                                                                                                                                 | **wired** (class + ParamsInput type)                                                                                                                                                                                                                                                                                                         |
| 12  | Studio logos/aliases/matchers     | `apps/bubble-studio/src/lib/integrations.ts` + logo SVG                                                                                                                                                                             | **deferred** (the hand-written snowflake bubble has no logo entry either)                                                                                                                                                                                                                                                                    |
| —   | Docs regen + metadata bundle      | `scripts/generate-bubble-docs.ts`; `packages/bubble-core/scripts/bubble-metadata-bundler.ts` -> `dist/bubbles.json`                                                                                                                 | **deferred / build-time**: not run for the MVP; the bundle regenerates on the next `bubble-core` build.                                                                                                                                                                                                                                      |

**Coexistence rule (when a hand-written bubble for the same app exists).** The generated bubble
takes a DISTINCT `BubbleName` and a DISTINCT `CredentialType` and never touches the existing
folder: `snowflake-sql-api`/`SNOWFLAKE_PAT` was registered alongside the hand-written
`snowflake`/`SNOWFLAKE_CRED`. The two share only the display-level identity:
`static service = 'snowflake'` and the studio `typeToServiceMap` entry `'Snowflake'`. Distinct
names mean zero collision at all 12 locations; both register in the factory and both appear to
the code generator. Retiring the hand-written one is a separate, human decision.

**Known drift to fix in the README:** it says `packages/shared-schemas/…`; the package is
`packages/bubble-shared-schemas/…`. And #4's CREDENTIAL_TYPE_CONFIG moved to shared-schemas.

---

## 11. S9 — Build / availability gate

**Today (BUILT reality):** the generated bubble is source inside `bubble-core`, so the runtime
sees it only after a rebuild: turbo's `build.dependsOn: ["^build"]` orders
`bubble-shared-schemas` -> `bubble-core` (whose build = `tsc` + bubble-bundler +
bubble-metadata-bundler producing `dist/bubbles.json`) -> `bubblelab-api` / `bubble-studio`,
then a service restart. New CredentialType enum members make the shared-schemas rebuild
mandatory, not optional.

**End-state (UNBUILT, and its design doc is UNWRITTEN):** the Hot-load tool registry
(IR-STATUS-MAP §4): a separate build service compiles a generated tool into an artifact,
records it in a database registry (the IR-1 AppSpec is the record shape), and the live app
dynamic-imports it with no rebuild and no service interruption; IR-16 sandboxing is the safety
boundary around it. It slots in EXACTLY here, replacing this gate: S8's file-edit checklist
collapses into a registry insert, and S9's rebuild disappears. The roadmap directs that the
agentic add-a-tool (`improve/contract-first-generation`, currently an empty branch) be rebuilt
against that design rather than the 12-location codemod path. Until that doc exists and is
built, every generated tool pays the rebuild.

---

## 12. Gate map — Snowflake MVP (actual) vs Databricks (what no-OpenAPI forces)

| Gate              | Snowflake MVP did (verified)                                                                       | Databricks would force (DESIGNED, ADD-ANY-APP §5)                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G0 mode           | Human-selected spec path; official `sqlapi.yaml` vendored                                          | Discovery finds no spec; docs URL returns a 2.3 KB SPA shell to plain fetches (probe-verified in ADD-ANY-APP); SDK path engages on `databricks-sdk-go` |
| S1 DocPack        | One local YAML file, offline                                                                       | Cloned SDK files (`service/sql/api.go` docstrings + `impl.go` verb/path pairs) + human-readable docs URLs recorded per operation for citations         |
| S2 extraction     | Deterministic parse of 3 selected operationIds; ~80 ms end-to-end, zero LLM (commit `974593b`)     | Deterministic parse of GENERATED Go code (structs -> input schemas, docstrings -> prose); still no guessing, but evidence tier drops to prose          |
| S3 contracts      | Zod from spec schemas; `statement` optional because the spec omits a required list                 | Zod from SDK struct fields (`warehouse_id`, `statement`, `wait_timeout`, `disposition`, …); same emitter                                               |
| S4 classification | `source: 'openapi'`, confidence 0.85/0.2; carrier + false positive + no-signal cases all exercised | `source: 'prose'`, confidence 0.6 ceiling; `execute_statement` carrier-write, `cancel_execution` same no-signal problem as `cancel_statement`          |
| S5 auth           | Config-supplied PAT (programmatic access token) + `accountUrl` param + token-type header           | Config-supplied `DATABRICKS_TOKEN` bearer + workspace `host` param; OAuth machine-to-machine later                                                     |
| S6 emission       | 5 files, raw fetch, probe = any-GET `get_statement_status`                                         | Identical file shape; probe = `list_warehouses` (a true read GET exists)                                                                               |
| G7e review        | Skipped (gap): `cancel_statement` sits `unverified`                                                | **MANDATORY**: every prose-derived draft and classification needs explicit human ack before codegen is trusted                                         |
| S8 registration   | 9 of 12 locations hand-wired; coexists with hand-written `snowflake`                               | Same checklist; no existing databricks bubble, so no coexistence concern                                                                               |
| S9 build          | Rebuild required (not exercised on a running server in the MVP)                                    | Same, until Hot-load exists                                                                                                                            |

The pair is the design's invariant: the fully deterministic walk and the prose walk both land
in the identical ServiceBubble shape with cited side-effect metadata; the only differences are
evidence tier, confidence, and which human gates are mandatory.

---

## 13. Where the real code contradicts the ADD-ANY-APP design (reconciliation list)

1. **File set.** Design (§1) lists `<app>.utils.ts` (request builder) and `<app>.test.ts`. Real
   emitter inlines the helpers into `<app>.ts` and names the test `<app>.schema.test.ts`.
2. **S8 codemod.** Design promises `scripts/register-bubble.ts` (idempotent). It does not
   exist; the MVP registration was hand-applied edits.
3. **S4 predictions were wrong in both directions.** Design (§4) predicted
   `get_statement_status -> read` and `cancel_statement -> read_with_side_effects`. Real
   classifier output: `read_with_side_effects` (the `\bsets?\b` / "result set" false positive)
   and `unverified write` ("Cancels" has no pattern). Both errors are restrictive, but the
   design's worked example should not be read as the classifier's actual behavior.
4. **testCredential.** Design (§4) says pick a cheap resource read (`GET /api/v2/databases`) or
   submit `SELECT 1` under sign-off. Real code: `pickProbe` = read-GET, else any-GET with a
   synthesized handle, else throw. No resource-spec ops were generated, no `SELECT 1` path
   exists.
5. **Naming / coexistence.** Design's worked example writes `snowflake.metadata.ts`, implying
   the generated bubble IS the app's bubble. Real: a new name `snowflake-sql-api` coexisting
   with the hand-written `snowflake`. The coexistence rule (§10) is the real policy.
6. **S5 inference.** Designed as inferred-from-securitySchemes; real is 100% config-supplied
   with `authType` hardcoded `'apikey'`. `draft.securitySchemes` is captured and then unused.
7. **S1 discovery / MCP / prose paths.** None built; the CLI takes a local spec file only.
8. **`accountUrl` is declared twice.** The MVP registers `accountUrl` under
   `CREDENTIAL_CONFIGURATION_MAP[SNOWFLAKE_PAT]` (a credential-side configuration field) while
   the bubble takes `accountUrl` as a required per-call param and the credential's own UI
   config says "the per-account URL is a bubble parameter" with empty
   `credentialConfigurations`. One of the two representations should win.
9. **Per-stage artifacts.** Design says every stage emits a reviewable artifact and is
   re-runnable per stage. Real CLI is a single pass with the generated files as the only
   artifact (idempotent as a whole via G6, no intermediate artifacts).
10. **CREATE_BUBBLE_README paths.** `packages/shared-schemas/` vs the real
    `packages/bubble-shared-schemas/`; CREDENTIAL_TYPE_CONFIG location (#4) moved to
    shared-schemas.

---

## 14. References

- Design: `docs/plan/ADD-ANY-APP.md` @ branch `plan/add-app-feature` (pipeline S1–S8, worked
  examples, vendor-doc references verified 2026-07-15).
- Implementation: branch `improve/add-a-tool-mvp`, commits `974593b` (MVP + verification
  record) and `2b6b732` (idempotent regeneration + read-shaped constructor default):
  `packages/bubble-appgen/src/{cli,openapi,extract,zod-emit,classify,emit-bubble,types}.ts`,
  `packages/bubble-appgen/scripts/validate-snowflake-sql-api.ts`,
  `packages/bubble-appgen/examples/snowflake-sql-api.config.json`,
  `packages/bubble-appgen/fixtures/sqlapi.yaml`, and the generated
  `packages/bubble-core/src/bubbles/service-bubble/snowflake-sql-api/`.
- Coding standard: `packages/bubble-core/CREATE_BUBBLE_README.md` (12-location checklist at
  :1050); ServiceBubble contract `packages/bubble-core/src/types/service-bubble-class.ts`;
  raw-fetch reference `packages/bubble-core/src/bubbles/service-bubble/github.ts`.
- Classifier + safety net (merged on main): `packages/bubble-core/src/utils/side-effect-classifier.ts`;
  `packages/bubble-core/src/types/base-bubble-class.ts` (`get sideEffect` fail-safe, test-mode
  interception at :286, `hasApprovedWriteGrant` at :457).
- Roadmap + the Hot-load gap: `docs/plan/IR-STATUS-MAP.md` (§4 Known gap, §2 review queue).
- Vendor sources: Snowflake spec repo
  https://github.com/snowflakedb/snowflake-rest-api-specs (sqlapi.yaml);
  Databricks SDK evidence https://github.com/databricks/databricks-sdk-go (see ADD-ANY-APP
  References for the deep links and probe notes).
