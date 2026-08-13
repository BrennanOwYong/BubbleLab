/**
 * U3 layout-math regression: the height a node reserves and the height its
 * text renders must agree (reserved >= rendered). Runs in the node
 * environment, so countWrappedLines takes its deterministic no-canvas
 * fallback path — the same path a headless assertion would exercise.
 */
import { describe, it, expect } from 'vitest';
import {
  STEP_CONTAINER_LAYOUT,
  CUSTOM_TOOL_LAYOUT,
  CUSTOM_TOOL_LIST_ROW_HEIGHT,
  DESCRIPTION_FONT,
  countWrappedLines,
  reservedDescriptionLines,
  calculateHeaderHeight,
  calculateStepContainerHeight,
  calculateBubblePosition,
  calculateCustomToolListHeight,
} from './stepContainerUtils';
import { FLOW_LAYOUT, transformationNodeHeight } from './flowLayoutConstants';

const SIXTY_CHAR_SENTENCE =
  'Collects the weather forecast and posts a summary to Slack.';
const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit '
  .repeat(19)
  .slice(0, 1000);
const UNBROKEN_TOKENS = Array.from({ length: 20 }, () => 'x'.repeat(30)).join(
  ' '
);

const DESCRIPTIONS = ['', 'short', SIXTY_CHAR_SENTENCE, LOREM, UNBROKEN_TOKENS];

const {
  HEADER_PADDING_Y,
  TITLE_LINE_HEIGHT,
  TITLE_MARGIN_BOTTOM,
  DESCRIPTION_LINE_HEIGHT,
  DESCRIPTION_MAX_LINES,
  BUBBLE_HEIGHT,
  PADDING,
  CUSTOM_TOOL_SCALE,
} = STEP_CONTAINER_LAYOUT;

describe('reserved >= rendered header math', () => {
  it.each(DESCRIPTIONS.map((d) => [d.slice(0, 24) || '(empty)', d]))(
    'header reservation covers title plus the clamped description: %s',
    (_label, description) => {
      expect(calculateHeaderHeight('fn', description)).toBeGreaterThanOrEqual(
        HEADER_PADDING_Y * 2 +
          TITLE_LINE_HEIGHT +
          TITLE_MARGIN_BOTTOM +
          reservedDescriptionLines(description) * DESCRIPTION_LINE_HEIGHT
      );
    }
  );

  it('reservedDescriptionLines never exceeds the render clamp', () => {
    for (const description of DESCRIPTIONS) {
      expect(reservedDescriptionLines(description)).toBeLessThanOrEqual(
        DESCRIPTION_MAX_LINES
      );
    }
  });
});

describe('slot containment', () => {
  it('every bubble slot fits inside the container for all header heights', () => {
    for (const description of DESCRIPTIONS) {
      const headerHeight = calculateHeaderHeight('fn', description);
      for (let n = 1; n <= 6; n++) {
        for (let i = 0; i < n; i++) {
          expect(
            calculateBubblePosition(i, headerHeight).y + BUBBLE_HEIGHT + PADDING
          ).toBeLessThanOrEqual(calculateStepContainerHeight(n, headerHeight));
        }
      }
    }
  });

  it('custom-tool list height covers the scaled header plus every row', () => {
    for (const description of DESCRIPTIONS) {
      const headerHeight = calculateHeaderHeight('fn', description);
      const scaledHeader = Math.round(headerHeight * CUSTOM_TOOL_SCALE);
      expect(calculateCustomToolListHeight(0, headerHeight)).toBe(scaledHeader);
      for (let k = 1; k <= 8; k++) {
        expect(
          calculateCustomToolListHeight(k, headerHeight)
        ).toBeGreaterThanOrEqual(
          scaledHeader +
            CUSTOM_TOOL_LAYOUT.PADDING * 2 +
            k * CUSTOM_TOOL_LIST_ROW_HEIGHT
        );
      }
    }
  });
});

describe('transformation node reservation', () => {
  it('reserves more when a description renders, from the shared constants', () => {
    expect(transformationNodeHeight(false)).toBe(
      FLOW_LAYOUT.TRANSFORMATION.FIXED_HEIGHT
    );
    expect(transformationNodeHeight(true)).toBe(
      FLOW_LAYOUT.TRANSFORMATION.WITH_DESCRIPTION_HEIGHT
    );
    expect(transformationNodeHeight(true)).toBeGreaterThan(
      transformationNodeHeight(false)
    );
  });
});

describe('countWrappedLines (deterministic fallback path)', () => {
  const MAX_WIDTH = 358;

  it('returns 0 for empty text and >= 1 otherwise', () => {
    expect(countWrappedLines('', MAX_WIDTH, DESCRIPTION_FONT)).toBe(0);
    expect(
      countWrappedLines('a', MAX_WIDTH, DESCRIPTION_FONT)
    ).toBeGreaterThanOrEqual(1);
  });

  it('is monotonic: extending the text never reduces the line count', () => {
    let previous = 0;
    for (let words = 1; words <= 60; words += 6) {
      const text = Array.from({ length: words }, () => 'wordy').join(' ');
      const lines = countWrappedLines(text, MAX_WIDTH, DESCRIPTION_FONT);
      expect(lines).toBeGreaterThanOrEqual(previous);
      previous = lines;
    }
  });

  it('is deterministic across calls', () => {
    for (const description of DESCRIPTIONS) {
      expect(countWrappedLines(description, MAX_WIDTH, DESCRIPTION_FONT)).toBe(
        countWrappedLines(description, MAX_WIDTH, DESCRIPTION_FONT)
      );
    }
  });

  it('accounts for unbroken tokens wider than the line', () => {
    const oneLongToken = 'y'.repeat(200);
    // 200 chars * 16px * 0.6 = 1920px => ceil(1920 / 358) = 6 line segments
    expect(
      countWrappedLines(oneLongToken, MAX_WIDTH, DESCRIPTION_FONT)
    ).toBeGreaterThanOrEqual(5);
  });
});
