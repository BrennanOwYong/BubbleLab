// Layout constants - single source of truth for bubble spacing and positioning
export const STEP_CONTAINER_LAYOUT = {
  WIDTH: 400,
  PADDING: 20,
  INTERNAL_WIDTH: 360, // WIDTH - (PADDING * 2)
  HEADER_HEIGHT: 230, // Default/fallback header height
  MIN_HEADER_HEIGHT: 80, // Minimum header height (for short titles)
  HEADER_PADDING_Y: 16, // Vertical padding in header (py-4 = 1rem = 16px)
  HEADER_PADDING_X: 20, // Horizontal padding in header (px-5 = 1.25rem = 20px)
  TITLE_LINE_HEIGHT: 28, // Text-xl line height (~1.75rem)
  DESCRIPTION_LINE_HEIGHT: 24, // Text-base line height (~1.5rem)
  TITLE_MARGIN_BOTTOM: 4, // mb-1 = 0.25rem = 4px
  DESCRIPTION_MAX_LINES: 6, // Header description clamps here (ellipsis + title tooltip)
  HEADER_SAFETY_PAD: 8, // Slack added to the reserved description block (sub-pixel wrap drift)
  BUBBLE_HEIGHT: 72, // Fixed height allocation per collapsed plate slot (64px plate + breathing room)
  BUBBLE_SPACING: 20, // Gap from bottom of one bubble to top of next (fixed distance)
  BUBBLE_WIDTH: 320, // w-80 class
  BUBBLE_X_OFFSET: 40, // (WIDTH - BUBBLE_WIDTH) / 2

  // Custom tool scaling (similar to sub-bubbles)
  CUSTOM_TOOL_SCALE: 0.75, // Scale factor for custom tool containers (matches sub-bubble scale-75)
} as const;

/**
 * Get scaled dimensions for custom tool containers
 * Custom tool function calls are rendered smaller (like sub-bubbles)
 */
export const CUSTOM_TOOL_LAYOUT = {
  SCALE: STEP_CONTAINER_LAYOUT.CUSTOM_TOOL_SCALE,
  WIDTH: Math.round(
    STEP_CONTAINER_LAYOUT.WIDTH * STEP_CONTAINER_LAYOUT.CUSTOM_TOOL_SCALE
  ),
  BUBBLE_WIDTH: Math.round(
    STEP_CONTAINER_LAYOUT.BUBBLE_WIDTH * STEP_CONTAINER_LAYOUT.CUSTOM_TOOL_SCALE
  ),
  BUBBLE_HEIGHT: Math.round(
    STEP_CONTAINER_LAYOUT.BUBBLE_HEIGHT *
      STEP_CONTAINER_LAYOUT.CUSTOM_TOOL_SCALE
  ),
  BUBBLE_SPACING: Math.round(
    STEP_CONTAINER_LAYOUT.BUBBLE_SPACING *
      STEP_CONTAINER_LAYOUT.CUSTOM_TOOL_SCALE
  ),
  PADDING: Math.round(
    STEP_CONTAINER_LAYOUT.PADDING * STEP_CONTAINER_LAYOUT.CUSTOM_TOOL_SCALE
  ),
} as const;

/**
 * Font the header description renders in (text-base, Inter stack from
 * src/index.css). Used by the canvas measurement so the reserved line count
 * mirrors the browser's greedy word-wrap.
 */
export const DESCRIPTION_FONT =
  '16px Inter, system-ui, Avenir, Helvetica, Arial, sans-serif';

/** Per-char fallback width factor when no canvas exists (conservative: errs tall). */
const FALLBACK_CHAR_EM = 0.6;

// Single cached measurement context (created once, reused across nodes).
let measureCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  if (typeof document === 'undefined') {
    measureCtx = null;
    return null;
  }
  try {
    measureCtx = document.createElement('canvas').getContext('2d');
  } catch {
    measureCtx = null;
  }
  return measureCtx ?? null;
}

/**
 * Count the lines `text` occupies under greedy word-wrap (the browser's
 * `break-words` behavior): a word that does not fit moves whole to the next
 * line; a word wider than the line breaks at the width boundary.
 *
 * Uses canvas `measureText` when a DOM exists. Without one (vitest node env),
 * falls back to a deterministic 0.6em-per-char estimate, which overestimates
 * width — a wrong estimate reserves MORE lines, never fewer, so it cannot
 * cause spill.
 */
export function countWrappedLines(
  text: string,
  maxWidth: number,
  font: string
): number {
  if (!text) return 0;
  const ctx = getMeasureContext();
  const fontSizePx = Number.parseFloat(font) || 16;
  const measure = (s: string): number => {
    if (ctx) {
      ctx.font = font;
      const width = ctx.measureText(s).width;
      if (width > 0) return width;
    }
    return s.length * fontSizePx * FALLBACK_CHAR_EM;
  };

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;

  const spaceWidth = measure(' ');
  let lines = 1;
  let lineWidth = 0;
  for (const word of words) {
    const wordWidth = measure(word);
    if (lineWidth > 0 && lineWidth + spaceWidth + wordWidth > maxWidth) {
      lines += 1;
      lineWidth = 0;
    }
    if (wordWidth > maxWidth) {
      // break-words splits an over-long word at the width boundary.
      const fullLines = Math.floor(wordWidth / maxWidth);
      const remainder = wordWidth - fullLines * maxWidth;
      lines += remainder > 0 ? fullLines : fullLines - 1;
      lineWidth = remainder > 0 ? remainder : maxWidth;
    } else {
      lineWidth += (lineWidth > 0 ? spaceWidth : 0) + wordWidth;
    }
  }
  return lines;
}

/**
 * The single source of truth for how many description lines a step header
 * reserves AND renders. `calculateHeaderHeight` reserves this many lines;
 * StepContainerNode clamps the rendered `<p>` to the same count, so
 * reserved >= rendered holds by construction.
 *
 * Measured width matches the real header: the div spans the full container
 * WIDTH with px-5 padding (StepContainerNode.tsx), minus 2px border.
 */
export function reservedDescriptionLines(description: string): number {
  const { WIDTH, HEADER_PADDING_X, DESCRIPTION_MAX_LINES } =
    STEP_CONTAINER_LAYOUT;
  const availableWidth = WIDTH - HEADER_PADDING_X * 2 - 2;
  return Math.min(
    countWrappedLines(description, availableWidth, DESCRIPTION_FONT),
    DESCRIPTION_MAX_LINES
  );
}

/**
 * Calculate the dynamic header height based on text content
 * @param functionName - The function name to display
 * @param description - Optional description text
 * @returns Calculated header height in pixels
 */
export function calculateHeaderHeight(
  functionName: string,
  description?: string
): number {
  const {
    HEADER_PADDING_Y,
    TITLE_LINE_HEIGHT,
    DESCRIPTION_LINE_HEIGHT,
    TITLE_MARGIN_BOTTOM,
    MIN_HEADER_HEIGHT,
    HEADER_SAFETY_PAD,
  } = STEP_CONTAINER_LAYOUT;

  // Start with padding
  let height = HEADER_PADDING_Y * 2;

  // Add title height (always one line for function name; the title truncates)
  height += TITLE_LINE_HEIGHT + TITLE_MARGIN_BOTTOM;

  // Reserve exactly the line count the clamped description renders
  if (description) {
    height +=
      reservedDescriptionLines(description) * DESCRIPTION_LINE_HEIGHT +
      HEADER_SAFETY_PAD;
  }

  // Ensure minimum height
  return Math.max(height, MIN_HEADER_HEIGHT);
}

/**
 * Calculate the height of a step container based on the number of bubbles it contains
 * @param bubbleCount - Number of bubbles in the step
 * @param headerHeight - Optional dynamic header height (if not provided, uses default)
 */
export function calculateStepContainerHeight(
  bubbleCount: number,
  headerHeight?: number
): number {
  const actualHeaderHeight =
    headerHeight ?? STEP_CONTAINER_LAYOUT.HEADER_HEIGHT;

  if (bubbleCount === 0) {
    return actualHeaderHeight;
  }

  // Calculate content area height including padding
  const contentHeight =
    STEP_CONTAINER_LAYOUT.PADDING + // Top padding of content area
    bubbleCount * STEP_CONTAINER_LAYOUT.BUBBLE_HEIGHT +
    (bubbleCount - 1) * STEP_CONTAINER_LAYOUT.BUBBLE_SPACING +
    STEP_CONTAINER_LAYOUT.PADDING; // Bottom padding of content area

  return actualHeaderHeight + contentHeight;
}

/**
 * Calculate the position of a bubble within a step container
 * @param bubbleIndex - Zero-based index of the bubble within the step
 * @param headerHeight - Optional dynamic header height (if not provided, uses default)
 * @returns Position object with x and y coordinates relative to the container
 */
export function calculateBubblePosition(
  bubbleIndex: number,
  headerHeight?: number
): {
  x: number;
  y: number;
} {
  const actualHeaderHeight =
    headerHeight ?? STEP_CONTAINER_LAYOUT.HEADER_HEIGHT;

  return {
    x: STEP_CONTAINER_LAYOUT.BUBBLE_X_OFFSET,
    y:
      actualHeaderHeight +
      STEP_CONTAINER_LAYOUT.PADDING + // Account for content area's top padding
      bubbleIndex *
        (STEP_CONTAINER_LAYOUT.BUBBLE_HEIGHT +
          STEP_CONTAINER_LAYOUT.BUBBLE_SPACING),
  };
}

/** Height of one row in the custom-tool static tool-call list (px). */
export const CUSTOM_TOOL_LIST_ROW_HEIGHT = 40;

/**
 * Height of a custom tool step container: scaled header plus one compact row
 * per tool call. Custom-tool steps render a static list (no child bubble
 * cards), so the container fits the list rather than bubble-card slots.
 * @param toolCallCount - Number of tool calls listed in the container
 * @param headerHeight - Optional dynamic header height (scaled if not provided)
 */
export function calculateCustomToolListHeight(
  toolCallCount: number,
  headerHeight?: number
): number {
  const scale = CUSTOM_TOOL_LAYOUT.SCALE;
  const actualHeaderHeight = headerHeight
    ? Math.round(headerHeight * scale)
    : Math.round(STEP_CONTAINER_LAYOUT.HEADER_HEIGHT * scale);

  if (toolCallCount === 0) {
    return actualHeaderHeight;
  }

  return (
    actualHeaderHeight +
    CUSTOM_TOOL_LAYOUT.PADDING * 2 +
    toolCallCount * CUSTOM_TOOL_LIST_ROW_HEIGHT
  );
}
