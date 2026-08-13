import { z } from 'zod';
import type { BubbleName } from './types.js';

/**
 * FE4 — native-capability manifest.
 *
 * The single typed source of native-capability discovery data. At task
 * assignment the discovery surfaces (GetBubbleDetailsTool, the builder SDK
 * reference, the build SOP) enumerate the executing agent's native
 * capabilities from THIS record, and the routing rule prefers a native
 * capability over any tool bubble it replaces. One manifest serves every
 * substrate (flow-runtime ai-agent, build-time sidecar) so future agents
 * reuse it without per-case rework.
 *
 * Precedent generalized here: ai-agent's isDeepResearchModel() was an ad-hoc
 * native-capability special case (two deep-research models bypass LangChain);
 * FE4 turns that one-off pattern into declared discovery data.
 */

/** Substrates a native capability can live on. */
export const NATIVE_CAPABILITY_SUBSTRATES = [
  'ai-agent',
  'builder-agent',
] as const;
export type NativeCapabilitySubstrate =
  (typeof NATIVE_CAPABILITY_SUBSTRATES)[number];

/** Known capability ids — extensible: 'web-fetch', 'code-execution', ... */
export const NATIVE_CAPABILITY_IDS = ['web-search'] as const;
export type NativeCapabilityId = (typeof NATIVE_CAPABILITY_IDS)[number];

/** Model providers an ai-agent native capability can be implemented on. */
export const NATIVE_CAPABILITY_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
] as const;
export type NativeCapabilityProvider =
  (typeof NATIVE_CAPABILITY_PROVIDERS)[number];

const NativeCapabilityProviderSupportSchema = z.object({
  /** Provider-side mechanism, e.g. "OpenAI Responses API built-in web search tool". */
  mechanism: z.string(),
  /** True when the flow runtime actually wires this mechanism; declared-only otherwise. */
  implemented: z.boolean(),
});
export type NativeCapabilityProviderSupport = z.infer<
  typeof NativeCapabilityProviderSupportSchema
>;

export const NativeCapabilitySchema = z.object({
  id: z.enum(NATIVE_CAPABILITY_IDS),
  /** The task class this capability covers ("open-web research/search"). */
  description: z.string(),
  /** Tool bubbles this native capability replaces when enabled. */
  replaces: z.array(z.string() as z.ZodType<BubbleName>),
  /** The task class the replaced tools KEEP owning — the routing boundary. */
  notReplaced: z.string(),
  substrates: z.object({
    'ai-agent': z
      .object({
        providers: z.record(
          z.enum(NATIVE_CAPABILITY_PROVIDERS),
          NativeCapabilityProviderSupportSchema
        ),
      })
      .optional(),
    'builder-agent': NativeCapabilityProviderSupportSchema.optional(),
  }),
});
export type NativeCapability = z.infer<typeof NativeCapabilitySchema>;

/**
 * Tool name used on every event surface (tool_call_start/complete
 * StreamingLogEvents, result toolCalls, serviceUsage subService) when a
 * provider executes a native web search. The streaming `tool` field is a
 * plain string, so no event-schema change is needed.
 */
export const NATIVE_WEB_SEARCH_TOOL = 'native-web-search';

export const NATIVE_CAPABILITIES: readonly NativeCapability[] = [
  {
    id: 'web-search',
    description:
      'Open-web research/search: the model finds and reads current public-web information itself, with no bound tool bubble and no third-party search credential.',
    replaces: ['web-search-tool', 'web-scrape-tool'],
    notReplaced:
      'Structured scrape/crawl/extract of specific known URLs (web-scrape-tool, web-crawl-tool, web-extract-tool keep that task class).',
    substrates: {
      'ai-agent': {
        providers: {
          openai: {
            mechanism:
              "OpenAI Responses API built-in web search tool (openai@5.12.2 types it 'web_search_preview'); @langchain/openai bindTools auto-switches to the Responses API when a built-in tool is bound",
            implemented: true,
          },
          anthropic: {
            mechanism: 'Anthropic server tool web_search_20250305',
            implemented: false,
          },
          google: {
            mechanism: 'Gemini Google Search grounding',
            implemented: false,
          },
        },
      },
      'builder-agent': {
        mechanism: 'claude-code native WebSearch tool',
        implemented: false,
      },
    },
  },
];

function isSubstrate(name: string): name is NativeCapabilitySubstrate {
  return (NATIVE_CAPABILITY_SUBSTRATES as readonly string[]).includes(name);
}

/**
 * Discovery lookup: the native capabilities a given bubble/substrate carries.
 * Non-substrate bubbles get an empty list, so consumers can call this for any
 * bubble name without special-casing.
 */
export function getNativeCapabilitiesForBubble(
  bubbleName: string
): NativeCapability[] {
  if (!isSubstrate(bubbleName)) return [];
  return NATIVE_CAPABILITIES.filter(
    (cap) => cap.substrates[bubbleName] !== undefined
  );
}

/**
 * Runtime lookup: provider support for a capability on the ai-agent
 * substrate. Returns undefined for unknown providers/capabilities so the
 * caller can emit the not-implemented warning.
 */
export function getAiAgentProviderSupport(
  capabilityId: NativeCapabilityId,
  provider: string
): NativeCapabilityProviderSupport | undefined {
  const cap = NATIVE_CAPABILITIES.find((c) => c.id === capabilityId);
  const providers = cap?.substrates['ai-agent']?.providers;
  if (!providers) return undefined;
  if (!(NATIVE_CAPABILITY_PROVIDERS as readonly string[]).includes(provider)) {
    return undefined;
  }
  return providers[provider as NativeCapabilityProvider];
}

// ## Sources (verified 2026-08-01, per the docs-research rule)
// - OpenAI web search tool (Responses API): https://platform.openai.com/docs/guides/tools-web-search
//   (redirects to https://developers.openai.com/api/docs/guides/tools-web-search;
//   'web_search' is the current tool type, 'web_search_preview' the legacy one —
//   the pinned openai@5.12.2 SDK types only carry 'web_search_preview'; the
//   response carries a 'web_search_call' output item with id/status/action)
// - LangChain ChatOpenAI built-in tools: https://js.langchain.com/docs/integrations/chat/openai
//   (verified against installed @langchain/openai@0.6.14 source:
//   _useResponsesApi() flips to the Responses API when bindTools receives a
//   built-in tool; built-in tool calls surface on additional_kwargs.tool_outputs)
// - Anthropic web search server tool (declared, not wired): https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
// - Gemini Google Search grounding (declared, not wired): https://ai.google.dev/gemini-api/docs/google-search
