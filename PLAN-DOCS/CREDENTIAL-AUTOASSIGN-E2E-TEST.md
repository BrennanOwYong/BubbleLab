# Credential auto-assign E2E test — shared findings

Parallel agents append one top-level section each. Do not overwrite prior sections.

# Agent: frontend-conversational-e2e

Date: 2026-08-05 (~07:45–08:10 UTC). Stack: API :3102, sidecar :3103, studio :3104, branch phase4-builder-harness. Test artifact: **flow 236** ("Weekday Competitor News Digest to Telegram"), left in the dev DB as evidence — its `/credential-state` payload and chat history back every claim below. Browser: agent-browser session `credtest-e2e`.

## 1. Exact prompts used (verbatim)

Home-page prompt box (created flow 236, auto-started the build):

> Every weekday morning I want a quick competitor-news digest sent to me on Telegram. Have an AI agent search the web for the latest news about my main competitors and summarize the top 3 findings.

Chat reply 1 (answer to the agent's clarifying question):

> My main competitors are Zapier, Make, and n8n. Weekday mornings around 8am Singapore time works.

Chat reply 2 (answer to the agent's second question + steering to the nested tool, because the agent's first design used `nativeCapabilities: ['web-search']` instead of a `tools` array):

> My Telegram chat ID is 1285788554. Also, please switch the web research to use the Firecrawl-backed web-search tool (web-search-tool in the agent tools list) instead of the native web search - I want searches to go through my Firecrawl account.

## 2. Expected tools detected

- "AI agent search the web" → `AIAgentBubble` with nested `tools: [{ name: 'web-search-tool' }]` → needs `FIRECRAWL_API_KEY` (the S1a/S1b nested-tool detection target) plus a model credential (`OPENAI_CRED` for `openai/gpt-5-mini`).
- "sent to me on Telegram" → `TelegramBubble` (send_message) → needs `TELEGRAM_BOT_TOKEN`.
- "Every weekday morning" → cron trigger, no credential.

## 3. Expected credential assignment per tool

Pre-existing saved credentials at test start (GET /credentials): TELEGRAM_BOT_TOKEN id 2 ("my tg bot token"), FIRECRAWL_API_KEY id 7, GMAIL_CRED ids 3/6, NOTION_API id 5, GOOGLE_SHEETS_CRED id 4, GOOGLE_DRIVE_CRED id 8.

- `TELEGRAM_BOT_TOKEN` → expect **auto-bind** to cred id 2 (single saved cred of the type).
- `FIRECRAWL_API_KEY` (nested tool) → expect either auto-bind to cred id 7 or platform-provided satisfaction; must appear in detection surfaces, never silently dropped.
- `OPENAI_CRED` → expect platform-provided (env), no user action.

## 4. Actual observed result

### Conversational path

The build agent asked TWO clarifying questions and handled both replies without restarting:

1. After the initial prompt: _"Which companies are your main competitors — I'll have the agent track news specifically for those (give me their names, e.g. \"Acme Corp, Globex, Initech\")?"_ — answered with reply 1; the agent generated code, validated, saved, ran `inspect_flow_credentials`, reported in chat: _"Telegram credential is bound and healthy, OpenAI is platform-provided. All good — proceeding to set defaults and test."_, then `set_flow_defaults` + `test_run_flow` (57s) and asked question 2: _"Now I need your real Telegram chat ID so the digest actually reaches you — what is it (or the @username of the chat with your bot)?"_
2. After reply 2 the agent rewrote the research step, re-ran the flow live (real search results with real URLs appeared in the transcript, e.g. finance.yahoo.com, community.make.com, chipos.io items about Zapier/Make/n8n), set `telegram_chat_id` default to 1285788554 via `set_flow_defaults`, called `rename_flow`, and closed with: _"Every weekday at 8am Singapore time, an AI agent runs Firecrawl-backed web searches for Zapier, Make, and n8n, picks the top 3 most significant findings, and sends the digest straight to your Telegram."_

### Generated code (final, GET /bubble-flow/236)

First version used `nativeCapabilities: ['web-search']` (no `tools` array — see gap G3). After reply 2:

```ts
const result = await new AIAgentBubble({
  message: `Use the web search tool to find the latest news ... ${competitors} ...`,
  tools: [{ name: 'web-search-tool' }],
  expectedOutputSchema: digestSchema,
  model: { model: 'openai/gpt-5-mini', maxTokens: 10000 },
}).action();
```

Persisted defaults ended correct: `{"competitors": "Zapier, Make, n8n", "telegram_chat_id": "1285788554"}`.

### Backend detection + binding (GET /bubble-flow/236 and /credential-state, after the tools-array rewrite)

`requiredCredentials`: `{"426": ["OPENAI_CRED","GOOGLE_GEMINI_CRED","ANTHROPIC_CRED","FIRECRAWL_API_KEY","OPENROUTER_CRED","FIREWORKS_CRED"], "440": ["TELEGRAM_BOT_TOKEN"]}`

`/credential-state` slots (fields trimmed to the relevant ones):

```json
{"bubbleKey":"426","bubbleName":"ai-agent","credentialType":"OPENAI_CRED","system":true,"platformProvided":true,"boundCredentialId":null,"userCredentialsOfType":0}
{"bubbleKey":"426","bubbleName":"ai-agent","credentialType":"FIRECRAWL_API_KEY","system":true,"platformProvided":true,"systemEnvPresent":true,"boundCredentialId":null,"boundRowExists":false,"userCredentialsOfType":1}
{"bubbleKey":"440","bubbleName":"telegram","credentialType":"TELEGRAM_BOT_TOKEN","system":false,"platformProvided":false,"boundCredentialId":2,"boundRowExists":true,"boundCredential":{"id":2,"name":"my tg bot token"},"userCredentialsOfType":1}
```

(+ 4 more ai-agent slots for GEMINI/ANTHROPIC/OPENROUTER/FIREWORKS, all `system:true, platformProvided:false, boundCredentialId:null, userCredentialsOfType:0`.)

### UI Setup tab (rendered text, verbatim)

> Setup — 4 of 5 required connections still missing.
> Google Gemini — Needs connection — Used by step: result — Connect
> Anthropic — Needs connection — Used by step: result — Connect
> OpenRouter — Needs connection — Used by step: result — Connect
> Fireworks AI — Needs connection — Used by step: result — Connect
> Telegram Bot Token — Connected (my tg bot token) — Used by step: send result — Account: my tg bot token

UI vs API: they agree exactly. The 4 "Needs connection" rows are the 4 unbound non-platform slots; Telegram shows the auto-bound cred by name; OPENAI and FIRECRAWL (both `platformProvided:true`) are hidden from Setup, matching the post-S1 never-user-action class. The canvas ai-agent node ("result") carries a "⚠ Missing" badge driven by the same 4 slots.

### Runtime proof

The `test_run_flow` after the rewrite executed the Firecrawl-backed `web-search-tool` for real (live headlines with source URLs in the transcript) and `sent • true` for the Telegram step to chat 1285788554. The credential the nested tool needed was present at runtime via the platform env, with zero silent failure.

### Discriminating probe: is FIRECRAWL in requiredCredentials because of the nested tool?

No. POST /bubble-flow/validate with a minimal `AIAgentBubble` and **no tools array at all** returns the identical list:

```
no-tools           requiredCredentials: {"411": ["OPENAI_CRED","GOOGLE_GEMINI_CRED","ANTHROPIC_CRED","FIRECRAWL_API_KEY","OPENROUTER_CRED","FIREWORKS_CRED"]}
nested-web-search  requiredCredentials: {"411": [same six]}
```

`requiredCredentials` for ai-agent is the static per-bubble option list (BUBBLE_CREDENTIAL_OPTIONS), so this surface cannot attest the S1a/S1b AST nested-tool detection — FIRECRAWL would have been listed with or without the fix. The AST work is only observable on surfaces that vary with the tools array (none of the ones this E2E exercises do, for ai-agent).

## 5. Verdict: PARTIAL

Confirmed:

- **C1 — Auto-bind for a direct bubble**: TELEGRAM_BOT_TOKEN auto-bound to saved cred id 2 with zero user action; UI, `/credential-state`, and the build agent's own `inspect_flow_credentials` report all agree.
- **C2 — No silent drop**: the nested web-search tool's FIRECRAWL_API_KEY need was satisfied (platform-provided) and the tool executed live; nothing failed credential-less.
- **C3 — Conversational path**: multi-turn clarify → answer → build → test → second clarify → modify → re-test all worked through the real chat UI, including a mid-conversation design change (native web search → nested `tools` array).

Gaps:

- **G1 — requiredCredentials cannot verify the AST fix for ai-agent**: the list is static per bubble (probe above), so this E2E confirms the end state, not that the nested-tool AST detection produced it. A verification of S1a/S1b needs a nested tool whose credential is NOT in the host bubble's static list, or the triage surface that reads the AST result.
- **G2 — user's saved FIRECRAWL cred never binds**: `userCredentialsOfType:1` (cred id 7) yet `boundCredentialId:null`; `platformProvided:true` hides the slot from Setup entirely. The user asked in chat for "searches to go through my Firecrawl account" and got no binding and no surfaced choice — platform env wins silently. If per-user Firecrawl billing matters, this is a product gap; if platform-provided is the intended terminal state, the chat agent should at least say the user key will not be used.
- **G3 — Setup counts alternative model providers as missing requirements**: "4 of 5 required connections still missing" for Gemini/Anthropic/OpenRouter/Fireworks although the flow uses `openai/gpt-5-mini` and ran end-to-end without them. The static option list leaks into the Setup tab as fake obligations; a fresh user would read this as a broken flow.
- **G4 — agent's first design bypasses the nested-tool path**: given a "search the web" prompt the codegen agent prefers `nativeCapabilities: ['web-search']` over `tools: [{name:'web-search-tool'}]`, so the S1 code path may rarely trigger from organic prompts; it took an explicit user steer to produce a tools array.

Cleanup: flow 236 intentionally left in the DB (its credential-state and build thread are the evidence base for G1–G3). Automation note for future UI tests: after `set_flow_defaults` the canvas "Default Input Values" textareas precede the chat box in DOM order, so `document.querySelector('textarea')` writes into the flow's default inputs; target the chat box by placeholder ("Ask Pearl to...") or accessibility ref.

# Agent: backend-telemetry-e2e-retry

Date: 2026-08-05 (~08:15–08:20 UTC). Stack: API :3102, sidecar :3103, studio :3104, branch phase4-builder-harness. Method: event-test harness only (`scripts/event-test/harness.mjs`), no DOM. Test flows 238–244 created and auto-deleted by harness cleanup; nothing left in the DB.

## 1. Scenario: an AST-walk signal the static superset cannot mask

The frontend section's G1 stands: for ai-agent, `requiredCredentials` unions the static `BUBBLE_CREDENTIAL_OPTIONS['ai-agent']` list with the AST-walk result (`bubble-flow-parser.ts:668-718`), and FIRECRAWL_API_KEY sits in the static list (`packages/bubble-shared-schemas/src/credential-schema.ts:3127-3134` — OPENAI, GEMINI, ANTHROPIC, FIRECRAWL, OPENROUTER, FIREWORKS; nothing else). The discriminator is a nested tool whose credential is OUTSIDE that list: `sql-query-tool` → DATABASE_CRED, `instagram-tool` → APIFY_CRED. Those types reach `requiredCredentials` through the AST walk or not at all, so the SAME surface the frontend probe found inconclusive becomes conclusive with the right tool choice.

Two test runs, both against the live :3102 stack:

- `node scripts/event-test/run`-style direct run of the existing `scripts/event-test/tests/s1a_ast_detection.test.mjs` (resolver layer, seeded flows 238–242).
- A new probe script (scratchpad, not committed): control/treatment `requiredCredentials` diff + `/credential-state` + one REAL sidecar build turn via `t.buildMessage` + telemetry assertion (flows 243–244).

## 2. Expected result

- Control (ai-agent, NO tools array): `requiredCredentials` = the six static types only.
- Treatment (`tools: TOOLS` where `const TOOLS = [{ name: 'sql-query-tool' }]` — a const binding the old `new Function('return ' + value)` string-eval could NOT resolve): the six static types PLUS DATABASE_CRED.
- const-array / spread / ternary / const-string variants all resolve; the dynamic (function-call) case emits a typed `unresolvedToolDetections` record instead of silently claiming or dropping.
- The build agent's `inspect_flow_credentials` sees the AST-derived slot, and the API logs `flow.credential_state.read` telemetry for the grounding read.

## 3. Actual result (pasted evidence)

### s1a_ast_detection.test.mjs — 22/22 assertions pass, exit 0

```json
"spread: detects APIFY_CRED for the nested tool" — {"411":["OPENAI_CRED","GOOGLE_GEMINI_CRED","ANTHROPIC_CRED","FIRECRAWL_API_KEY","OPENROUTER_CRED","FIREWORKS_CRED","DATABASE_CRED","APIFY_CRED"]}
"ternary: detects DATABASE_CRED for the nested tool" — {"411":[...six static...,"APIFY_CRED","DATABASE_CRED"]}
"const-string-name: detects DATABASE_CRED" — {"411":[...six static...,"DATABASE_CRED"]}
"dynamic: does NOT silently claim DATABASE_CRED" — {"413":[six static only]}
"dynamic: reported as a typed unresolved record" — [{"bubbleName":"413","bubbleType":"ai-agent","param":"tools","reason":"dynamic-expression","snippet":"pickTools('query')"}]
```

### Control/treatment diff on the LIVE flow-detail surface (flows 243/244)

```json
control (no tools):      {"410":["OPENAI_CRED","GOOGLE_GEMINI_CRED","ANTHROPIC_CRED","FIRECRAWL_API_KEY","OPENROUTER_CRED","FIREWORKS_CRED"]}
treatment (sql tool):    {"411":["OPENAI_CRED","GOOGLE_GEMINI_CRED","ANTHROPIC_CRED","FIRECRAWL_API_KEY","OPENROUTER_CRED","FIREWORKS_CRED","DATABASE_CRED"]}
credential-state slot:   {"bubbleKey":"411","variableName":"agent","bubbleName":"ai-agent","credentialType":"DATABASE_CRED","system":false,"platformProvided":false,"boundCredentialId":null,"boundRowExists":false,"userCredentialsOfType":0}
```

### Real sidecar build turn (t.buildMessage, POST /build/244/message SSE, 27 frames)

Tool calls: `["mcp__builder__inspect_flow_credentials"]`. Agent reply (verbatim head):

> The flow needs OPENAI_CRED and FIRECRAWL_API_KEY, both platform-provided (system-injected, nothing for you to connect), plus GOOGLE_GEMINI_CRED, ANTHROPIC_CRED, OPENROUTER_CRED, FIREWORKS_CRED, and DATABASE_CRED, none of which are bound or platform-provided and none have any user credentials connected.

Telemetry (GET /telemetry, seq-filtered to the turn):

```json
{
  "event": "flow.credential_state.read",
  "ts": "2026-08-05T08:19:12.080Z",
  "flowId": 244,
  "slotCount": 7,
  "unboundSlots": 5,
  "danglingSlots": 0,
  "platformProvidedSlots": 2
}
```

`slotCount:7` = six static + the AST-derived DATABASE_CRED; `platformProvidedSlots:2` = OPENAI + FIRECRAWL (matches the frontend C2 classification from the event side); `unboundSlots:5` includes DATABASE_CRED. Emit site: `apps/bubblelab-api/src/routes/bubble-flows.ts:869`. No `credentials.builder_notify` / `builder.auto_unblock` events fired during this turn — correct, those fire only on credential WRITES (verified event chain lives in `scripts/event-test/tests/fe1_credential_gap_autorun.test.mjs`, which asserts them on POST /credentials).

## 4. Verdict: CONFIRMED (closes frontend gap G1)

- The AST walk demonstrably changes `requiredCredentials` (control vs treatment diff on the live API): DATABASE_CRED appears ONLY with the nested tool, through a const-binding call site the pre-fix string-eval provably could not resolve.
- The AST result flows to every downstream surface tested: flow-detail, `/credential-state` (a real per-slot row with binding metadata, `platformProvided:false` so it is user-actionable), the build agent's own `inspect_flow_credentials`, and the `flow.credential_state.read` telemetry event with slot counts.
- The dynamic case degrades to a typed `unresolvedToolDetections` record, never a silent drop (corroborates frontend C2 at the detection layer).
- Layer note: the s1a run re-verifies the resolver layer (already covered by that committed test); the new control/treatment probe plus the real build turn adds the previously missing proof that the LIVE flow-detail/credential-state/telemetry surfaces carry the AST result, which is what G1 asked for.

Remaining gaps (unchanged from frontend section): G2 (platform env silently outranks a saved user FIRECRAWL cred), G3 (static model-provider list leaks into Setup as fake obligations — visible here too: `unboundSlots:5` counts four unused model providers), G4 (organic codegen prefers nativeCapabilities over a tools array).

Cleanup: all seven test flows (238–244) deleted by harness auto-cleanup; harness runs self-logged as `event_test.run` telemetry events. Raw frame dump: `scripts/event-test/.reports/backend_telemetry_e2e_retry-1785917941.events.json`.
