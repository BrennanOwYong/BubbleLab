# REFACTOR-ROADMAP — Composio adoption inside BubbleLab

Synthesized 2026-08-01 from: the per-problem disposition analysis (S1-S8, AUTH-FND, FE4),
`composio-eval/COMPOSIO-VS-BUBBLELAB-ADVISORY.md`, `composio-eval/IMPLEMENTATION-GUIDE.md`,
and the Composio risk profile. Governed by `DISPATCH-CONTRACT.md`: every new row below carries an
event-based acceptance test. This document proposes; the main session applies BACKLOG.md edits
(see §6). No source code changes ride with this doc.

**Verdict inherited from the advisory:** the evidence supports one bounded experiment, not a
commitment. Composio is a credential-vault and transport layer for mainstream SaaS only. Nothing
in the backlog is fully superseded; four rows shrink, six ship as filed, and six new rows enter.
All "dissolves the bug" claims are structural arguments about the injection mechanism, unproven
on the wire until Phase 0 runs.

---

## 1. Disposition table

Disposition legend: **SUPERSEDED** (row deleted, Composio absorbs it) · **REDUCED** (row scope
shrinks or re-bases) · **KEPT** (row ships as filed). Row-change column records the concrete
BACKLOG.md action. Zero rows are SUPERSEDED.

| Row                                        | Disposition | Row change                 | Confidence | One-line reason + evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ----------- | -------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 nested-tool credential recognition      | REDUCED     | reduce scope               | high       | Server-side resolution removes injection at any depth for migrated toolkits (advisory §5.2/A7: "credentials never enter the script"), but S1's true root (SYSTEM classification gating six binding surfaces, credential-schema.ts:884/816, FlowSetupPanel.tsx:192 et al.) lives in BubbleLab code Composio never touches; the effective-classification predicate ships for every hand-written bubble (hybrid is steady state, impl guide §1 rule 3), plus new work: pre-flight connected-account check (§4.4) and the SYSTEM→platform-funded-toolkit mapping decision (§4.3). Firecrawl's Composio coverage is unverified. |
| S2 ternary call-site lint reject           | KEPT        | keep as filed              | high       | The lint rule protects the AST-injection mechanism, and that mechanism runs permanently for 13 no-equivalent integrations, 45 OAuth-only toolkits, 1x-depth toolkits, and every unmigrated bubble (advisory §7.11, impl guide §1 rules 2-3); a lint rule is all-or-nothing work, so Composio shrinks the protected class, never the work. Adds: scope the rule to never fire on generated Composio-family calls (impl guide §8), plus the §4.4 pre-flight.                                                                                                                                                                 |
| S3 tool-suite-family discovery             | REDUCED     | reduce scope               | high       | Composio's product-named taxonomy (separate `googledocs`/`googledrive` slugs, 209/209 prose names, per-tool descriptions) supplies the capability index BubbleLab lacks, via the generated manifest (impl guide §3.2); but "Composio never becomes the agent-facing interface" (rule 1), so the search tool, alias miss-path, and SOP rule still get built, the index must span TWO catalogs (manifest + 13 data-plane bubbles), and curation policy decides discoverability.                                                                                                                                              |
| S4 self-test fulfillment + dependency mask | KEPT        | keep as filed              | high       | Root lives in the sidecar reducer/SOP (gluu-client.ts:419), untouched by Composio's seam; adoption ADDS reducer inputs (successful:false + string error, boundary OutputSchema.parse failures) because migrated steps carry LESS structure than typed bubble errors (advisory §7 factor 4) and missing accounts fail late (impl guide §4.4).                                                                                                                                                                                                                                                                               |
| S5 error-signal distinguishing detail      | KEPT        | keep as filed              | high       | Root lives in logger/collator identity collapse (base-bubble-class.ts, HttpResultSchema), outside Composio's seam; identity concept extends to tool_slug/connectedAccountId for Composio steps since variableId/url identity does not exist there, and two failing Composio calls can emit identical strings (conflation recurs in a layer BubbleLab cannot instrument).                                                                                                                                                                                                                                                   |
| S6 fixer binary-triage grounding           | REDUCED     | reduce scope               | high       | Layer 2 (bound-but-not-injected) cannot occur on migrated steps, so decision-table rows shrink per toolkit; but prompts.ts's "ALWAYS reconnect" root is BubbleLab code, the inspect tool must now cover TWO credential planes, Branch P (platform terminal: Composio outages, vault expiry, endpoint churn §7.9) grows MORE load-bearing, and SYSTEM-cred misdiagnosis (layer 1) stays possible.                                                                                                                                                                                                                           |
| S7 OAuth CSRF stateless state              | KEPT        | keep as filed              | medium     | Composio's hosted callback removes BubbleLab's authorize/callback path per migrated toolkit (advisory A2), but the four legacy providers stay on oauth-service.ts through the whole migration window, hybrid is steady state, and the bug burns real consents until the ~1-day stateless-state fix lands; Composio's own CSRF handling was never probed, and its callback layer carries a confirmed docs-vs-live URI defect (Complaint 1).                                                                                                                                                                                 |
| S8 sidecar Claude token auto-refresh       | KEPT        | keep as filed (orthogonal) | high       | The token is the Anthropic Max-login credential consumed by the spawned CLI binary (builder.ts:158), harness infrastructure above every seam Composio touches; neither doc mentions the sidecar or CLAUDE_CONFIG_DIR. Second-order: COMPOSIO_API_KEY joins the unmanaged-machine-state class S8 names.                                                                                                                                                                                                                                                                                                                     |
| AUTH-FND (F0.3 / F0.4 / FE1 / U5)          | REDUCED     | reduce (per leg)           | medium     | F0.3: callback-port coupling absorbed for migrated toolkits (Composio hosts the callback, even BYOC configs carry it, advisory §4 C1) yet the 3100..3130 registration STILL executes now as the branching hard gate; F0.4: absorbed only under a Composio-MANAGED Google app, unverified against the 122/1069 managed list, publish proceeds; FE1: untouched (no connection-lifecycle webhook shown), trigger seam moves to the connect-completion path; U5: gains a truthful runtime data source (impl guide §5 reconciliation) but ships as BubbleLab UI work plus the S1 predicate for unmigrated bubbles.              |
| FE4 native-capability discovery            | KEPT        | keep as filed (orthogonal) | high       | Composio is a tool source, never the discovery layer (rule 1, §3.3 curation); no doc mentions LLM-native capabilities. Adoption ENLARGES the redundant-bolt-on surface (toward a 44,437-tool catalog), so the routing rule extends to "native capability > any tool source including generated Composio bubbles" and search-class toolkits are excluded from curation.                                                                                                                                                                                                                                                     |

---

## 2. Composio adoption phases as new backlog rows

Proposed as a new BACKLOG.md section: **Phase C — Composio adoption (gated ladder)**. Each phase
gates the next; a Phase 0 kill answer stops the ladder and the systemic rows proceed as filed at
zero loss (they ship regardless, per §1).

| id     | title                                                                | depends-on              |
| ------ | -------------------------------------------------------------------- | ----------------------- |
| C0     | Bounded pilot: prove the thesis on Notion (worst realistic case)     | — (nothing new; see §4) |
| C-GATE | Per-toolkit adoption gate: policy + machine-checkable script         | C0                      |
| C1     | Codegen pipeline: pinned toolkit → Zod/TS wrappers + manifest        | C0                      |
| C2     | Credential bridge: connectedAccountId binding + pre-flight loud-fail | C1                      |
| C3     | Runtime-first provenance: execution_tool_call rows + reconciliation  | C2                      |
| C4     | Non-technical view: manifest-fed labels/icons/risk badges            | C3, F0.5                |

- **C0 — Bounded pilot (FIRST, before any machine is built).** Pilot Notion end to end, the worst
  realistic case since §3.2 proves its fidelity lag. Answer in order: (1) generated
  `OutputSchema.parse` succeeds on live payloads for three tools (failure kills the thesis
  outright); (2) an append-block call with the `after` parameter succeeds against a real
  workspace, confirming the 2025-09-03 pin (failure means Composio sends a newer version header
  with older field names, a defect that changes the recommendation); (3) round-trip latency vs
  the existing notion bubble; (4) the provenance join renders from `logId` +
  `connectedAccountId` runtime rows alone. Side test: `connectedAccounts.initiate` against
  managed slack config `ac_i59Dyk0WqVKV` to confirm the 2026-07-03 `POST /connected_accounts`
  retirement did not break Gluu's connect flow. Decision rule: adopt only if (1) and (2) pass
  cleanly AND (3) costs under 300 ms added on a write. Always pass the version parameter; raw
  GET /api/v3/tools without it serves frozen base snapshot `00000000_00` (advisory §3.2).
  - _Accept (event-based):_ a standalone exit-coded pilot script (probe-style, F0.1-shaped
    structured output) runs all four questions live against a real connected account and emits
    `{q1,q2,q3_ms,q4,sideTest}` JSON; exit 0 iff q1 pass ∧ q2 pass ∧ q3 < 300 ∧ q4 pass. The
    JSON artifact is committed to `composio-eval/probes/` as the gate record for C1.
- **C-GATE — Per-toolkit adoption gate.** Codify impl guide §7 as policy plus a script: (1) does
  the vendor version its API (Class A: Notion/GitHub, no vigilance; Class B: Slack/Google,
  changelog watch list + one live call per tool pre-ship); (2) is managed auth available
  (122/1,069; 45 OAuth-only with no managed app and no key fallback); (3) does depth justify the
  swap (1x telegram buys nothing; 26x docusign is moot, it fails question 2).
  - _Accept:_ `scripts/composio-gate.mjs <toolkit-slug>` emits
    `{vendorVersioning, managedAuth, depthRatio, verdict}` JSON, exit-coded; run on `telegram`
    returns `verdict:"keep-bubble"`, on `notion` returns `verdict:"eligible"`; the checklist doc
    lands in `PLAN-DOCS/refactor/` with the advisory deep links in `## Sources`.
- **C1 — Codegen pipeline.** Consume `GET /api/v3/tools?toolkit_slug=<slug>&toolkit_versions=<pin>`
  (always versioned); emit per curated tool a Zod input schema, a Zod output schema (resolving
  `$defs`/`$ref`), inferred TS types, and one manifest entry (slug, toolkit, pinned version,
  human name, description, tags, schema hash). Generator rules (impl guide §3.3): reject
  `is_deprecated:true` at generation (26 of Slack's 133 base tools, incl. SLACK_CHAT_POST_MESSAGE);
  pin the version in the artifact; fail the build on schema-hash change under an unchanged pin;
  curate before generating (never 871 GitHub wrappers; `important` tag as first filter). The
  boundary parse is the point: `ToolExecuteResponse.data` is `Record<string, unknown>`, so the
  wrapper runs `OutputSchema.parse` and surfaces a parse failure loudly, naming tool + pin (this
  closes the `as any` hole the type-safety rule bans). Registration goes through the same
  `BubbleFactory.register` path; `BubbleName` union needs its own generation step.
  - _Accept:_ event test drives the generator against the pinned notion toolkit: (a) manifest +
    schemas emitted for the curated set; (b) injecting a deprecated slug into the curated list
    fails the build, exit non-zero; (c) mutating a stored schema hash under the same pin fails
    the build; (d) a live-payload parse run over every emitted tool returns
    `{tool, parsed:true}` for all, structured JSON, exit-coded.
- **C2 — Credential bridge.** A step binds to `connectedAccountId`; nothing is written into
  source (protects the §0 invariant: a generated flow never contains a credential).
  `CredentialType` (68 members), per-step binding semantics, the Setup tab, and the pool concept
  all STAY (impl guide §4.2); the storage/refresh layer underneath is what Composio replaces.
  Includes the §4.4 requirement that survives regardless of platform: a missing credential fails
  loudly at the earliest point, so a pre-flight check lists connected accounts for the flow's
  toolkits BEFORE the first call (Composio's own signal, `successful:false` at execution, is
  late; silence was the actual defect S1/S2 diagnosed).
  - _Accept:_ (a) a flow step bound to `connectedAccountId` A reaches account A, asserted from
    the `execution_tool_call` row naming A; (b) a flow whose toolkit has zero connected accounts
    emits a typed pre-flight error event BEFORE any business logic (zero execute calls logged,
    no partial side effects); (c) a grep assertion over the saved flow source finds no credential
    material; all via the F0.1 harness, exit-coded.
- **C3 — Runtime-first provenance.** Static AST pass = predicted, never authoritative (dynamic
  slugs and provider handoff resolve to unknown, §5.1); the execution wrapper writes
  `execution_tool_call` (execution_id, flow_id, tool_slug, connected_account_id,
  composio_log_id, successful, duration_ms, called_at) on every call; `flow_tool_usage` and
  `flow_connection_usage` are projections. Reconciliation is a feature: a runtime slug with no
  static row means the agent used an undeclared tool, and the system surfaces it.
  - _Accept:_ run a flow containing one declared Composio step and one agent-chosen (provider
    handoff) tool; assert (a) both calls produce `execution_tool_call` rows with non-null
    `composio_log_id` + `connected_account_id`, (b) reconciliation emits a flagged-undeclared
    event for the agent-chosen slug, (c) "this flow used these connections" renders from runtime
    rows alone; DB-row + event assertions, exit-coded.
- **C4 — Non-technical view.** Assemble, never build: structure (order, edges, nesting) from
  BubbleLab's `dependencyGraph`; prose label (209/209), description, `meta.logo` (1,069/1,069),
  `meta.categories` (88), `destructiveHint`/`readOnlyHint` badges from the manifest. Render from
  reconciled C3 data so agent-chosen tools appear. `scopes` is inconsistent across toolkits
  (human labels vs scope strings vs raw URLs), so "what this step may do" needs an own mapping
  table or gets dropped. `destructiveHint` is a first-class UI signal.
  - _Accept:_ the node view-model for a migrated flow carries `{label, iconUrl, category,
riskBadge}` for every Composio node, sourced from the manifest; edges match the parsed
    dependency graph; the F0.5 no-technical-leakage assertion passes over the view-model data
    (no slugs, no raw params, no `*_CRED` constants); asserted on view-model/telemetry data,
    never pixels. `[USER-TEST]` card: can a non-technical person read the flow without help.

---

## 3. What STAYS on native BubbleLab bubbles (Composio coverage holes)

Permanent residue, a category rather than a backlog (impl guide §1 rule 2, §8: "Do not migrate
the data-plane bubbles. There is nothing to migrate them to."):

1. **Data plane, entirely absent from the 1,069-toolkit catalog:** postgresql, redshift-data,
   s3, bigquery, snowflake-sql-api, databricks-sql, insforge-db. Zero databases, warehouses, or
   object storage exist in Composio.
2. **Private and small SaaS Composio will never carry:** agi-inc, clerk, sortly, memberful,
   assembled, slab, luma, sendsafely, kraken-spot-api (only `kraken_io`, an unrelated image
   service, exists).
3. **The 45 OAuth-only toolkits with no managed app and no key fallback:** twitter, xero,
   docusign, snowflake, netsuite; three of five named are existing BubbleLab bubbles. They fail
   C-GATE question 2.
4. **1x-depth integrations:** telegram (13 ops vs 18 tools); the swap buys nothing and costs a
   hop, a billing event, and a dependency. They fail C-GATE question 3.
5. **Event-driven flows on trigger-less toolkits:** 351 triggers across 1,069 toolkits leaves
   most polling-only.
6. **Payload-sensitive flows** (customer email bodies, CRM records, documents) until the
   Enterprise-only self-hosting question settles commercially (open decision 5): every call
   transits Composio's servers.
7. **The agent-facing interface itself:** parser, type system, canvas, provenance model, and the
   operation-shaped bubble facade stay the product surface; raw tool schemas (median 19 KB,
   ~5,000 tokens/tool) never reach the model.
8. **Firecrawl:** coverage unverified (absent from both the 40-overlap and 13-absent lists), so
   the S1 env-name fix (`FIRE_CRAWL_API_KEY`, credential-schema.ts:816) ships regardless.

Consequence for the systemic rows: the AST injector, its lint guards (S2), its classification
predicate (S1), the reducer/collator (S4/S5), and the fixer's bubble-plane triage (S6) run
permanently for this residue. Hybrid is the steady state, not a transition.

---

## 4. Sequencing

```
now ──────────────────────────────────────────────────────────────────▶

F0.3 GCloud range registration  ──► HARD GATE for ALL branching (unchanged)
F0.4 consent-screen publish     ──► executes now (pre-migration window + BYOC)
C0 bounded pilot                ──► gated on NOTHING new; runs in parallel with F0.3
S1..S8 systemic rows            ──► proceed as filed / re-scoped; none blocked on C-phases
C0 pass ─► C-GATE ─► C1 ─► C2 ─► C3 ─► C4
C0 fail ─► ladder stops; systemic rows already ship regardless (zero loss)
```

1. **The F0.3 gate still applies, in full.** Composio's callback absorption lands only after
   OAuth toolkits actually migrate (post-C2, per toolkit), and Google's managed-auth status is
   unverified against the 122/1,069 list. Until then every branched stack's OAuth targets
   BubbleLab's own client, so the `3100..3130` Google Cloud registration remains the inline
   pre-branch HARD GATE exactly as BACKLOG.md states. No branching until F0.3 is green.
2. **C0 is gated on nothing new.** It needs only the existing `COMPOSIO_API_KEY` (already live
   in gluu/backend/.env; note the trailing-comment parsing gotcha) and one real Notion connected
   account. It touches no BubbleLab OAuth (Composio hosts the callback), writes no product code,
   and its probe script is standalone and exit-coded, so it does not wait on F0.1's harness. It
   can start today, in parallel with F0.3.
3. **Systemic rows do not wait for the ladder.** S2, S4, S5, S7, S8, FE4 ship as filed. S1, S3,
   S6, U5, FE1 ship at reduced scope; their Composio-plane extensions (two-plane inspect tool,
   manifest-fed index, reconciled Setup rows, connect-completion trigger seam) gate on C2/C3,
   the base work gates on nothing new. S7 in particular ships early: the CSRF bug burns real
   consents through the entire migration window.
4. **The ladder is strictly ordered:** C0 → C-GATE → C1 → C2 → C3 → C4. Each phase's acceptance
   test is the next phase's entry condition. Per-toolkit onboarding after C2 runs through
   C-GATE, one toolkit at a time, Class-B toolkits (Slack, Google) with a vendor-changelog watch
   plus one live call per tool before shipping.
5. **Cross-cutting rule from the advisory:** verify by executing, never by reading the catalog.
   Composio's descriptive metadata under-reports what its execution layer accepts (auth schemes,
   tool counts disagreeing across three fields, `meta.version` tracking rebuilds not vendor
   changes), and its server-side validation is thin (a BEARER_TOKEN github config with empty
   credentials returned 201). Shape validation stays on the BubbleLab side.

---

## 5. Open decisions, ranked by how much they constrain what follows

1. **Bubble granularity: per toolkit or per tool** (impl guide §3.5 / open decision 1). Decides
   the shape of everything generated AND what a "discoverable unit" is for S3's index; the
   `BubbleName` closed union needs a generation step either way. Advisory reasoning favors per
   toolkit (operation-shaped facades are the product). Resolve before C1.
2. **`userId` vs `connectedAccountId` binding** (§4.3). Decides whether per-step account
   selection survives; the existing per-step model points at pinning `connectedAccountId`.
   Resolve before C2.
3. **The SYSTEM/platform-funded mapping** (S1 remnant). Which toolkits does the platform fund
   via a platform-owned userId/connected account vs user-connected: the S1 classification
   question in new clothes. Resolve before C2; feeds the effective-classification predicate.
4. **Curation policy** (S3 remnant, §3.3). Which of the ~44,437 tools enter the curated set
   decides what the agent can discover at all; an uncurated capability is invisible, the same
   failure shape as today's 9-bubble prompt excerpt. Include deprecated-slug filtering and the
   FE4 exclusion of search-duplicating toolkits. Resolve before C1 generation runs.
5. **Where generated code lives** (open decision 3). New package vs generated files inside
   `bubble-core`; affects the build graph and whether regeneration is routine.
6. **One Composio integration shared with Gluu, or two** (open decision 4). Gluu runs SDK 0.10.0
   against 0.14.1 current; already a live maintenance question.
7. **Is the data path acceptable** (open decision 5). Every payload transits Composio,
   self-hosting is Enterprise-only custom quote; commercial rather than technical, and it
   surfaces in a customer's first security review. Blocks nothing before per-toolkit onboarding,
   blocks payload-sensitive toolkits at C-GATE.
8. **Google managed-auth verification** (AUTH-FND remnant). Whether Google sits in the 122
   managed toolkits decides F0.4's eventual absorption; verify against the live catalog before
   ever deleting that row. Until verified, F0.4 executes as filed.
9. **Exit path from the vault** (risk profile). Connected accounts live in Composio's vault;
   exit means re-consenting every user. Ask what export looks like before C2 makes the
   dependency real.

---

## 6. Proposed BACKLOG.md changes (main session applies; this doc does NOT edit BACKLOG.md)

### 6.1 New section, inserted after "Phase 3 — Features"

```markdown
## Phase C — Composio adoption (gated ladder; C0 verdict gates C1+)

| id     | title                                                                | status | depends-on |
| ------ | -------------------------------------------------------------------- | ------ | ---------- |
| C0     | Composio bounded pilot: Notion end-to-end thesis test                | TODO   | —          |
| C-GATE | Per-toolkit adoption gate (policy + gate script)                     | TODO   | C0         |
| C1     | Codegen: pinned toolkit → Zod/TS wrappers + manifest                 | TODO   | C0         |
| C2     | Credential bridge: connectedAccountId binding + pre-flight loud-fail | TODO   | C1         |
| C3     | Runtime-first provenance + reconciliation                            | TODO   | C2         |
| C4     | Non-technical view from manifest + reconciled provenance             | TODO   | C3, F0.5   |
```

Row bodies and accept-lines: copy verbatim from §2 of
`PLAN-DOCS/refactor/REFACTOR-ROADMAP.md` (this file).

### 6.2 Row edits (scope notes appended to existing rows; no row deleted)

- **S1** — append: "Scope re-based per REFACTOR-ROADMAP §1: the effective-classification
  predicate (declared-SYSTEM ∩ env-actually-set) ships for all hand-written bubbles at the six
  filter sites; for Composio toolkits the predicate becomes connected-account existence. Adds:
  pre-flight account check (C2) and the platform-funded mapping decision (open decision 3). The
  FIRE_CRAWL_API_KEY env-name fix ships regardless; Firecrawl Composio coverage unverified."
- **S2** — append: "Ships unchanged (hybrid steady state). Adds: lint rule must never fire on
  generated Composio-family calls; pre-flight check covers the Composio silent-late class."
- **S3** — append: "Index source re-based: generated Composio manifest for migrated toolkits +
  registry metadata for the 13+ data-plane bubbles; discovery must span both or grows a hole
  exactly where Composio has zero coverage. Search tool, alias miss-path, SOP rule unchanged.
  Curation policy is the new open question (roadmap decision 4); granularity (decision 1) first."
- **S4 / S5** — append: "Ship unchanged. Extend reducer/collator inputs for migrated steps:
  Composio successful:false + string error, boundary OutputSchema.parse failures; S5 identity
  extends to tool_slug/connectedAccountId (no variableId/url exists on Composio steps)."
- **S6** — append: "Decision-table layer-2 rows shrink per migrated toolkit; inspect tool covers
  two credential planes (bound-slot/SYSTEM/oauthStatus + connected-account state); Branch P
  (platform terminal: outages, vault expiry, endpoint churn) becomes more load-bearing;
  acceptance suite gains Composio-plane cases."
- **S7** — append: "Ships now, unchanged (~1 day): legacy OAuth providers stay on
  oauth-service.ts through the migration window and the CSRF bug burns consents until fixed.
  Add the one-line defensive read of credentials.oauth_redirect_uri off each created auth
  config (docs-vs-live URI disagreement, advisory §4 Complaint 1)."
- **S8** — append: "Orthogonal to Composio (harness credential, above every seam). New sibling
  concern: COMPOSIO_API_KEY is another unmanaged machine-state secret the environment must
  provision; no rotation-clobber mode, provisioning only."
- **F0.3** — append: "HARD GATE unchanged. Composio absorption of callback-port coupling lands
  only per migrated toolkit post-C2; the 3100..3130 registration executes now."
- **F0.4** — append: "Executes as filed. Absorbed only under a Composio-MANAGED Google app;
  managed status unverified (roadmap decision 8). Under BYOC the Testing-status 7-day expiry
  stays BubbleLab's Google Cloud problem."
- **FE1** — append: "Trigger still must be built (Composio shows no connection-lifecycle
  webhook); for migrated toolkits the notify seam moves from oauth-service.ts/credentials.ts
  inserts to BubbleLab's connect-completion/waitForConnection path."
- **U5** — append: "Gains authoritative runtime rows via C3 reconciliation (predicted checklist
  from static pass + reconciled actual rows + pre-flight account listing); the S1 predicate
  still feeds it for unmigrated bubbles."
- **FE4** — append: "Ships unchanged. Routing rule extends to: native capability > any tool
  source including generated Composio bubbles; curation (C1) excludes search/serp/scrape-class
  toolkits."

### 6.3 Explicit non-changes

No row moves to Done or is deleted. No dependency of an existing row changes. The Phase-1
systemic rows keep their F0.1 depends-on; C0 alone carries no F0.1 dependency (standalone
probe, §4.2).

---

## Sources

- `composio-eval/COMPOSIO-VS-BUBBLELAB-ADVISORY.md` (measurements dated 2026-08-01; §3.1 managed
  auth 122/1,069; §3.2 version pins + frozen base `00000000_00`; §3.5 schema weight; §3.6 thin
  validation; §3.8 coverage; §3.9 vendor classes; §4 confirmed complaints; §5 architecture
  claims; §7 decision factors; §8 bounded-pilot verdict)
- `composio-eval/IMPLEMENTATION-GUIDE.md` (§0 invariant, §1 rules 1-3, §2 Phase-0 table, §3
  codegen, §4 credential bridge, §5 provenance, §6 view, §7 gate, §8 what not to build, §9 open
  decisions, §10 verification)
- `composio-eval/asks-matrix.json`, `composio-eval/probes/`
- Per-problem disposition JSON (S1, S2, S3, S4-S5, S6, S7, S8, AUTH-FND, FE4), 2026-08-01
- Composio docs: https://docs.composio.dev/docs/tools-direct/toolkit-versioning ·
  https://docs.composio.dev/docs/auth-configuration/connected-accounts ·
  https://docs.composio.dev/docs/custom-auth-configs ·
  https://docs.composio.dev/reference/rate-limits
- BubbleLab seams: `packages/bubble-runtime/src/injection/BubbleInjector.ts:447`,
  `packages/bubble-runtime/src/extraction/BubbleParser.ts:1384-1394`,
  `packages/bubble-core/src/bubble-factory.ts:93`,
  `packages/bubble-shared-schemas/src/types.ts` (`CredentialType`, `BubbleName`)
