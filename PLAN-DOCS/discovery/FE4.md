# FE4 — Native-capability discovery (design brief)

Status: DISCOVERY / DESIGN ONLY. No source touched. Backlog row: FE4 (Phase 3,
`BACKLOG.md:108`). Governed by `DISPATCH-CONTRACT.md` (all six pillars).

## Problem

A research-shaped prompt today yields a flow whose `ai-agent` bubble binds
`web-search-tool` / `web-scrape-tool`. Both are thin wrappers over Firecrawl
(`packages/bubble-core/src/bubbles/tool-bubble/web-search-tool.ts:4` imports
`FirecrawlBubble`; credential `FIRECRAWL_API_KEY`, SYSTEM-typed). That chain is
the known weakest link in the product: the SYSTEM cred has a broken resolution
path (env-name mismatch, agent-tool slots left unbound, failures masked as "No
content available" — see memory `firecrawl-nested-cred-inconsistency`, tracked
systemically as S1).

Meanwhile every executing agent in the stack already carries a NATIVE search
ability the discovery data never mentions:

| Agent substrate                          | Native capability  | Mechanism                                                                                                           |
| ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Flow-runtime `ai-agent` on `openai/*`    | web search         | OpenAI built-in `web_search` tool (Responses API) or `web_search_options` (chat completions, search-preview models) |
| Flow-runtime `ai-agent` on `anthropic/*` | web search         | Anthropic server tool `web_search_20250305`                                                                         |
| Flow-runtime `ai-agent` on `google/*`    | web search         | Gemini Google Search grounding                                                                                      |
| Build-time sidecar (Claude Code)         | web search + fetch | native `WebSearch` / `WebFetch` tools (currently disabled: `builder.ts:175` allows only `mcp__builder__*`)          |

The builder's discovery step (`get_bubble_details`, wrapping
`GetBubbleDetailsTool` via `GET /bubble-flow/bubble-details/:bubbleName`,
`apps/bubblelab-api/src/routes/bubble-flows.ts:596`) returns params, result
shape, and usage example — nothing about what the agent can do without a tool.
The SDK reference the builder authors against
(`services/builder-agent/BUBBLELAB_SDK_DISTILLED.md` §4.5–4.7) points research
at the Firecrawl tools. So the builder bolts on a redundant tool because the
discovery data gives it no alternative.

Precedent inside the codebase: `isDeepResearchModel()`
(`ai-agent.ts:831`) is already an ad-hoc native-capability special case (two
OpenRouter deep-research models bypass LangChain). FE4 generalizes that
one-off into declared discovery data.

## Approach

Three deliverables plus one optional scope extension. The invariant: **at task
assignment, the discovery data enumerates the executing agent's native
capabilities, and the routing rule prefers a native capability over any tool
bubble it replaces.** The manifest is one typed source consumed by every
discovery surface, so future agents (page-builder, dashboard agent, FE5
sidecar-subroutine) reuse it without per-case rework.

### 1. Native-capability manifest (data)

New module `packages/bubble-shared-schemas/src/native-capabilities.ts`: a
typed, static manifest. First entry: `web-search`. Each entry declares what it
replaces and which substrates/providers implement it (see Data model). Export
through the package index so bubble-core, the API, and the sidecar all read
the same record.

### 2. Discovery integration (the FE4 core)

- `GetBubbleDetailsTool` result gains an optional `nativeCapabilities` field,
  populated from the manifest for bubbles that declare them (only `ai-agent`
  initially). The API route passes `result.data` through untouched
  (`bubble-flows.ts:609` `c.json(result.data)`), and the sidecar's response
  schema is `.passthrough()` (`services/builder-agent/src/tools.ts:59`), so
  the field reaches the builder with no route/sidecar schema change.
- `BUBBLELAB_SDK_DISTILLED.md`: amend §4.5 (ai-agent) with the
  `nativeCapabilities` param and add a **capability-routing rule** section;
  scope §4.6/§4.7 (web-search/scrape tools) to "structured extraction of
  specific known URLs only".
- `prompts.ts` BUILD_SOP: one new numbered rule — before binding any tool to
  an `ai-agent`, check the bubble-details `nativeCapabilities`; when a native
  capability covers the task (open-web research → `web-search`), enable it via
  the param and bind NO replaced tool bubble.

### 3. Runtime capability (make the native path real)

`AIAgentBubble` gains param `nativeCapabilities: z.array(z.enum(['web-search'])).default([])`.
When it contains `'web-search'` and the model's provider has an implemented
mechanism, `initializeModel()` / the `bindTools` site (`ai-agent.ts:999`,
`:2429`) attach the provider-native search tool instead of any LangGraph tool.
Provider order of implementation: **openai first** (deployed env has only
`OPENAI_API_KEY`; LLM routing is all-OpenAI per memory `llm-routing-and-agent-kivs`),
anthropic/google declared in the manifest as `implemented: false` until built.
Unsupported provider + requested capability → emit a `warn` StreamingLogEvent
naming the gap and continue; never silent.

Pillar-2 observability (new behavior must emit an event): when the provider
executes a native search, emit `tool_call_start` / `tool_call_complete` with
`tool: 'native-web-search'` (the `tool` field is a plain `string`,
`streaming-events.ts:110`, so no schema change; the studio renders it as a
normal tool chip) and record a serviceUsage entry
(`service: 'openai', subService: 'native-web-search'`) so `/executions` and
the SSE stream both prove the native path ran. Detection source: the provider
response metadata (Responses API `web_search_call` output items /
annotations) — confirmed against official docs at implementation time (see
Sources).

### 4. Optional (clarifying question 1): sidecar native research

Add `'WebSearch'` (and possibly `'WebFetch'`) to `allowedTools` in
`builder.ts:175` so build-time setup research (the "discover the 6 plantation
names" class of work) runs on the sidecar's own native search instead of the
agent authoring throwaway search bubbles. Small diff, behavioral blast radius
on every build turn — gated on the user's answer.

## Files to create / modify

| File                                                                      | Action                | Why                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/bubble-shared-schemas/src/native-capabilities.ts`               | CREATE                | The manifest: single typed source of native-capability discovery data                                                                                                                                                                  |
| `packages/bubble-shared-schemas/src/index.ts`                             | modify                | Export the manifest types/const                                                                                                                                                                                                        |
| `packages/bubble-core/src/bubbles/service-bubble/ai-agent.ts`             | modify                | `nativeCapabilities` param; provider-native binding at `initializeModel`/`bindTools`; emit `tool_call_*`/serviceUsage/warn events; update `tools` param description (`:337`) and `longDescription` (`:505`) to route research natively |
| `packages/bubble-core/src/bubbles/tool-bubble/get-bubble-details-tool.ts` | modify                | Result schema + population of `nativeCapabilities` from the manifest — the discovery record itself                                                                                                                                     |
| `services/builder-agent/BUBBLELAB_SDK_DISTILLED.md`                       | modify                | The builder's authoritative reference: capability-routing rule; re-scope §4.6/§4.7                                                                                                                                                     |
| `services/builder-agent/src/prompts.ts`                                   | modify                | BUILD_SOP capability-routing rule (mirrors the SDK doc so both discovery surfaces agree)                                                                                                                                               |
| `services/builder-agent/src/builder.ts`                                   | modify (optional, Q1) | `allowedTools` += `WebSearch` for build-time research                                                                                                                                                                                  |
| `scripts/event-test/fe4-native-search.mjs`                                | CREATE                | The event-based acceptance test (thin script on the F0.1 harness; see Test)                                                                                                                                                            |
| `BACKLOG.md`                                                              | modify                | Row status/PR/verified-by per Pillar 6                                                                                                                                                                                                 |

No change needed (verify only): `apps/bubblelab-api/src/routes/bubble-flows.ts`
(passthrough), `services/builder-agent/src/tools.ts` (zod `.passthrough()`),
`packages/bubble-shared-schemas/src/streaming-events.ts` (reusing
`tool_call_*` with a string tool name).

## Data model / state

```ts
// packages/bubble-shared-schemas/src/native-capabilities.ts
export type NativeCapabilityId = 'web-search'; // extensible: 'web-fetch', 'code-execution', ...

export interface NativeCapability {
  id: NativeCapabilityId;
  description: string; // what task class it covers ("open-web research/search")
  replaces: BubbleName[]; // ['web-search-tool'] (+ 'web-scrape-tool' for search-result reading)
  notReplaced: string; // "structured scrape/crawl/extract of specific known URLs"
  substrates: {
    'ai-agent'?: {
      providers: Partial<
        Record<
          'openai' | 'anthropic' | 'google',
          {
            mechanism: string; // e.g. "Responses API built-in web_search tool"
            implemented: boolean; // openai: true first; others declared, not wired
          }
        >
      >;
    };
    'builder-agent'?: {
      mechanism: 'claude-code native WebSearch';
      implemented: boolean;
    };
  };
}
export const NATIVE_CAPABILITIES: readonly NativeCapability[];
```

- `AIAgentBubble` param: `nativeCapabilities: string enum array, default []`.
  Lives in flow code → parsed into `bubble_parameters` like any param, so the
  canvas/Setup surfaces see it with zero extra plumbing. Because no Firecrawl
  bubble is authored, no `FIRECRAWL_API_KEY` slot ever appears — the S1
  unbound-slot trap is sidestepped (not fixed; S1 stays open).
- `GetBubbleDetailsTool` result: `nativeCapabilities?: NativeCapability[]`
  (only the entries whose substrate covers the requested bubble).
- No new tables, no persisted state beyond flow code. The "discovery record"
  of the acceptance test = the bubble-details response + the build-thread
  transcript's `get_bubble_details` tool_use (already persisted via
  `session-store` and served by `GET /build/:flowId/thread`).

## User-facing clarifying questions

1. **Sidecar native search on/off:** enable `WebSearch` for the builder agent
   itself (build-time research), or keep FE4 scoped to flow-runtime routing?
   The allowlist change is one line but affects every build turn.
2. **Firecrawl tools' remaining role:** keep `web-scrape/crawl/extract-tool`
   as legitimate for specific-URL structured extraction (proposed), or park
   them entirely until S1 lands? Proposed answer keeps them with the narrowed
   routing rule.
3. **Enforcement strength:** FE4 ships the routing rule as prompt + discovery
   data only. Should a follow-up row add a lint warning when `web-search-tool`
   is bound to an `ai-agent` whose model provider has an implemented native
   search? (Recommended as a fresh backlog row, not FE4 scope.)

## Event-based acceptance test (Pillar 2)

`scripts/event-test/fe4-native-search.mjs` — thin script on the F0.1 harness
(F0.1 is TODO; until it lands, model on
`services/builder-agent/test/benchmark.mjs`). Two parts, both assert on logged
events/records, never the DOM; exit non-zero with `failedAssertions` on any
miss.

**Part A — runtime capability (deterministic, no LLM builder in the loop).**
Seed a fixture flow whose `ai-agent` has `nativeCapabilities: ['web-search']`,
`tools: []`, an openai model. `POST /bubble-flow/:id/execute-stream` with a
research prompt, then assert on the SSE `StreamingLogEvent`s:

1. `execution_complete{success: true}`;
2. ≥1 `tool_call_start`/`tool_call_complete` with `tool: 'native-web-search'`;
3. zero `tool_call_*` events naming `web-search-tool`; no serviceUsage entry
   naming firecrawl;
4. `GET /bubble-flow/:id/executions?limit=1` → persisted result present.

**Part B — discovery + routing (the FE4 claim).**

1. Discovery record: `GET /bubble-flow/bubble-details/ai-agent` →
   `nativeCapabilities` non-empty, contains `id: 'web-search'` with
   `replaces` including `web-search-tool`.
2. Build from prompt via the sidecar (`POST /build/:flowId/message`, prompt:
   "Research today's top 3 headlines about <topic> and produce a one-line
   summary of each"). Then `GET /build/:flowId/thread` → transcript contains
   `tool_use get_bubble_details{bubbleName:'ai-agent'}` and `save_flow`.
3. `GET /bubble-flow/:flowId` → saved code contains
   `nativeCapabilities: ['web-search']` and does NOT contain
   `web-search-tool`; `requiredCredentials` carries no `FIRECRAWL_API_KEY`.
4. Run the built flow and repeat Part A's event assertions.

Part A isolates the runtime mechanism from builder nondeterminism; Part B is
the routing gate. A Part-B failure with Part A green localizes the defect to
the discovery/prompt layer.

`[USER-TEST]`: none — FE4 changes agent routing and discovery data, no screen.
The one visible side effect (Setup tab no longer lists a Firecrawl need on
research flows) is asserted in Part B step 3.

## Dependency surface (Pillar 5 pre-map)

- `ai-agent.ts` — registered in `bubble-factory.ts`, exported via
  `bubble-core/src/index.ts`; tests `ai-agent.test.ts`,
  `ai-agent.integration.test.ts`, `ai-agent-json-parsing.test.ts`. Change is
  additive (new param with `[]` default) → existing flows unaffected.
- `get-bubble-details-tool.ts` — consumers: API route
  `bubble-flows.ts:596`, sidecar `tools.ts` (passthrough), the in-process
  generator's tool list (`config/bubbleflow-generation-prompts.ts` references
  it), `get-bubble-details-tool.test.ts`. Additive optional field.
- `streaming-events.ts` — untouched (reuse `tool_call_*`); studio consumers
  (`collectRunErrorSignals`, run popup) treat `tool` as an opaque string.
- Build order after schema change: shared-schemas → core → runtime → api
  (memory `wsl-mntc-pnpm-eacces`: use `~/.bun/bin/bun`, stale dist is silent).
- Type safety: LangChain built-in-tool bindings typed against
  `@langchain/openai`'s published types — no `as any` (CLAUDE.md standing
  rule; the Gluu BYOC bug precedent).

## Risks

1. **OpenAI mechanism choice is the main technical risk.** The built-in
   `web_search` tool requires the Responses API; `ChatOpenAI` needs
   `useResponsesApi: true`, which changes response/streaming shapes and may
   interact with the existing `reasoning` config and gpt-5 quirks (memory:
   gpt-5 rejects temperature). The chat-completions alternative
   (`web_search_options`) is limited to search-preview models not in
   `AvailableModels`. Pillar-5 research against the official docs is
   MANDATORY before a line of implementation; persist deep links in the
   module's `## Sources`.
2. **Builder routing is probabilistic.** The LLM may still bind
   `web-search-tool` despite the rule. Mitigation: rule stated in both
   discovery surfaces (SDK doc + SOP), Part A/B test split, and
   `benchmark.mjs` regression to catch build-behavior drift.
3. **Over-broad routing degrades scrape flows.** Native search does not read
   a specific URL's full content. The routing rule must scope native search to
   open-web research and keep scrape/crawl/extract for URL-specific work
   (question 2).
4. **Cost/accounting shift.** Native search bills to the OpenAI account
   instead of Firecrawl credits; the serviceUsage entry keeps it observable.
5. **Masking S1.** FE4 removes the most common Firecrawl exposure; S1's
   nested-tool credential resolution stays broken for every remaining tool
   bubble. Record in the PR that FE4 narrows, and does not close, S1.
6. **F0.1 not landed.** The test ships harness-shaped so it slots into
   `scripts/event-test/` when F0.1 exists; until then it runs standalone.

## Sources (verify + deep-link at implementation time, per Pillar 5)

- OpenAI web search tool (Responses API): https://platform.openai.com/docs/guides/tools-web-search
- LangChain `ChatOpenAI` built-in tools / `useResponsesApi`: https://js.langchain.com/docs/integrations/chat/openai
- Anthropic web search server tool: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
- Gemini Google Search grounding: https://ai.google.dev/gemini-api/docs/google-search
- Claude Agent SDK `allowedTools` (native WebSearch): https://docs.anthropic.com/en/api/agent-sdk/typescript
