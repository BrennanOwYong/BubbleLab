import type { BubbleName } from '@bubblelab/shared-schemas';

/**
 * Configuration for special parameter handling in the BubbleNode inline
 * parameter form (the section a node expands to reveal).
 *
 * Each entry maps a bubble name to an array of parameter configs:
 * - paramName: The parameter name as defined in the bubble schema
 * - paramPath: The path to extract the value (for nested params like model.model)
 * - isModel: If true, displays as a model dropdown in the form's Model section
 *            and editability is determined by whether value is a valid model
 * - inlineDisplay: Legacy display hint retained on the config entries
 */
export interface InlineParamConfig {
  paramName: string;
  paramPath: string;
  isModel: boolean;
  inlineDisplay: 'dropdown' | 'preview' | 'none';
  label?: string; // Optional display label (defaults to paramName)
}

export type BubbleInlineParamsConfig = Partial<
  Record<BubbleName, InlineParamConfig[]>
>;

/**
 * Bubble-specific inline param configs
 */
export const BUBBLE_INLINE_PARAMS: BubbleInlineParamsConfig = {
  'ai-agent': [
    {
      paramName: 'model',
      paramPath: 'model.model',
      isModel: true,
      inlineDisplay: 'dropdown',
      label: 'Model',
    },
    {
      paramName: 'systemPrompt',
      paramPath: 'systemPrompt',
      isModel: false,
      inlineDisplay: 'preview',
      label: 'System Prompt',
    },
  ],
  'research-agent-tool': [
    {
      paramName: 'model',
      paramPath: 'model',
      isModel: true,
      inlineDisplay: 'dropdown',
      label: 'Model',
    },
  ],
};

/**
 * Wildcard patterns for params that should always show inline
 * regardless of bubble type. Matches are case-insensitive.
 */
export const WILDCARD_INLINE_PARAMS: InlineParamConfig[] = [
  {
    paramName: 'url',
    paramPath: 'url',
    isModel: false,
    inlineDisplay: 'preview',
    label: 'URL',
  },
  {
    paramName: 'limit',
    paramPath: 'limit',
    isModel: false,
    inlineDisplay: 'preview',
    label: 'Limit',
  },
];

/**
 * Check if a param is configured as a model selector.
 * This is used by extractParamValue to determine editability rules.
 */
export function isModelParam(
  bubbleName: string | undefined,
  paramName: string
): { isModel: boolean; paramPath: string } | undefined {
  if (!bubbleName) return undefined;
  const configs = BUBBLE_INLINE_PARAMS[bubbleName as BubbleName];
  if (!configs) return undefined;
  const config = configs.find((c) => c.paramName === paramName && c.isModel);
  if (!config) return undefined;
  return { isModel: true, paramPath: config.paramPath };
}

/**
 * Get inline param configs for a bubble name.
 * Returns bubble-specific configs only (wildcards are handled separately).
 */
export function getInlineParamConfigs(
  bubbleName: string | undefined
): InlineParamConfig[] {
  if (!bubbleName) return [];
  return BUBBLE_INLINE_PARAMS[bubbleName as BubbleName] ?? [];
}

/**
 * Get inline param config for a specific param, checking both
 * bubble-specific configs and wildcard patterns.
 */
export function getInlineParamConfig(
  bubbleName: string | undefined,
  paramName: string
): InlineParamConfig | undefined {
  // First check bubble-specific configs
  const bubbleConfigs = getInlineParamConfigs(bubbleName);
  const bubbleConfig = bubbleConfigs.find(
    (c) => c.paramName.toLowerCase() === paramName.toLowerCase()
  );
  if (bubbleConfig) return bubbleConfig;

  // Then check wildcard patterns (case-insensitive)
  return WILDCARD_INLINE_PARAMS.find(
    (c) => c.paramName.toLowerCase() === paramName.toLowerCase()
  );
}

/**
 * Get model param config for a bubble (if any)
 */
export function getModelParamConfig(
  bubbleName: string | undefined
): InlineParamConfig | undefined {
  const configs = getInlineParamConfigs(bubbleName);
  return configs.find((c) => c.isModel);
}

/**
 * Check if a bubble has a model param
 */
export function hasModelParam(bubbleName: string | undefined): boolean {
  return getModelParamConfig(bubbleName) !== undefined;
}

/**
 * Get params that should be excluded from the Parameters section
 * (because they're shown in the Model section).
 *
 * Note: This only excludes model params (those with isModel: true).
 * Other inline params (like systemPrompt preview) are still shown in Parameters.
 */
export function getExcludedParamNames(
  bubbleName: string | undefined
): string[] {
  const configs = getInlineParamConfigs(bubbleName);
  // Exclude model params from the Parameters section (they have their own section)
  return configs.filter((c) => c.isModel).map((c) => c.paramName);
}
