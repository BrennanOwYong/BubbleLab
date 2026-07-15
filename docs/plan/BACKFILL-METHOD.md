# BACKFILL-METHOD — deriving a doc-grounded side-effect hint for any operation

Companion to `HANDOFF.md` (§5 test-mode design), `IMPROVEMENT-REGISTER.md` (IR-8), and
`deltas/ir8-side-effect-metadata.md` (the shipped first backfill: 6 bubbles, 59 operations).
This document is the METHOD: how to obtain documentation for an operation, how to classify it,
how to cite it, and how to handle apps that publish no OpenAPI spec. The shipped classifier
(`packages/bubble-core/src/utils/side-effect-classifier.ts`) implements the deterministic core of
this method; the sections on SPA-doc mining, LLM signal extraction, and carrier operations extend
it for the ADD-ANY-APP pipeline (`docs/plan/ADD-ANY-APP.md`).

---

## 1. The binding rule

An operation's class is decided by what its DOCUMENTATION says it does, never by its HTTP method:

| Class | Rule | Examples |
|---|---|---|
| `write` | The docs say the operation CREATES A NEW RECORD, even as a side effect | send an email (a sent message comes into existence), create an issue, copy a file, share a file (a permission record is created), queue a build |
| `read_with_side_effects` | The docs indicate mutation WITHOUT record creation | mark-as-read, update, delete, cancel, archive, revoke |
| `read` | The docs indicate no mutation at all | get, list, search, retrieve, export (when the export creates no server-side artifact) |

Two orthogonal flags travel with the class:

- `destructive: boolean`, true when the docs carry delete/irreversible language ("permanently
  deletes", "cannot be undone"). A delete is `read_with_side_effects` + `destructive: true`,
  since deleting creates no record.
- `idempotent: boolean`, true when repeating converges to the same state. Creation is never
  idempotent (repeating creates a duplicate). Set-style mutations are idempotent. In the OpenAPI
  path the HTTP method corroborates ONLY this flag (RFC 9110 §9.2.2: PUT and DELETE are
  idempotent); it never picks the class.

Why the method is banned as a signal: the reference build's evidence base recorded 4 operations
whose docs said "read" but which mutated state at runtime (`IMPROVEMENT-REGISTER.md` IR-9
evidence), and real APIs routinely invert the verb convention. Section 7 gives two live examples:
a POST that only reads (Databricks cluster events) and a GET that creates a record (Jenkins
remote build trigger).

## 2. The provenance contract

A classification is a claim, and a claim must carry its source. Every emitted classification is
an `OperationSideEffectMetadata`
(`packages/bubble-shared-schemas/src/operation-metadata-schema.ts`):

```ts
{
  sideEffect: 'read' | 'write' | 'read_with_side_effects',
  destructive: boolean,
  idempotent: boolean,
  confidence: number,          // 0..1
  source: 'observed' | 'mcp' | 'openapi' | 'prose' | 'manual',
  citation: string,            // Zod .min(1): no classification exists without its source
  requiredScopes?: string[],   // consumed by the scope audit (IR-6/7)
  unverified?: boolean,        // fail-safe emission, pending human or runtime verification
}
```

Citation format, by construction in the shipped backfill:
`<deep doc URL> — "<the vendor's own sentence that grounds the class>"`. The quote is the
classifier input; the URL makes the claim auditable without re-deriving it. Example from
`packages/bubble-core/src/bubbles/service-bubble/github.metadata.ts`:

```
https://docs.github.com/en/rest/issues/issues#create-an-issue — "Create an issue. Any user with pull access to a repository can create an issue."
```

## 3. Source hierarchy

Most to least authoritative. Higher sources are consulted first; a source that yields no signal
falls through (never guesses); if nothing yields a signal the classifier throws
`ClassificationError` and the EMISSION layer (not the classifier) writes the fail-safe:
`write` + `unverified: true` + confidence 0.2.

| Rank | Source | Confidence | What it is | Why this rank |
|---|---|---|---|---|
| 0 | `observed` | 1.0 | Runtime-verified behavior from real executions (the correction channel, §8) | Runs do not lie; docs do |
| 1 | `mcp` | 0.95 | MCP (Model Context Protocol) `ToolAnnotations` on a tool: `readOnlyHint`, `destructiveHint`, `idempotentHint` | The vendor asserts the semantic hint directly, machine-readable, no NLP |
| 2 | `openapi` | 0.85 | The operation's `summary` + `description` prose from the vendor's OpenAPI document; the method corroborates idempotency only | Structured, versioned, per-endpoint, usually maintained by the vendor's API team |
| 3 | `prose` | 0.6 | Vendor reference-doc prose (HTML docs, SDK docstrings, curated quote tables) | Authoritative content, but acquisition and sentence-selection add error surface |
| 4 | `manual` | 1.0 (human-set) | A human assertion; citation still mandatory (who asserted, on what basis) | Last resort; auditable but not doc-derived |

MCP mapping detail (shipped in `classifyFromMcpAnnotations`): `readOnlyHint: true` maps to
`read`; anything else maps conservatively to `write` with the MCP spec defaults
`destructiveHint ?? true`, `idempotentHint ?? false`, because MCP says "modifies its environment"
without saying whether a record is created.

## 4. Obtaining the docs, per source

### 4.1 MCP annotations
If the vendor ships an MCP server, call `tools/list` and read each tool's `annotations`.
This is the cheapest and most reliable path when it exists. Citation:
`mcp://<server>/tools/<name>` plus the annotation values.

### 4.2 OpenAPI documents
Discovery order:
1. User-supplied spec URL or file.
2. Vendor spec repositories on GitHub (pattern: `<vendor>/…-api-specs` or `…openapi…`;
   verified example: `snowflakedb/snowflake-rest-api-specs` publishes 40+ OpenAPI 3.0 files
   including `specifications/sqlapi.yaml`).
3. Well-known locations on the API host (`/openapi.json`, `/swagger.json`, docs-page download
   links).

Classification input is the selected operation's `summary` + `description` joined; an OpenAPI
operation WITHOUT prose yields nothing and falls through (the method+path alone is never enough).
Citation: JSON-pointer into the doc, e.g. `sqlapi.yaml#/paths/~1api~1v2~1statements/post`,
optionally with the summary quoted.

### 4.3 Doc prose, and what to do when the docs are a JavaScript app
Many vendors ship no spec. The prose path, in acquisition order:

1. **Static HTML reference pages.** Fetch, extract the operation's description sentence(s),
   store URL + quote. This is the shipped backfill's curated-quote-table pattern
   (`packages/bubble-core/scripts/backfill-operation-metadata.ts`, `VENDOR_DOCS`).
2. **SPA-rendered doc sites (fetch returns an empty shell).** Verified case: every
   `docs.databricks.com/api/...` URL returns the same ~2.3 KB HTML shell to a plain fetch,
   including probes with `.json` suffixes. Two workable fallbacks, in preference order:
   a. **Official SDK docstring mining.** Vendors that generate SDKs from an internal spec ship
      the same operation prose as docstrings. Verified for Databricks: `databricks-sdk-go`
      docstrings state "This method is generated by Databricks SDK Code Generator", the
      interface files (`service/*/api.go`) carry the per-operation prose, and the implementation
      files (`service/*/impl.go`) carry the exact HTTP verb and path
      (`http.MethodPost`, `"/api/2.1/clusters/events"`). Cite the SDK source file plus the
      human-readable docs URL.
   b. **Headless-browser rendering** of the docs page (Playwright), then extract prose as in (1).
      Higher cost, use when no generated SDK exists.
3. **Schema `.describe()` prose** as the last doc-shaped fallback for existing bubbles (the
   bubble author's own operation description; still cited, lowest trust inside `prose`).

### 4.4 Manual
A human writes the classification with a citation naming the asserter and basis. Used for
operations whose docs are silent or contradictory, and for pipeline overrides
(the reference build's `sideEffectOverrides` keyed by `"<METHOD> <path>"`).

## 5. The classification procedure (deterministic core)

Implemented in `side-effect-classifier.ts`; the same rules apply regardless of which source
produced the prose:

1. **Negation stripping.** Split into sentences, drop clauses matching negation patterns
   ("does not", "won't", "never", "without", …) so "Does not modify any data" cannot fire the
   mutation patterns.
2. **Signal extraction** into a `DocSignals` shape:
   `{ createsNewRecord, mutates, destructive, reads }`, via four affirmative-verb pattern sets
   (creation: create/add/insert/send/publish/upload/copy/schedule/…; destructive:
   delete/remove/purge/permanently/cannot-be-undone/…; mutation:
   mark/update/modify/set/move/assign/revoke/cancel-family; read:
   return/retrieve/list/get/fetch/search/query/download/…).
3. **Rule application, in precedence order:**
   - `createsNewRecord` → `write` (idempotent false: creating again duplicates)
   - else `mutates` → `read_with_side_effects` (idempotent true: set-style convergence),
     `destructive` carries the delete signal
   - else `reads` → `read`
   - else → no result; fall through to the next evidence source.
4. **No signal anywhere** → `ClassificationError`. The emission layer records fail-safe
   `write` + `unverified: true`, never a silent guess. Runtime treats everything unclassified as
   `write` as well (`BaseBubble.get sideEffect` default), so safety never depends on backfill
   completeness.

## 6. The prose-NLP fallback, and its LLM upgrade path

The deterministic keyword front-end (`extractDocSignals`) is intentionally the REPLACEABLE part.
The upgrade for messy prose docs is an LLM extractor with a fixed contract:

- **The LLM extracts, the rules classify.** The model's only job is to produce
  (a) the same `DocSignals` booleans and (b) the exact sentence(s) it based them on, quoted
  verbatim from the supplied doc text. The deterministic `classifyFromSignals` rules then decide
  the class. The model never picks `read`/`write` directly, which keeps the binding rule
  centralized, testable, and identical across extractors.
- **Grounding check.** Reject any extraction whose quoted sentence is not a substring of the
  fetched doc text (guards against hallucinated evidence). The verified quote becomes the
  citation.
- **Confidence stays at the `prose` tier (0.6)** regardless of extractor, because the trust
  bound is the source, not the extraction method. Runtime observation (§8) is the only promoter.
- **Ambiguity is surfaced, not resolved.** If the model reports both creation and read language
  with no clear primary effect, emit the fail-safe and queue for human review, exactly like the
  no-signal case.

## 7. Worked examples (real operations)

### 7.1 A POST that only reads → `read`
Databricks, cluster events. Verified: `databricks-sdk-go/service/compute/impl.go` sends
`http.MethodPost` to `/api/2.1/clusters/events`; the interface docstring reads
"Retrieves a list of events about the activity of a cluster. This API is paginated."

```ts
{
  sideEffect: 'read', destructive: false, idempotent: true,
  confidence: 0.6, source: 'prose',
  citation: 'https://docs.databricks.com/api/workspace/clusters/events (prose via databricks-sdk-go service/compute/api.go, "This method is generated by Databricks SDK Code Generator") — "Retrieves a list of events about the activity of a cluster. This API is paginated."'
}
```
Method-only classification would have called this `write`. The prose says `read`:
"Retrieves" fires the read patterns, nothing fires creation or mutation.

### 7.2 A GET that creates a record → `write`
Jenkins, remote build trigger. The documented pattern
`JENKINS_URL/job/JOB_NAME/build?token=TOKEN` is callable as a plain HTTP GET (the
`build-token-root` plugin documents GET and POST for `buildByToken`), and it QUEUES A NEW BUILD:
a new record comes into existence.

```ts
{
  sideEffect: 'write', destructive: false, idempotent: false,
  confidence: 0.6, source: 'prose',
  citation: 'https://www.jenkins.io/doc/book/using/remote-access-api/ + https://plugins.jenkins.io/build-token-root/ — trigger URL "JENKINS_URL/job/JOB_NAME/build?token=TOKEN_NAME" schedules a new build; the plugin documents GET support.'
}
```
Method-only classification would have called this `read`. It creates a build record.

### 7.3 A nominal read-flow action that mutates → `read_with_side_effects`
Gmail, `mark_as_read` (users.messages.modify): "Modifies the labels on the specified message."
Mutation, no new record:

```ts
{ sideEffect: 'read_with_side_effects', destructive: false, idempotent: true,
  confidence: 0.6, source: 'prose',
  citation: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify — "Modifies the labels on the specified message."' }
```
Contrast `delete_email` ("Immediately and permanently deletes the specified message. This
operation cannot be undone."): still `read_with_side_effects` (no record created) but
`destructive: true`. Both shipped in
`packages/bubble-core/src/bubbles/service-bubble/gmail.metadata.ts`.

### 7.4 A carrier operation: the class depends on the payload
Snowflake SQL API, `SubmitStatement`. Verified from the vendor's own OpenAPI
(`snowflake-rest-api-specs/specifications/sqlapi.yaml`): `POST /api/v2/statements`,
summary "Submits a SQL statement for execution."

The operation itself is a CARRIER: `statement: 'SELECT 1'` reads,
`statement: 'INSERT INTO …'` writes, and no per-operation constant is truthful. Policy:

1. **Operation-level metadata records the fail-safe:** `write`, `unverified: false` but with the
   citation stating the carrier nature. This keeps the test-mode gate safe by construction.
2. **Statement-level refinement (parameter classifier):** a per-bubble hook inspects the
   `statement` param at gate time. A conservative allowlist on the leading SQL verb
   (`SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN`, single statement, no `INTO`, no DDL/DML anywhere
   in the text) may downgrade to `read` for gating purposes; anything else stays `write`.
   The refinement result carries `source: 'prose'`-tier confidence at most, and the citation
   names the rule that fired.
3. **Runtime observation (§8) is the only promoter** for carrier refinements, same as everywhere
   else.

```ts
{ sideEffect: 'write', destructive: false, idempotent: false,
  confidence: 0.85, source: 'openapi',
  citation: 'https://github.com/snowflakedb/snowflake-rest-api-specs specifications/sqlapi.yaml#/paths/~1api~1v2~1statements/post — "Submits one or more statements for execution." Carrier operation: the executed SQL decides the true effect; statement-level refinement applies at gate time.' }
```

The same policy covers Databricks `ExecuteStatement` (`POST /api/2.0/sql/statements`,
"Execute a SQL statement and optionally await its results"), generic HTTP bubbles, and any
"run code / run query" operation. Sibling operations classify normally:
Snowflake `GetStatementStatus` ("Checks the status of the execution") → `read`;
`CancelStatement` ("Cancels the execution of the statement") → `read_with_side_effects`
(mutation, no record).

## 8. The runtime correction channel (`observed`)

Docs lie; runs do not. Phase-2 executions (REPO-MAP §4b) compare declared class against observed
behavior (a "read" that returned a mutation acknowledgement, a write probe that provably created
nothing). A confirmed contradiction writes an `observed` override
(confidence 1.0, citation = run id + evidence), and `observed` outranks every doc-derived source
by enum ordering. The reference build caught 4 doc-said-read operations mutating this way.
Anti-poison rule carried over from IR-11/12: never learn from a mocked observation, require
consistent repeated observations before overriding.

## 9. Where provenance lands in the repo

- One colocated `src/bubbles/service-bubble/<name>.metadata.ts` per bubble, generated by the
  backfill script, imported by the bubble class as `static operationMetadata`. No central
  registry location.
- Guard test (`operation-metadata.test.ts`): every operation in an opted-in bubble's schema has
  an entry, every entry carries non-empty source + citation, unknown operations fail the build.
- Catalogue surfacing: `get-bubble-details-tool` emits per-operation
  `[side-effect: …]` tags + citations; `bubbles.json` carries `operationMetadata`; the codegen
  LLM reads both.

## References (verified 2026-07-15)

- Shipped classifier and schema: `packages/bubble-core/src/utils/side-effect-classifier.ts`,
  `packages/bubble-shared-schemas/src/operation-metadata-schema.ts` (commits c778b94, cbca070)
- MCP ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations
- HTTP idempotency, RFC 9110 §9.2.2: https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2
- Snowflake OpenAPI specs (official): https://github.com/snowflakedb/snowflake-rest-api-specs
  (SQL API: https://raw.githubusercontent.com/snowflakedb/snowflake-rest-api-specs/main/specifications/sqlapi.yaml)
- Snowflake SQL API prose docs: https://docs.snowflake.com/en/developer-guide/sql-api/intro
- Databricks API reference (SPA, shell-only to plain fetch, verified by probe):
  https://docs.databricks.com/api/workspace/clusters/events
- Databricks official SDK carrying generated operation prose + verbs/paths:
  https://github.com/databricks/databricks-sdk-go (`service/compute/api.go`,
  `service/compute/impl.go`, `service/sql/api.go`, `service/sql/impl.go`)
- Jenkins remote build trigger: https://www.jenkins.io/doc/book/using/remote-access-api/ and
  https://plugins.jenkins.io/build-token-root/
- Gmail users.messages.modify:
  https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify
- Reference implementation (evidence base, read-only):
  `integration_stitcher/packages/contracts/src/classifier.ts`,
  `integration_stitcher/packages/contractgen/src/generate.ts`
