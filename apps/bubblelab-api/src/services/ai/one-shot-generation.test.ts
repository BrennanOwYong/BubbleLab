/**
 * One-shot prompt -> workflow generation: exit discipline and live catalogue.
 *
 * These tests exercise the REAL generator building blocks (no mocks of the
 * unit under test): the final-result shaping that makes the validator the
 * only successful exit, the live side-effect-aware catalogue, and the
 * test-mode semantics every code-writing prompt carries.
 */
// @ts-expect-error - Bun test types
import { describe, it, expect } from 'bun:test';
import { BubbleFactory, ResendBubble } from '@bubblelab/bubble-core';
import type { BubbleClassWithMetadata } from '@bubblelab/bubble-core';
import {
  buildBubbleCatalogue,
  buildFinalGenerationResult,
} from './bubbleflow-generator.workflow.js';
import {
  BUBBLE_SPECIFIC_INSTRUCTIONS,
  SIDE_EFFECT_AND_TEST_MODE_INSTRUCTIONS,
} from '../../config/bubbleflow-generation-prompts.js';

describe('validator-only exit (fails loudly, never emits garbage)', () => {
  const toolCalls: never[] = [];

  it('code that fails static validation yields success=false carrying the errors', () => {
    const result = buildFinalGenerationResult({
      agentSucceeded: true,
      agentError: '',
      toolCalls,
      currentCode: 'export class Broken {}',
      finalValidation: {
        valid: false,
        errors: ['line 1: Code must contain a class that extends BubbleFlow'],
      },
    });
    expect(result.success).toBe(false);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('failed static validation');
    expect(result.error).toContain('extends BubbleFlow');
  });

  it('an impossible prompt (no code produced) fails loudly with the model explanation', () => {
    const result = buildFinalGenerationResult({
      agentSucceeded: true,
      agentError: '',
      agentResponse:
        'This request cannot be implemented: no bubble can reverse time.',
      toolCalls,
      currentCode: undefined,
      finalValidation: { valid: false, errors: ['No code was generated'] },
    });
    expect(result.success).toBe(false);
    expect(result.generatedCode).toBe('');
    expect(result.error).toContain('no workflow code');
    expect(result.error).toContain('reverse time');
  });

  it('only validated code exits with success=true', () => {
    const result = buildFinalGenerationResult({
      agentSucceeded: true,
      agentError: '',
      toolCalls,
      currentCode: 'export class Fine extends BubbleFlow {}',
      finalValidation: { valid: true },
    });
    expect(result.success).toBe(true);
    expect(result.isValid).toBe(true);
    expect(result.error).toBe('');
  });
});

describe('live capability catalogue with side-effect hints', () => {
  it('reads operation side effects from the live factory (never a snapshot)', () => {
    const factory = new BubbleFactory();
    factory.register('resend', ResendBubble as BubbleClassWithMetadata);

    const catalogue = buildBubbleCatalogue(factory);
    const resendLine = catalogue
      .split('\n- ')
      .find((entry) => entry.startsWith('resend:'));
    expect(resendLine).toBeDefined();
    expect(resendLine).toContain('send_email=write');
    expect(resendLine).toContain('get_email_status=read');
  });
});

describe('test-mode semantics reach every code-writing prompt', () => {
  it('BUBBLE_SPECIFIC_INSTRUCTIONS embeds the side-effect/test-mode block', () => {
    // BUBBLE_SPECIFIC_INSTRUCTIONS is composed into the generator workflow,
    // Pearl, and Rice prompts — one block, every path.
    expect(BUBBLE_SPECIFIC_INSTRUCTIONS).toContain(
      SIDE_EFFECT_AND_TEST_MODE_INSTRUCTIONS
    );
    expect(SIDE_EFFECT_AND_TEST_MODE_INSTRUCTIONS).toContain('MOCKED');
    expect(SIDE_EFFECT_AND_TEST_MODE_INSTRUCTIONS).toContain(
      'DID NOT HAPPEN'
    );
    expect(SIDE_EFFECT_AND_TEST_MODE_INSTRUCTIONS).toContain(
      'mocked write having taken effect'
    );
  });
});
