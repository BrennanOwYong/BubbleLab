# Composio inside BubbleLab: quality check and architectural advisory

Status: speculative research. Nothing in the BubbleLab or Gluu codebases was modified.
Date of probes: 2026-08-01. All live measurements come from the Composio v3 API using the key in
`gluu/backend/.env`, SDK on disk `@composio/core@0.10.0`, latest published `0.14.1`.

Reproduce every number with `probes/01-catalog.sh`, `probes/03-tools.sh`, `probes/02-analyze.py`.
Raw API responses are in `raw/`.

**One disclosure about external state:** to settle Complaint 3 I sent one `POST /auth_configs` for
`github` with `authScheme: BEARER_TOKEN`. Composio accepted it and created `ac_4X6KwN_SUuL7`. I
deleted it in the next call and verified a 404 on re-fetch. Your account is back to the same 12
auth configs it had before. That acceptance is itself a finding (see §3.6 and §4).

---

## 1. Verdict up front

Composio and BubbleLab are not competitors for the same job, so "Composio vs Bubble" is the wrong
frame. Composio is a Software-as-a-Service (SaaS) API marketplace with a credential vault.
BubbleLab is a typed execution substrate with an Abstract Syntax Tree (AST) rewriter. The catalog
proves the split: Composio carries 1,069 toolkits and zero databases. No `postgres`, no `mysql`,
no `mongo`, no `redshift`, no S3. Your `postgresql`, `bigquery`, `redshift`, `s3` and
`snowflake-sql-api` bubbles have no Composio equivalent, and any flow that reads a warehouse or
writes an object keeps needing the bubble layer.

The real question is where to put the seam. My recommendation:

> Adopt Composio as a **credential and transport layer** behind a generated bubble family, and keep
> BubbleLab's parser, type system and provenance model as the product surface. Do not adopt
> Composio's tool schemas as your agent-facing interface.

The strongest argument is the one you arrived at yourself. Composio resolves credentials
server-side from `(userId, toolkit)`, so **no credential ever appears in the generated script**.
That dissolves the nested-tool credential problem at the root rather than patching the injector.
Section 5 works through this against your sandbox model.

Fidelity looked like the strongest argument against, and it survives scrutiny in a weakened form.
Composio's surface trails its vendors: it tracked Notion's 2025-09-03 data-source migration and
Slack's `files.upload` retirement, and it has not tracked Notion's 2026-03-11 renames despite
stamping the toolkit with last week's date. Coverage is good (25 of 28 Notion endpoints, 89%) and
no field anywhere tells you which vendor changes landed. **The trailing turns out to be mostly
benign**, because Composio holds a pinned vendor version where the vendor supports old versions
(Notion, indefinitely; GitHub, 24 months minimum) and migrates where the vendor removes things
outright (Slack). Section 3.2 measures the trail, section 3.9 measures whether it bites.

Schema weight is the sturdier argument against: a single Notion tool schema runs a median of 19 KB,
roughly 5,000 tokens, so curation is mandatory.

Your three logged complaints were re-tested against the live API today. Two confirmed, and the
severity ranking matters more than the count: the callback-URI contradiction is worth one line of
defensive code, the hidden github PAT is worth skipping. Section 4.

---

## 2. Your asks, scored, and how each platform answers them

Eleven asks, taken from your brief. Each one gets the same four beats: the ask, an honest read on
whether it holds up as a developer requirement, how Composio answers it, how BubbleLab answers it,
and where the two merge. A machine-readable copy of this matrix lives at `asks-matrix.json` for
rendering.

Verdict values: **Sound** holds up as stated, **Correction** holds up but a premise in the ask is
wrong and changes what you get, **Reframe** means the goal is right and the framing leads somewhere
unhelpful. Merge strength runs none / partial / strong / strongest, plus one case where Composio
wins outright.

### 2.1 The matrix

| # | Ask | Verdict | Composio answers | BubbleLab answers | Merge | Strength |
|---|---|---|---|---|---|---|
| **A1** | Weigh the Composio layer against Bubble | **Reframe.** The ask assumes overlapping scope; 1,069 toolkits carry zero databases, warehouses or object stores, so the question is where the seam sits | SaaS breadth plus a credential vault. 40 of your 53 third-party integrations exist there, with 1x to 26x more operations each | The execution substrate: parser, type system, credential model, canvas, studio. Composio has no equivalent | Composio underneath as credential and transport, BubbleLab on top as the product surface | strong |
| **A2** | Bubble's structure with Composio's toolset and managed auth | **Correction.** Managed auth covers 122 of 1,069. 915 need the user's own app or key; 45 are OAuth-only with no managed app and no key fallback (`twitter`, `xero`, `docusign`, `snowflake`) | OAuth refresh, token storage, revocation, per-user scoping, `restrict_to_following_tools` enforced server-side | 68 `CredentialType` members, per-step binding, credential pools, `SYSTEM_CREDENTIALS`. All hand-maintained | Replace credential storage and refresh, keep the credential model. Bind a step to a `connectedAccountId` rather than a secret | strong |
| **A3** | Is what Composio serves identical to the vendor's actual API? | **Sound**, and the decisive question for developer experience | **Trails by a release cycle, and the trail is mostly benign.** Tracked Notion 2025-09-03 and Slack's `files.upload` retirement; holds a 2025-09-03 pin on Notion rather than tracking 2026-03-11. Coverage 25/28 Notion endpoints (89%). Composio migrates when a vendor removes things and pins when it does not, which is the correct behaviour (§3.9) | Every bubble hand-written: 61 service bubbles, 536 operations, 53 of them third-party integrations | Composio absorbs the maintenance for the 40 overlapping integrations. Check the vendor's class before depending on a toolkit: version-pinned vendors (Notion, GitHub) need no vigilance, global-retirement vendors (Slack, Google) need a changelog watch and one live call per tool | partial |
| **A4** | Re-test the complaints, gauge UX and DX damage | **Sound.** Logged complaints are the cheapest signal on adoption risk | Two of three confirmed. Callback-URI contradiction is **medium** (one line of defensive code). Hidden github PAT is **low**, since github has managed OAuth so the easy path is already default | N/A. The second complaint traced to Gluu's own connect flow | The pattern outranks any single complaint: metadata under-reports what execution accepts, so verify by executing rather than by reading the catalog | none |
| **A5** | Surface factors not yet considered | **Sound** | Data path (payloads transit Composio, self-host is Enterprise-only), per-call billing, added hop, widened failure surface, 351 triggers across 1,069 toolkits, credential lock-in | Hybrid flows keep the AST injector in charge of bubbles, so both failure modes persist until bubbles migrate too | Data path and per-call billing are the two most likely to change the answer | none |
| **A6** | Wrap Composio tools in Bubble's type enforcement | **Sound**, highest value in the brief, best supported by evidence | 100% of sampled tools publish full JSON Schema for inputs and outputs using `$defs`/`$ref`. The SDK discards it: `ToolExecuteResponse.data` is `Record<string, unknown>` | Zod-validated parameters, compile-time checks, typed errors. The type system is the product spine | Generate Zod plus TypeScript per tool per pinned version, parse at the boundary, reject `is_deprecated` slugs at generation time | strong |
| **A7** | AST-detect Composio modules to fix nested creds | **Reframe.** Credentials never enter the script, so AST detection becomes a display mechanism rather than a correctness one | Dissolves the bug. A call in a ternary, a `.map()`, or an agent-chosen tool all behave alike | Bug is structural and live: parser skips 5 node types (`BubbleParser.ts:1384-1394`), nested tool creds come from `new Function` string-parsing that fails to `console.debug` | Reading a literal off a call expression needs no call-site whitelist. Dynamic slugs and provider handoff stay unknown, so static analysis is a predicted overlay only | strong |
| **A8** | Sandbox fills creds at runtime, clients at the top | **Sound** instinct, weaker than the alternative. Your model still puts the credential in the process and still needs routing logic | Removes the credential from the process. Resolution happens server-side from `(userId, toolkit)` | Current AST-rewriting model. Fails silently on unrecognised call sites and on nested tools | Keep one requirement either way: a missing credential must throw at client construction, since a missing connected account surfaces only as `successful: false` | composio wins |
| **A9** | Join credential records to the tools that use them | **Sound.** The ask that most needs runtime truth over static analysis | `logId` on every execute response, `connectedAccountId` as input and queryable entity. The join key is handed to you | Per-invocation `variableId` clones, the right granularity, sourced from static parsing that can miss | Static pass populates a predicted checklist, the execution wrapper writes authoritative rows, reconciliation exposes agent-chosen tools the flow never declared | strong |
| **A10** | Read-only spike, tests in their own folder | **Sound.** Standard spike hygiene | One external write disclosed: an auth config created and deleted to settle Complaint 3 | No BubbleLab or Gluu file modified | N/A | none |
| **A11** | Parseable enough to render for non-technical people | **Sound**, and underrated. Cleanest complementary split in the comparison | Labels: 209/209 tools carry prose names (zero slug-like), 209/209 descriptions, 115/209 `human_description`, 1,069/1,069 toolkits carry a logo and one of 88 categories, plus `destructiveHint` / `readOnlyHint` / `important` tags. **Zero flow structure** | Structure: `dependencyGraph`, `dependencies`, `invocationCallSiteKey`, line numbers, injected invocation dependency map. **Labels only per integration (53), not per operation** | BubbleLab's parser supplies the graph, Composio supplies node labels, logos, categories and risk badges. Render from reconciled A9 data, treat `destructiveHint` as first-class | strongest |

Caveat carried on A11: `scopes` is inconsistent and cannot drive a permissions display alone.
Notion returns human labels (populated on 18 of 56), slack returns scope strings (93 of 100),
googlesheets returns raw Google URLs (53 of 53). A mapping table is required.

### 2.2 Detail per ask

---

### A1. Weigh the Composio layer against Bubble

**Sound?** Reframe. The comparison assumes overlapping scope. The catalog denies it: 1,069 toolkits
and zero databases, warehouses or object stores (§3.8). Any flow reading Postgres or writing to S3
needs a bubble no matter what you decide, so the honest question is where the seam sits.

**Composio answers:** breadth of SaaS coverage and a credential vault. 40 of your 53 third-party
integrations already exist there, most with far more surface (`github` 871 tools against your one
bubble).

**BubbleLab answers:** the execution substrate. Parser, type system, credential model, canvas,
studio. Composio has no equivalent for any of those and does not try.

**Merge:** Composio underneath as credential and transport, BubbleLab on top as the product
surface. Neither replaces the other.

### A2. Get Bubble's structure with Composio's toolset and managed auth

**Sound?** Yes, with one correction that changes what you are buying. "Managed auth" covers 122 of
1,069 toolkits (§3.1). 915 need the user's own OAuth app or API key, and 45 are OAuth-only with no
managed app and no key fallback, including `twitter`, `xero`, `docusign` and `snowflake`. The thing
Composio sells you is the **vault plus normalised transport**, and zero-setup auth applies to a
minority. Buy it for the vault and the breadth.

**Composio answers:** OAuth refresh, token storage, revocation, per-user connection scoping, and
`restrict_to_following_tools` for server-enforced tool limits.

**BubbleLab answers:** 68 `CredentialType` members, per-step binding, credential pools, and a
`SYSTEM_CREDENTIALS` set. All hand-maintained, and the maintenance cost is what prompted this
research.

**Merge:** replace the credential *storage and refresh* layer, keep the credential *model*. Bind a
BubbleLab step to a `connectedAccountId` rather than to a secret, which the execute API supports as
an optional parameter.

### A3. Is what Composio serves identical to the vendor's actual API?

**Sound?** Yes, and this is the question that decides the developer experience. Version management
is beside the point: the SDK resolves to the newest surface by default, so the only thing that
matters is whether that surface equals the vendor's current API.

**Composio answers: the surface trails by a release cycle, and the trailing is mostly benign**
(§3.2, §3.9). Measured against three dated vendor changes: Notion's 2025-09-03 data-source
migration tracked, Slack's `files.upload` retirement tracked with the sunset date documented in the
schema, Notion's 2026-03-11 renames not tracked. Coverage against Notion's own endpoint index is 25
of 28 (89%). **Composio publishes no per-tool "verified against vendor on date X" signal**, so the
trail is invisible: a toolkit stamped last week can encode a contract from before March.

Reading it as decay would be wrong. Composio migrates where a vendor removes things outright
(Slack) and holds a pinned vendor version where the vendor keeps old versions alive (Notion says
indefinitely, GitHub guarantees 24 months). Both responses are correct, and provider drift is close
to theoretical for version-pinned vendors.

**BubbleLab answers:** every bubble is hand-written, so both coverage and currency are your team's
problem, and you already carry that cost across 53 integrations. Nothing about hand-authoring makes
you faster than Composio at tracking a vendor's breaking change.

**Merge:** partial. Composio absorbs the maintenance for the 35 overlapping integrations and gives
you nothing for the 13 it lacks. The gate is per toolkit rather than global: check whether the
vendor versions its API (safe) or retires methods globally (watch the changelog, execute one live
call per tool before shipping).

### A4. Re-test the complaints and gauge how badly they hurt

**Sound?** Yes. Logged complaints are the cheapest available signal on adoption risk.

**Findings (§4):** two of three Composio faults confirmed live, and the severity ranking matters
more than the count. The callback-URI contradiction rates medium and costs one line of defensive
code: read `credentials.oauth_redirect_uri` off the created config and ignore the docs. The hidden
github Personal Access Token rates low and is worth skipping, since github is one of the 122
toolkits with managed OAuth, so the frictionless path is already the default and users reach for
OAuth anyway. User-experience damage concentrates in the connect flow, and that part is yours to
fix rather than Composio's.

The pattern across all three outranks any single complaint: **Composio's descriptive metadata
under-reports what its execution layer accepts.** Auth schemes, tool counts, callback URIs and
vendor currency all show it. Verify by executing rather than by reading the catalog.

### A5. Surface factors you had not considered

**Sound?** Yes. §7 lists twelve. The two most likely to change your answer are the data path (every
payload transits Composio's servers, self-hosting is Enterprise-only) and per-call billing against
your current model of paying the vendor and nothing else.

### A6. Wrap Composio tools inside BubbleLab's type enforcement

**Sound?** Yes, and this is the highest-value ask in the brief. It is also the one the evidence
supports most cleanly.

**Composio answers:** 100% of sampled tools publish full JSON Schema for inputs and outputs, using
`$defs` and `$ref` at `latest` (§3.5). The SDK then throws it away: `ToolExecuteResponse.data` is
`Record<string, unknown>`, so unguarded consumption invites the `as any` your standing rule bans.

**BubbleLab answers:** Zod-validated parameters, compile-time checks, typed errors. The type system
is the product's spine.

**Merge:** strong, and mechanical. Generate Zod plus TypeScript per tool per pinned version, parse
at the boundary, reject `is_deprecated` slugs at generation time. One generated family replaces
per-bubble hand-authoring. Detail in §6.

### A7. AST-detect Composio modules to fix the nested-credential bug

**Sound?** Reframe, and the reframe is good news. Under Composio the problem you are solving stops
existing, because credentials never enter the script (§5.2). AST detection stops being a
correctness mechanism and becomes a **display** mechanism.

**Composio answers:** dissolves the bug. A call inside a ternary, inside a `.map()`, inside an
agent-chosen tool, all behave the same.

**BubbleLab answers:** the bug is structural and live. `BubbleParser` skips instantiation sites
inside `ConditionalExpression`, `ObjectExpression`, `ArrayExpression`, `Property` and
`SpreadElement` (`BubbleParser.ts:1384-1394`), and nested tool credentials come from string-parsing
the `tools` parameter with `new Function`, whose failure path is a `console.debug` and an empty
array.

**Merge:** strong. Detecting a Composio call means reading a string literal off a call expression
rather than rewriting a construction's arguments, so no call-site whitelist is needed. Two limits:
dynamic slugs and provider handoff both resolve to unknown, so static analysis is a predicted
overlay and never the record of truth.

### A8. Sandbox fills credentials at runtime, clients declared at the top

**Sound?** Yes as an instinct, and Composio's version is stronger. Your model still puts the
credential in the process and still needs something to route the right credential to the right
client. Composio removes the credential from the process.

Three caveats on your version, spelled out in §5.3: "clients at the top" is a convention a language
model will eventually break, environment-variable fill reintroduces the exact Firecrawl
name-resolution failure you already hit, and a missing credential has to throw at client
construction rather than fail silent downstream.

**Merge:** Composio wins this one outright. Keep the third caveat as a requirement either way, since
a missing connected account surfaces at execution as `successful: false` rather than at startup.

### A9. Join the credential records to the tools that use them

**Sound?** Yes, and it is the ask that most needs runtime truth rather than static analysis.

**Composio answers:** `logId` on every execute response and `connectedAccountId` as both an input
and a queryable entity. The join key is handed to you.

**BubbleLab answers:** per-invocation `variableId` clones, which your own memory flags as
load-bearing for telemetry, canvas and injection. That is the right granularity, sourced from static
parsing that can miss.

**Merge:** strong. Static AST pass at save time populates a predicted checklist, the execution
wrapper writes the authoritative rows, and reconciliation after each run exposes tools the agent
chose but the flow never declared. Schema sketch in §5.5.

### A10. Keep it read-only, tests in their own folder

**Sound?** Yes, standard spike hygiene. Honoured: no BubbleLab or Gluu file was modified, everything
lives in `composio-eval/`, and the one external write (an auth config, created and deleted) is
disclosed at the top of this doc.

### A11. Parseable enough to render for non-technical people

**Sound?** Yes, and it is underrated in your brief. This turns out to be the cleanest complementary
split in the entire comparison, because each platform holds exactly the half the other lacks.

**Composio answers: labels, and they are good.** Measured across 209 tools at `latest`:

| Signal | Coverage | Example |
|---|---|---|
| Human `name`, prose rather than slug | 209/209, zero slug-like | "Add Sheet to Existing Spreadsheet" |
| `description` | 209/209 | full sentence per tool |
| `human_description` | 115/209 | present on slack and sheets, absent on notion |
| Toolkit logo | 1,069/1,069 | CDN-hosted SVG |
| Toolkit category | 1,069/1,069, 88 distinct | "crm", "documents", "project management" |
| Behavioural tags | on nearly every tool | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `createHint`, `updateHint`, `important` |

The behavioural tags are the part worth taking. `destructiveHint` (13 slack tools, 6 notion tools,
8 sheets tools) drives a warning badge on exactly the steps a non-technical reviewer should look
at twice. `readOnlyHint` drives the inverse reassurance. `important` (39/56 notion, 28/100 slack)
gives a curated shortlist for a picker aimed at non-developers. No hand-authored bubble set
currently carries any of this.

One caveat: `scopes` is inconsistent and cannot drive a permissions display on its own. Notion
returns human labels ("Insert content", populated on 18 of 56), slack returns Slack scope strings
(`chat:write`, 93 of 100), and sheets returns raw Google URLs (53 of 53). Rendering "what this step
is allowed to do" needs your own mapping table.

**Composio does not answer: structure.** Composio sees one call at a time. Ordering, branching,
nesting, loops, and data flow between steps are all invisible to it. A list of tool calls is not a
diagram.

**BubbleLab answers: structure, and only BubbleLab has it.** `ParsedBubble` carries `variableName`,
`className`, `parameters`, `hasAwait`, `dependencies` and `dependencyGraph`, plus
`invocationCallSiteKey` and line numbers, plus the invocation dependency map the injector writes
into the script between `__BUBBLE_INVOCATION_DEPENDENCY_MAP_START__` markers. That is a real graph:
nodes, edges, order.

**BubbleLab does not answer: per-operation labels.** A bubble carries `shortDescription`,
`longDescription` and `alias`, so labels exist per integration (53 of them) rather than per
operation. "GoogleDriveBubble" tells a non-technical reader far less than "Create a document in
Google Drive", and the operation actually invoked lives inside a parameter rather than in the node
name.

**Merge: the strongest in this document.** BubbleLab's parser supplies the graph, Composio supplies
the node labels, logos, categories and risk badges. A non-technical view becomes:

```
[drive logo] Create a document            (creates)
     |
[notion logo] Query data source           (read-only)
     |
[slack logo] Send message to #sales       (creates, external)
```

Every element on the right is already published by Composio. Every element on the left is already
computed by BubbleLab. Nothing new has to be invented, and the combination gives a non-technical
reviewer something neither platform can render alone.

Two design rules follow if you go this way. Render from the reconciled A9 data rather than from
static parsing alone, so agent-chosen tools appear rather than vanish. And treat `destructiveHint`
as a first-class UI signal rather than a tag, since it is the one field that lets a non-technical
person spot the step that deletes something.

---

## 3. Quality check: is Composio actually current with the APIs it wraps?

### 3.1 Catalog scale, measured

| Measure | Value (2026-08-01) | Value in your 2026-07-01 snapshot |
|---|---|---|
| Toolkits | 1,069 | 1,000 |
| Summed `meta.tools_count` | 44,437 | not recorded |
| Triggers (webhook/poll sources) | 351 | not recorded |
| Toolkits with a Composio-managed OAuth app | 122 | not recorded |
| Toolkits requiring your own OAuth app or key | 915 | not recorded |

Auth scheme distribution across all 1,069:

```
API_KEY 883 | OAUTH2 188 | NO_AUTH 32 | BASIC 31 | S2S_OAUTH2 16 | DCR_OAUTH 10
BEARER_TOKEN 5 | OAUTH1 1 | BASIC_WITH_JWT 1 | GOOGLE_SERVICE_ACCOUNT 1 | SAML 1
```

The "managed auth" claim needs a precise reading. Of 202 toolkits carrying an OAuth-family
scheme, Composio hosts its own app for 122 (60%). For the remaining 80 the user registers an
OAuth app themselves, and 35 of those offer an API-key fallback. That leaves **45 toolkits that
are OAuth-only with no managed app and no key escape hatch**, including `twitter`, `xero`,
`docusign`, `snowflake` and `netsuite`. Three of those five are already BubbleLab bubbles, so the
painful cases are not a hypothetical tail for you.

For the 883 API_KEY toolkits, "bring your own credential" means the user pastes their own key.
That is the same experience your bubbles already give, so Composio adds no auth burden there. It
adds transport and schema instead.

### 3.2 Fidelity: does what Composio serves match the vendor's actual API?

This is the question that decides the developer experience, so it gets measured rather than
asserted. Version management is a side issue: the SDK already resolves to `latest` by default
(`CONFIG_DEFAULTS.toolkitVersions = "latest"`, confirmed in
`gluu/backend/node_modules/@composio/core/dist`), so you get the newest surface Composio has
without doing anything. The real question is whether that newest surface equals the vendor's
current API.

**Answer: no, and the gap is a time lag of roughly six to twelve months.** Three tests against
dated vendor changes, all run against `latest`:

| Vendor change | Shipped | Age | Composio at `latest` |
|---|---|---|---|
| Notion replaces database query with data sources | 2025-09-03 | 11 months | **Tracked.** `NOTION_QUERY_DATA_SOURCE` present, 156 `data_source` references |
| Slack retires `files.upload` for `files.completeUploadExternal` | 2025-11-12 | 9 months | **Tracked.** The upload tool's schema documents both paths and names the sunset date |
| Notion renames `archived`, replaces `after` with `position` | 2026-03-11 | 5 months | **Not tracked.** See below |

The third row is the informative one. Composio's `notion` toolkit carries version `20260730_00`,
stamped nine days before these probes, and still serves the pre-2026-03-11 shape:

```
'after' parameter  present on 9 append-style tools, 'position' on none of them
'in_trash'  52 mentions   'archived' 122 mentions   (migration started, not finished)
create-meeting-note, query-meeting-notes, retrieve-async-task   absent
```

So a toolkit stamped with last week's date encodes an API contract from before March. **The version
stamp tells you when Composio rebuilt, not which vendor changes landed.** No field anywhere in the
API tells you the second thing.

Coverage is the better half of the story. Mapping Composio's 56 Notion tools against the 28
operational endpoints in Notion's own reference index gives **25 of 28 covered (89%)**, plus 31
convenience wrappers with no 1:1 endpoint (`NOTION_APPEND_TABLE_BLOCKS`, `NOTION_INSERT_ROW_FROM_NL`
and similar). Breadth is good. Currency trails.

**Reading the lag correctly, which matters more than measuring it.** Calling this decay overstates
it. Notion versions its API by request header, and the observed shape pins Composio to a specific
version rather than showing rot: data sources require `Notion-Version` 2025-09-03 or later, and
`position` requires 2026-03-11 or later. Composio ships the first and not the second, so it sits on
exactly 2025-09-03. On that version `after` and `archived` are the correct field names, not stale
ones. Notion supports old versions indefinitely (§3.9), so this is a supported contract that keeps
working, and the cost is missing new capability (meeting notes, async tasks) rather than pending
breakage.

That inference comes from the schema shape rather than from watching the wire, since Composio does
not publish which vendor version it targets. Confirm it by execution if you depend on it.

Whether the trail ever bites depends on the vendor's versioning model, which splits cleanly into
two classes. §3.9 measures both.

One mechanical footnote, relevant only if you write your own HTTP layer instead of using the SDK.
Raw `GET /api/v3/tools` with no version parameter returns the frozen base snapshot `00000000_00`,
which for Notion means 28 tools with zero data-source support, a year behind. The SDK protects you
and hand-rolled HTTP does not. The same toolkit reports three different tool counts depending on
where you look: catalog metadata 53, base 28, `latest` 56.

### 3.3 Freshness across the catalog

`meta.updated_at` by month, all 1,069 toolkits:

```
2025-03    3    2025-11   12    2026-05   12
2025-07  472    2025-12   29    2026-06    4
2025-08   60    2026-01   10    2026-07   40
2025-09  164    2026-02  116
2025-10  110    2026-03   29
```

472 toolkits (44%) carry an `updated_at` of 2025-07. Read that with care. Nearly every toolkit
also carries a `meta.version` stamped `20260[67]xx`, so the two fields disagree by a year. My
reading: `version` tracks a platform-wide rebuild and `updated_at` tracks content edits. Neither
field alone tells you whether a given toolkit tracks its vendor's current API. **Composio publishes
no per-tool "verified against vendor API on date X" signal**, and that absence is the honest answer
to "are they up to date with the actual tool's offerings": you cannot tell from the metadata, and
you have to test per toolkit.

The Slack upload case deserves a note, since it shows Composio doing the right thing in a way the
metadata hides. `SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK` keeps the parameter names of the retired
`files.upload` (`file`, `content`, `channels`, `filetype`, `initial_comment`), so it looks stale
from the outside. Reading the output schema at `latest` shows otherwise:

> "Supports both files.upload (deprecated, sunset 2025-11-12) and files.completeUploadExternal
> (recommended)."

Composio migrated the implementation and preserved the parameter facade. That is the behaviour you
want from a marketplace layer: the vendor's breaking change did not become your breaking change.
The same tool at the base version carries no such handling, which is the mechanism described in
§3.2.

### 3.4 Deprecation churn inside a toolkit

26 of Slack's 133 base-version tools carry `is_deprecated: true`, including
`SLACK_CHAT_POST_MESSAGE` and `SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL`, both superseded by
`SLACK_SEND_MESSAGE`. The deprecation notice lives in the description text ("Deprecated: ... use
`send message` instead") and the `deprecated` object on the response carries no replacement
pointer, only a duplicated display name and logo.

This matters for a code-generating agent. A model with older training data will emit
`SLACK_CHAT_POST_MESSAGE`, the call will succeed, and you inherit a dependency on a tool Composio
plans to remove. Any wrapper you generate should reject deprecated slugs at build time rather than
pass them through.

### 3.5 Schema quality, and this part is genuinely good

Every tool publishes a full JSON Schema for inputs **and** outputs. Sampled at `latest`:

| Toolkit | Tools | With a typed output schema | Median schema size | Toolkit total |
|---|---|---|---|---|
| notion | 56 | 56 (100%) | 19,446 bytes | 1.17 MB |
| googlesheets | 53 | 53 (100%) | 8,483 bytes | 650 KB |
| slack | 100 | 100 (100%) | 4,953 bytes | 719 KB |

Latest-version schemas use `$defs` and `$ref`, so nested shapes resolve to named definitions.
`NOTION_QUERY_DATA_SOURCE` returns a referenced `Page` definition with typed `id`, `url`, `icon`,
`cover`, `parent`, `archived` and `in_trash` fields, including a `const: "page"` discriminator.

**This is the finding that makes your type-enforcement thesis viable.** Composio hands you enough
schema to generate Zod validators and TypeScript types per tool, per pinned version, without
hand-authoring anything.

The catch sits in the SDK, not the API. `ToolExecuteResponse` in `@composio/core` is declared as:

```ts
{ data: Record<string, unknown>; error: string | null; successful: boolean;
  logId?: string; sessionInfo?: unknown }
```

`data` is `Record<string, unknown>`. Consuming a Composio result in TypeScript gives you `unknown`
and invites the exact `as any` your standing rule bans. The fix is codegen, covered in §6.

The other catch is weight. Notion's toolkit totals 1.17 MB of schema, roughly 290,000 tokens. Ten
Notion tools in an agent's context costs about 50,000 tokens before any work happens. Composio's
answer is Tool Router, a Model Context Protocol (MCP) endpoint that loads tools on demand per
session. Your answer is different and better suited to your product: a bubble exposes an
operation-shaped facade over many underlying calls, so the agent sees one small schema.

### 3.6 Server-side validation is thin

`POST /auth_configs` for `github` with `authScheme: BEARER_TOKEN` and `credentials: {}` returned
`201` and created a working auth config. No required-field check fired. Compare that against the
invalid-enum case, which returned a clean 400 listing all 14 valid schemes.

Read together with the Gluu bug you already logged (an array passed into a string-only credentials
field, shipped because `composio().authConfigs as any` removed the compile check): **Composio will
not catch credential-shape mistakes for you.** Validation has to live on your side. That is an
argument for the wrapper, not against Composio.

### 3.7 Operational envelope

| Dimension | Value | Source |
|---|---|---|
| Rate limit, Starter/Hobby | 2,000 requests per minute per organisation | docs |
| Rate limit, Growth | 10,000 requests per minute per organisation | docs |
| Budget scope | Shared across every authenticated endpoint | docs |
| Headers | `X-RateLimit`, `X-RateLimit-Remaining`, `X-RateLimit-Window-Size`, `Retry-After` | docs |
| Pricing | Free 20K calls/mo; $29/mo 200K; $229/mo 2M | third-party pricing pages, verify with sales |
| Overage | ~$0.299 per 1,000 calls (Starter), ~$0.249 (higher tier) | same, verify |
| Self-host | Enterprise-only, custom quote (Virtual Private Cloud / on-prem) | docs and reviews |

Two things follow. The rate limit is per organisation and shared with tool listing, so a busy
studio that re-fetches schemas competes with its own executions. Cache tool definitions locally.
And every tool call is a billable unit, which changes the economics of a chatty agent loop against
your current model of "the bubble calls the vendor directly and you pay the vendor".

### 3.8 Coverage against your existing bubbles, counted from the registry

An earlier draft of this section undercounted BubbleLab. The first pass listed flat `.ts` files in
`service-bubble/`, and most bubbles are directories (`slack/slack.ts`, `notion/`, `hubspot/`), so
roughly a third of them went missing. Corrected by walking directories and flat files together and
counting `operation: z.literal(...)` discriminants per bubble:

| Measure | BubbleLab | Composio |
|---|---|---|
| Integrations | 53 third-party (61 service bubbles including `http`, `ai-agent`, `storage`) | 1,069 toolkits |
| Callable operations | **536** | **44,437** catalog-reported |
| Overlap | 40 of 53 present in Composio | |
| Credential types | 68 `CredentialType` members | 14 auth schemes across all toolkits |

**The claim holds: Composio carries roughly 80x more callable operations and 20x more
integrations.** Per overlapping integration, Composio runs 1x to 26x deeper:

| Bubble | Bubble ops | Composio tools | Ratio |
|---|---|---|---|
| `docusign` | 13 | 335 | 26x |
| `stripe` | 20 | 425 | 21x |
| `zendesk` | 23 | 451 | 20x |
| `hubspot` | 21 | 244 | 12x |
| `slack` | 19 | 158 | 8x |
| `asana` | 33 | 153 | 5x |
| `google-sheets` | 11 | 45 | 4x |
| `notion` | 18 | 53 | 3x |
| `gmail` | 18 | 61 | 3x |
| `airtable` | 11 | 24 | 2x |
| `telegram` | 13 | 18 | 1x |

Two caveats keep the comparison honest. Composio's 44,437 is the catalog field, which agrees with
neither the base nor the `latest` tool listing (§3.2), so treat it as an order of magnitude rather
than a count. And a bubble operation is not equivalent to a Composio tool: bubble operations are
curated and often composite, while Composio's counts include deprecated tools and near-duplicates
(26 of Slack's 133 base tools are deprecated). The gap is real at every ratio above 2x. It is not
precisely 80x.

**Absent from Composio, all 13 verified against the catalog:** `postgresql`, `redshift-data`, `s3`,
`insforge-db`, `clerk`, `sortly`, `memberful`, `assembled`, `slab`, `luma`, `sendsafely`,
`kraken-spot-api` (only `kraken_io`, an unrelated image service, exists), `agi-inc`. Near-matches
that do exist under a different slug: `bigquery` as `googlebigquery`, `browserbase` as
`browserbase_tool`, `granola` as `granola_mcp`, `databricks-sql` as `databricks`.

Strip the near-matches and the residue is a clean category boundary: **databases, warehouses,
object storage, and small or private SaaS**. Composio wraps mainstream SaaS APIs. It does not wrap
your data plane, and it will never carry your own `agi-inc`. Keep those bubbles whatever you decide.

### 3.9 Does the trail ever bite? Vendor removal base rates

§3.2 measured that Composio's surface trails its vendors. This section asks the question that
decides whether the trailing matters: **do these vendors actually remove things?**

Measured against four vendors' own published policies and changelogs, the answer splits into two
classes, and the class is a property of the vendor rather than of Composio.

**Class A, version-pinned. The old contract keeps working.**

| Vendor | Policy | Removal record |
|---|---|---|
| **Notion** | "We don't currently have any plans to stop supporting older API versions. If this changes we'll communicate this with all affected users and provide a time window and migration guidance." Additive changes reach pinned versions without an upgrade | No version has been retired |
| **GitHub** | Dated versions (current `2026-03-10`). A previous version is supported **at least 24 months** after its successor ships. Sunset returns `410 Gone` | Removals happen only at version boundaries, and only to fields already deprecated for years: `has_downloads` (deprecated 10+ years), `authorizations_url` (deprecated since 2020), `use_squash_pr_title_as_default` |

Your read on github is correct, and the policy backs it. GitHub does remove things, on a 24-month
floor, after multi-year deprecation, and only when you move versions. Notion is stronger still: its
stated position is indefinite support.

**Class B, global retirement. No version escape hatch.**

| Vendor | Removal record 2024-2026 |
|---|---|
| **Slack** | `files.upload` retired outright (sunset 2025-11-12), legacy custom bots discontinued (2025-03-31), classic apps sunset (2026-11-16). Six breaking changes across the period, most of them actual removals |
| **Google** | Turns APIs down rather than versioning them: Email Settings API fully off 2017, Apps Script Contacts service off 2025-01-31. Long runways, real endings |

**The synthesis, and it reads well for Composio.** Composio migrated Slack's upload path and did
not migrate Notion's renames. Both choices are correct. Slack forced the migration by removing the
method for everyone; Notion did not, because the old version stays supported. Composio moves when
the vendor forces it and holds a stable pin when the vendor does not. That is competent marketplace
behaviour rather than neglect, and it is the opposite of the decay reading my §3.2 measurement
suggested on its own.

**So, is provider drift theoretical?** For the vendors you named, close to it:

- **GitHub:** theoretical for at least 24 months, and confined to fields deprecated for years.
- **Notion:** theoretical indefinitely by Notion's own stated policy.
- **Slack, Google and Class B generally:** real, already materialised once, and Composio absorbed
  it on your behalf.

Practical rule rather than a blanket answer: before you depend on a toolkit, check which class its
vendor is in. Class A needs no ongoing vigilance. Class B needs the vendor's changelog on a watch
list and one live call per tool before shipping. Your `postgresql`, `s3` and warehouse bubbles are
outside this question, since Composio does not carry them at all (§3.8).

---

## 4. Your three complaints, re-tested today

### Complaint 1: version confusion around the OAuth callback URI

**Still founded, and worse than when you filed it.**

Live evidence, read from your own auth configs:

```
ac_sNwvl2uVlB95  github  BYOC       oauth_redirect_uri = .../api/v1/auth-apps/add
ac_i59Dyk0WqVKV  slack   MANAGED    oauth_redirect_uri = .../api/v1/auth-apps/add
```

Composio's current documentation tells you to register
`https://backend.composio.dev/api/v3.1/toolkits/auth/callback`.

The second row is the sharp part. `ac_i59Dyk0WqVKV` has `is_composio_managed: true`, so **Composio
created it, not your SDK**. Your earlier conclusion that the v1 stamp came from SDK 0.10.0 does not
survive: Composio's own managed configs carry the v1 callback too. The docs and the running system
disagree, and the disagreement is not yours to fix by upgrading.

Practical rule, unchanged and now confirmed: read `credentials.oauth_redirect_uri` off the created
auth config and show that value. Ignore the docs on this point.

Related live risk worth checking separately: `POST /api/v3/connected_accounts` was retired for
Composio-managed OAuth on 2026-07-03 for all remaining organisations, with migration to
`POST /api/v3/connected_accounts/link`. Gluu calls `connectedAccounts.initiate` at
`backend/src/lib/integrations/composio/client.ts:451` and `connectedAccounts.link` at two other
sites. `initiateConnection` takes any `authConfigId`, and you hold at least one managed config
(`ac_i59Dyk0WqVKV`, slack). Verify that path still works before you rely on it.

### Complaint 2: tedious OAuth app setup, no instructions

**Still misattributed, and the fix is still yours.**

The toolkit detail endpoint returns the field list Composio expects, and it is precise:

```
github  OAUTH2  auth_config_creation required=[client_id, client_secret]
                                   optional=[oauth_redirect_uri, scopes]
                connected_account_initiation required=[]
```

Composio tells you the required fields and returns the callback value. Composio does not tell the
end user to register the OAuth app first, and does not sequence the steps. That is a product gap
in your onboarding, the same conclusion you reached on 2026-07-01. Nothing changed.

### Complaint 3: the easy, granular login path is hidden

**Technically confirmed. Downgraded to low severity on your call, and the call is right.**

Both the toolkit list and the toolkit **detail** endpoint report github as OAUTH2 only:

```
GET /toolkits/github -> auth_config_details: [('OAUTH2', 'github_oauth')]
                        composio_managed_auth_schemes: ['OAUTH2']
```

A `BEARER_TOKEN` auth config for github nonetheless created cleanly (`ac_4X6KwN_SUuL7`, since
deleted). A fine-grained GitHub Personal Access Token (PAT) works, needs no OAuth app, needs no
callback registration, and scopes per repository rather than the all-repos `repo` scope OAuth
grants.

Severity, revised: **low.** github is one of the 122 toolkits with a Composio-managed OAuth app, so
the default path is a consent click with no setup at all. Users reach for OAuth, the OAuth path is
the frictionless one here, and the hidden PAT option is an optimisation for a minority who want
per-repository scoping. Building a picker around it would be effort spent on an edge.

The finding keeps its value as **evidence, not as a feature request**. It is the third instance of
one pattern: Composio's descriptive metadata under-reports what its execution layer accepts. Auth
schemes under-report (this complaint), tool counts disagree across three fields (§3.2), and the
documented callback URI contradicts the live one (Complaint 1). The pattern is what to design
around. The github PAT itself is not worth chasing.

**Complaints summary.** Two of three Composio faults confirmed against the current API, ranked by
what they will actually cost you:

| Complaint | Confirmed | Severity | Cost to you |
|---|---|---|---|
| 1. Docs contradict the live callback URI | Yes, on managed configs too | **Medium** | One-time: read `credentials.oauth_redirect_uri` off the created config and ignore the docs |
| 2. No setup sequencing for the user | Misattributed | Medium | Yours to fix in onboarding, unchanged since 2026-07-01 |
| 3. Auth schemes under-reported | Yes | **Low** | Skip it. github has managed OAuth, so the easy path is already the default |

The pattern across all three predicts what else will bite you, and it outranks any individual
complaint: **Composio's descriptive metadata under-reports what its execution layer accepts.** Auth
schemes, tool counts, callback URIs and vendor currency (§3.2) all show the same gap between what
the API says and what the API does. Design for discovery by attempt, and verify by executing rather
than by reading the catalog.

---

## 5. The nested-credential problem, and why Composio makes it disappear

### 5.1 What actually breaks in BubbleLab today

Credential injection is source rewriting. `BubbleInjector.injectCredentials`
(`packages/bubble-runtime/src/injection/BubbleInjector.ts:447`) walks the parsed bubbles, builds a
`credentialMapping`, writes a `credentials: {...}` literal into each bubble's parameters, and
re-emits the script through `reapplyBubbleInstantiations()`.

That design has a hard prerequisite: the parser has to recognise the instantiation site. It
refuses several, by construction. `BubbleParser` marks a call as
`isInComplexExpression` and skips it when the parent node is a `ConditionalExpression`,
`ObjectExpression`, `ArrayExpression` outside `Promise.all`, `Property`, or `SpreadElement`
(`packages/bubble-runtime/src/extraction/BubbleParser.ts:1384-1394`).

Two failure classes follow, and you have hit both:

1. **Unrecognised call site.** A bubble inside a ternary validates green, runs with no credentials,
   and fails without an error (your flow 80 Google Doc case).
2. **Nested tool.** Tools reached through an agent get credentials through a separate path,
   `extractToolCredentials` parsing the `tools` parameter with `new Function('return ' + value)`
   (`BubbleInjector.ts:287-354`). String-parsing a TypeScript expression fails on anything
   non-literal, and the catch block swallows it: `console.debug`, empty array, no user-visible
   signal.

Both are the same root cause. **Credential correctness depends on static recognition of a syntactic
form.** Every new call shape is a new hole, and every hole fails silently.

### 5.2 What Composio's model does instead

A Composio call carries no credential:

```ts
const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
await composio.tools.execute('SLACK_SEND_MESSAGE', {
  userId: 'user_123',
  arguments: { channel: '#general', text: 'hi' },
});
```

Composio resolves `(userId, toolkit)` to a connected account server-side and attaches the token at
its edge. Nesting depth stops mattering, because there is nothing to inject at any depth. A call
inside a ternary, inside a `.map()`, inside a tool the agent picked at runtime, all behave the same.

This is exactly the property you described wanting, and Composio reaches it by a stronger route
than the one you proposed. Your sandbox model (instantiate clients at the top of the script inside
an environment that fills credentials) still requires the credential to exist in the process and
still requires something to decide which credential goes to which client. Composio removes the
credential from the process entirely.

`ToolExecuteParams` also accepts an optional `connectedAccountId`, so per-step account selection
survives. Your per-step binding model maps onto it directly: bind a step to a connected account ID
rather than to a secret.

### 5.3 Assessing your sandbox proposal on its own terms

Your proposal: the agent writes a script, the sandbox fills credentials at runtime, all clients get
instantiated at the top, and nesting stops mattering.

The proposal is sound and it is a real improvement over AST rewriting. Three caveats:

1. **"At the top" is a convention, and conventions written by a language model decay.** The current
   system fails on ternaries because the agent wrote a ternary. Nothing stops the agent from
   constructing a client inside a loop body. Turning the convention into an invariant needs a
   linter that rejects client construction outside the prologue, which is the same class of work as
   widening the call-site whitelist, done once instead of per syntax form.
2. **Environment-variable injection reintroduces the resolution problem you already have.** Your
   Firecrawl case is exactly this: detection worked, the credential was classified `SYSTEM`, and
   the value came from an empty and misnamed `FIRE_CRAWL_API_KEY`. A sandbox that fills
   `process.env` inherits that failure mode, because name-to-value resolution is still a lookup
   that can miss in silence.
3. **A missing credential must fail loudly at instantiation.** Both current failures are silent.
   Whatever fills the environment should throw at client construction when a required credential is
   absent, before any business logic runs.

Composio satisfies (1) and (2) by construction and leaves (3) to you, since a missing connected
account surfaces as `successful: false` at execution rather than at startup. A pre-flight check
that lists connected accounts for the flow's toolkits before the first call closes that gap.

### 5.4 Can AST detection find Composio tool usage? Measured, not asserted

Yes. A working prototype lives at `ast-detector/`, built on the TypeScript compiler's own parser
and scored against a corpus of 22 cases. Run it with `node ast-detector/run.mjs`.

| Suite | Cases | Result |
|---|---|---|
| Realistic usage patterns | 14 | **14/14** |
| ... of which are call-site shapes BubbleLab's injector refuses | 11 | **11/11** |
| Adversarial, written to break the detector | 5 | **5/5** |
| Negative controls, must detect nothing | 3 | **3/3**, no false positives |

The structural reason it works is worth stating plainly, because it explains why this succeeds
where the credential injector fails.

Detecting a bubble means finding a **construction whose arguments you then rewrite**. Detecting a
Composio call means finding a **call expression and reading a string literal**. Rewriting is what
forces the call-site whitelist at `BubbleParser.ts:1384-1394`. Reading imposes no such constraint,
so the surrounding expression context stops mattering. Confirmed on all of these, each of which the
current injector skips:

```
ternary branches          .map() callback bodies       object-literal property values
inside a helper function  wrapped in try/catch         for-of over a slug array
const slug indirection    aliased import (`as`)        template literal with no expressions
```

**The weak spot moved, and that is the interesting finding.** The detector never struggles with
call-site context. It struggles with **client binding**: how the identifier before `.tools.execute`
got its value. Four bindings broke the first version, and all four are recoverable:

| Binding pattern | First version | Fix |
|---|---|---|
| `const composio = client()`, factory returns `new Composio()` | missed | track functions returning a Composio construction |
| `const { tools } = composio` | missed | bind destructured `tools` |
| `this.composio` as a class field | missed | relaxed tier, below |
| loop over a slug array while other arrays exist | **over-reported** | bind the loop variable to exactly the array it iterates |

The over-report is the one worth dwelling on. The first version scanned every const string array in
scope and attributed all of them, so a script with an unused array of Notion slugs reported Notion
tools it never called. Precision failures are more dangerous than recall failures here, since a
credential checklist that lists connections a flow does not use trains the user to ignore it.

**Two tiers, and the relaxed one costs nothing.** Strict requires the receiver to trace back to
`new Composio(...)`. Relaxed accepts any `<receiver>.tools.execute(...)` once the file imports
`@composio/core`. Measured across the corpus, relaxed catches `this.composio` that strict cannot
trace, and the import gate keeps it from firing on unrelated code: all three negative controls stay
clean, including a script that calls `agent.tools.execute('SOME_OTHER_THING')` with no Composio
import anywhere.

**Two limits remain, and they are limits of the problem rather than of the parser:**

- **Dynamic slugs.** `execute(slug, ...)` where `slug` arrives at runtime, or is concatenated
  (`'SLACK_' + verb`). Correctly reported as unresolved with the expression text and line number.
- **Provider handoff and toolkit filters.** `tools.get(userId, { toolkits: ['slack'] })` names a
  toolkit, and the model picks the tool at runtime. The detector records the toolkit and flags that
  it does not resolve to specific tools.

Both cases produce a **typed unresolved record** rather than silence. That single property is the
difference from the current injector, which swallows its failure into a `console.debug` and an
empty array. A flow that cannot be statically resolved should say so on the canvas.

Hence the design rule for §5.5: **static AST for pre-run display, execution log for truth.** Never
present the static list as the authoritative record of what ran.

### 5.5 The database join you described

Your instinct is right and Composio gives you the join key for free. `ToolExecuteResponse` carries
`logId`, and `connectedAccountId` is both an input parameter and a queryable entity.

A workable shape, offered as a sketch rather than a schema to implement now:

```
flow_tool_usage
  flow_id, tool_slug, toolkit_slug, source ('static' | 'runtime'), first_seen, last_seen
flow_connection_usage
  flow_id, connected_account_id, toolkit_slug, user_id, last_used_at
execution_tool_call
  execution_id, flow_id, tool_slug, connected_account_id, composio_log_id,
  successful, duration_ms, called_at
```

`execution_tool_call` is written from the execution wrapper on every call and is the source of
truth. `flow_tool_usage` gets the static AST pass at save time so the user sees a credential
checklist before the first run, marked as predicted. Reconcile after each run: a runtime slug with
no static row means the agent chose a tool the flow did not declare, and that is a fact worth
showing rather than hiding.

The user-facing payoff is the thing your current Setup tab cannot do reliably. Today the checklist
comes from static detection alone, so a nested tool that the parser missed shows nothing and the
run fails in silence. With runtime rows, the second run shows the truth even where static analysis
gave up.

### 5.6 Could imports solve this on the BubbleLab side, with no Composio at all?

A bubble class is the outermost wrapper and it gets imported at the top of the flow, so the import
list looks like a nesting-proof signal: it names every bubble the flow can possibly touch,
regardless of how deep the instantiation sits. Worth testing rather than reasoning about. Prototype
at `ast-detector/bubble/`, 12 cases, three strategies scored against each other.

| Strategy | Exact | False positives | Missed |
|---|---|---|---|
| Import list only | **0/12** | **95** | 12 |
| String-eval of the tools array (today) | 8/12 | 0 | 7 |
| AST walk of `new XBubble()` plus the tools array | **12/12** | **0** | **0** |

**Imports fail for two independent reasons, and the second one is fatal.**

First, the generated preamble is boilerplate. Measured on a real generated flow
(`flow10-generated.ts` in the project root): **73 bubble classes imported, 4 instantiated.** A 95%
over-report. A credential checklist built from that list would ask the user to connect Stripe,
Zendesk, Jira and 66 others for a flow that touches Gmail, Sheets and Telegram.

Second, and this is the one that ends the idea: **a nested agent tool has no import.** Tools reach
an agent by name, resolved from the factory registry at runtime:

```ts
const agent = new AIAgentBubble({ message: m, tools: [{ name: 'web-search-tool' }] });
```

`WebSearchTool` is never imported into the flow. The string `'web-search-tool'` is the only trace,
and `BUBBLE_CREDENTIAL_OPTIONS` maps it to `FIRECRAWL_API_KEY`
(`credential-schema.ts:3132`). Import-based detection cannot see nested tools in principle, not
because of a parser limitation. That is precisely the case you most want covered.

**The AST does solve it, through the tools array rather than the imports.** Four shapes today's
string-eval cannot read, all of which an AST walk handles:

| Shape | Today | AST |
|---|---|---|
| `tools: TOOLS` where `TOOLS` is a const array | missed | resolved |
| `tools: [...BASE, { name: 'chart-js-tool' }]` | missed | resolved, both parts |
| `tools: cond ? [{...}] : [{...}]` | missed | resolved, both branches listed |
| `tools: [{ name: SEARCH }]` via a const string | missed | resolved |
| `tools: pickTools(intent)` | missed, silently | **typed unresolved record** |

The cause of those four is the same as everywhere else in this document.
`new Function('return ' + toolsParam.value)` (`BubbleInjector.ts:304-328`) evaluates the parameter's
source text, so anything referencing a variable throws, and the catch block writes `console.debug`
and returns an empty array. Reading the same expression as a syntax tree resolves it, and the one
genuinely dynamic case produces a record with kind, line and expression text rather than silence.

**Keep detection and injection separate, because they have different answers.** This section is
about detection: which credentials does this flow need. Detection is fully solvable by AST for both
direct bubbles and nested tools. Injection, meaning getting the secret into the running instance,
is a different problem: for direct bubbles it still needs a recognised call site, since the injector
rewrites the instantiation. For nested tools injection already works, because the agent passes
credentials down to its tools at runtime rather than through source rewriting.

So the honest scope of an AST fix on the BubbleLab side, with no Composio involved: **it closes the
nested-tool detection gap completely, and it leaves the direct-bubble call-site rewriting problem
exactly where it is.** Composio's contribution is removing the second problem, since a flow with no
credentials in its source has nothing to rewrite.

---

## 6. Wrapping Composio in BubbleLab's type enforcement

Feasible. Here is the concrete chain, given what §3.5 measured.

**Generate, do not hand-write.** For each toolkit and pinned version, pull tool definitions, and
emit per tool: a Zod input schema from `input_parameters`, a Zod output schema from
`output_parameters` (resolving `$defs` and `$ref`), and a TypeScript type from each. 100% of
sampled tools carry both, so coverage is total rather than best-effort.

**Parse at the boundary.** The SDK returns `data: Record<string, unknown>`. Your wrapper runs
`OutputSchema.parse(result.data)` and returns a typed value. That satisfies your standing rule
against `as any` at the one place it would otherwise be unavoidable, and it converts a silent shape
drift into a loud parse error at the call site.

**Pin the version, and treat a version bump as a code change.** Regenerate against a new pinned
version, diff the generated types, and let the compiler point at every flow that breaks. Composio's
own guidance says to pin when code parses the output, and generated wrappers are that case.

**Curate the facade.** Do not expose 871 GitHub tools. Your bubbles are operation-shaped, and that
shape is the product. Select tools per toolkit and wrap them behind a bubble whose schema stays
small enough for an agent to hold. Composio's `restrict_to_following_tools` and `tool_access_config`
fields on an auth config enforce the same restriction server-side, so the curation holds even if a
generated script asks for something outside the set.

**Reject deprecated slugs at generation time.** `is_deprecated` is on every tool record. Fail the
codegen rather than shipping a wrapper around a tool Composio plans to remove.

What you gain: one generated family covers dozens of integrations, replacing the per-bubble
hand-authoring that produced 53 integrations, 536 operations and 68 credential types. What you keep: the parser,
the type system, the provenance model, the studio.

---

## 7. Factors your framing has not covered yet

1. **Data path.** Every Composio call routes payloads through Composio's servers. Customer email
   bodies, CRM records and documents transit a third party. Today your bubbles call vendors
   directly. Self-hosting is Enterprise-only, so this is a commercial question, not a technical one,
   and it will come up in the first security review a customer runs on you.
2. **Per-call cost changes agent economics.** Composio bills per tool call. An agent that retries,
   paginates or polls multiplies that. Your current model pays the vendor and nothing else.
3. **Latency and one more hop.** Studio to your API to Composio to the vendor, plus Composio's own
   normalisation. Unmeasured here. Measure before piloting anything interactive.
4. **Failure surface widens.** Composio outages, rate limits and vault expiry become your outages.
   `successful: false` plus a string `error` gives you less structure than a bubble's typed errors,
   and your Gluu explainer already depends on structured error signals.
5. **Token weight of schemas.** 1.17 MB for Notion alone. Curation is mandatory, not an
   optimisation.
6. **Triggers are thin.** 351 triggers across 1,069 toolkits. If BubbleLab flows are event-driven,
   most Composio toolkits give you polling and nothing more.
7. **Credential ownership and exit.** Connected accounts live in Composio's vault. Migrating away
   later means re-consenting every user. Ask what an export looks like before you depend on it.
8. **The `userId` mapping is a modelling decision, not a detail.** Composio keys connections by
   `userId`. Your model binds credentials per step, and one BubbleLab user can hold several accounts
   for one provider (your credential-pool code exists for this). Reconcile the two models before
   writing code, since it decides whether you use `userId` alone or pin `connectedAccountId` per
   step. Your existing per-step model points at the second.
9. **Concentration risk.** Composio is a venture-funded startup shipping breaking API changes on
   dated deprecation schedules, three of which landed in the last quarter. Read §4's retired
   `connected_accounts` endpoint as the ongoing cost of the dependency, not a one-off.
10. **Two migrations, not one.** Gluu already runs Composio at 0.10.0 against a 0.14.1 current.
    Adopting Composio in BubbleLab means maintaining that dependency in two products, or unifying
    them, and unifying is a larger project than the pilot.
11. **Composio does not solve the call-site problem for bubbles.** Mixing generated Composio
    wrappers with existing bubbles in one script leaves the AST injector in charge of the bubbles.
    A hybrid flow keeps both failure modes until the bubbles migrate too.
12. **Vendor rate limits still apply underneath.** Composio's 2,000 per minute sits on top of
    Slack's and Notion's own limits, and Composio's error surface for a vendor 429 is a string.

---

## 8. Recommended next step: a bounded pilot, not a decision

The evidence supports one experiment rather than a commitment. Scope it to answer the three
questions the desk research cannot.

**Pilot: one toolkit, generated end to end.** Pick `notion`, since §3.2 already proves it carries a
measurable fidelity lag, so it tests the worst realistic case rather than a flattering one.

Answer these, in order:

1. **Does generated typing hold?** Emit Zod and TypeScript from `notion`, execute three tools
   against a real connected account, and confirm `OutputSchema.parse` succeeds on live payloads.
   Failure here kills the thesis outright, so run it first.
2. **Confirm the version pin.** Call an append-block tool with the `after` parameter Composio still
   ships, against a real Notion workspace. §3.9 predicts it passes, since Composio appears pinned to
   `Notion-Version` 2025-09-03 and Notion supports old versions indefinitely. Passing confirms the
   pin is a stable contract. Failing means Composio sends a newer version header with older field
   names, which would be a genuine defect and changes the recommendation.
3. **What does the round trip cost?** Measure end-to-end latency for one write against the same
   write through the existing `notion` bubble. Record the difference.
4. **Does the provenance join work?** Capture `logId` and `connectedAccountId` per call, write the
   `execution_tool_call` rows, and confirm you can render "this flow used these connections" from
   runtime data alone, with the static AST pass as a predicted overlay.

One side test worth folding in: call `connectedAccounts.initiate` against your managed slack config
`ac_i59Dyk0WqVKV` and confirm the endpoint retired on 2026-07-03 has not broken Gluu's connect flow.

Decision rule I would hold you to: adopt only if (1) and (2) pass cleanly and (3) costs less than
300 ms of added latency on a write. Anything else means the wrapper is fighting the platform.

Step 2 is the one that answers your actual concern. "Composio works as advertised" is true today
and true on a lag, so the question worth money is whether the lag ever reaches the user. Vendors
who keep deprecated fields alive for years make the lag harmless. Vendors who cut hard make it
fatal. Test it on the toolkit where you already know the lag exists.

---

## 9. Sources

Live API probes, 2026-08-01, `https://backend.composio.dev/api/v3`:
`GET /toolkits`, `GET /toolkits/{slug}`, `GET /tools?toolkit_slug=&toolkit_versions=`,
`GET /auth_configs`, `GET /auth_configs/{id}`, `POST /auth_configs` (rejected and accepted cases),
`DELETE /auth_configs/{id}`. Raw responses in `raw/`.

Composio documentation:
- Toolkit versioning: https://docs.composio.dev/docs/tools-direct/toolkit-versioning
- Next-generation SDK migration: https://docs.composio.dev/docs/migration-guide/new-sdk
- Custom (BYOC) auth configs: https://docs.composio.dev/docs/custom-auth-configs
- Connected accounts: https://docs.composio.dev/docs/auth-configuration/connected-accounts
- Create connected account (deprecation notice): https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccounts
- Rate limits: https://docs.composio.dev/reference/rate-limits
- Errors: https://docs.composio.dev/reference/errors
- Tool Router: https://composio.dev/blog/introducing-tool-router-(beta)
- npm registry `@composio/core`: https://registry.npmjs.org/@composio/core (latest 0.14.1, 2026-07-30)

Vendor API changes used as fidelity tests (§3.2, reproduced by `probes/04-fidelity.py`):
- Notion 2025-09-03 upgrade guide: https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03
- Notion 2025-09-03 FAQs: https://developers.notion.com/docs/upgrade-faqs-2025-09-03
- Notion 2026-03-11 upgrade guide (`after` to `position`, `archived` to `in_trash`,
  `transcription` to `meeting_notes`): https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11
- Notion reference index used for the coverage count: https://developers.notion.com/llms.txt
  (captured to `raw/notion-endpoints.txt`)
- Slack `files.upload` retirement: https://docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay/
- Slack retirement timeline adjustment: https://docs.slack.dev/changelog/2025/03/17/files-upload-extension/

Vendor removal policies used for the base rates in §3.9:
- Notion versioning policy ("no plans to stop supporting older API versions"):
  https://developers.notion.com/reference/versioning
- GitHub REST API versions and the 24-month support floor:
  https://docs.github.com/en/rest/about-the-rest-api/api-versions
- GitHub REST API breaking changes (removed properties and their deprecation ages):
  https://docs.github.com/en/rest/about-the-rest-api/breaking-changes
- Slack breaking-change changelog: https://docs.slack.dev/changelog/tags/breaking-change/
- Slack deprecation changelog: https://docs.slack.dev/changelog/tags/deprecation/
- Slack classic apps sunset (2026-11-16): https://docs.slack.dev/changelog/2025/07/29/classic-apps-extension/
- Google Workspace deprecation record: https://developers.google.com/workspace/release-notes

Pricing (third-party, unverified with Composio sales):
- https://www.usagepricing.com/blueprint/composio
- https://aicoolies.com/reviews/composio-review

BubbleLab source read (no modifications), `/home/unix/bubblelab-suite`:
- `packages/bubble-runtime/src/injection/BubbleInjector.ts` (injection, tool and capability
  credential extraction)
- `packages/bubble-runtime/src/extraction/BubbleParser.ts` (call-site recognition and the
  complex-expression skip list)
- `packages/bubble-shared-schemas/src/types.ts` (68 `CredentialType` members)
- `packages/bubble-shared-schemas/src/credential-schema.ts` (`SYSTEM_CREDENTIALS`)

Gluu source read (no modifications), `/mnt/c/Users/brenn/Documents/gluu`:
- `backend/src/lib/integrations/composio/client.ts` (`initiate` at :451, `link` call sites)
- `backend/node_modules/@composio/core@0.10.0/dist` (`CONFIG_DEFAULTS.toolkitVersions = "latest"`,
  `ToolExecuteResponse`, `ToolExecuteParams`)
- `docs/features/composio-integration/COMPLAINTS-LOG.md`
- `docs/features/composio-integration/BYOC-APPS-BY-SCHEME.md`

