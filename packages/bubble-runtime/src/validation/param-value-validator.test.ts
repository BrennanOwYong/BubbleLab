/**
 * Acceptance tests for static literal-parameter-value validation:
 * a flow carrying a bad literal parameter is rejected at compile time,
 * without the tool ever executing (validation never runs bubble code).
 *
 * Real behavior throughout: real BubbleFactory registry, real Zod schemas,
 * real parser — nothing about the unit under test is mocked.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { BubbleFactory } from '@bubblelab/bubble-core';
import { BubbleParameterType } from '@bubblelab/shared-schemas';
import { validateAndExtract } from './index.js';
import {
  validateBubbleParameterValues,
  evaluateLiteralSource,
} from './param-value-validator.js';

// registerDefaults scans ~280 bubble sources; on WSL /mnt/c this alone can
// take minutes (see docs/plan/deltas/ir8-side-effect-metadata.md).
const FACTORY_TIMEOUT = 600_000;

let factory: BubbleFactory;

beforeAll(async () => {
  factory = new BubbleFactory();
  await factory.registerDefaults();
}, FACTORY_TIMEOUT);

function resendFlow(paramsSource: string): string {
  return `
import { BubbleFlow, ResendBubble, WebhookEvent } from '@bubblelab/bubble-core';

export interface SendPayload extends WebhookEvent {
  /** Email address the message is sent to. */
  recipient?: string;
}

export class EmailFlow extends BubbleFlow<'webhook/http'> {
  // Sends a single email through Resend with the configured recipient and subject
  private async sendEmail(recipient: string) {
    const emailSender = new ResendBubble(${paramsSource});
    return await emailSender.action();
  }

  async handle(payload: SendPayload) {
    const { recipient = 'user@example.com' } = payload;
    const result = await this.sendEmail(recipient);
    return { sent: result.success };
  }
}
`;
}

describe('literal parameter value validation (pre-execution)', () => {
  it(
    'rejects a bad literal email without executing the tool',
    { timeout: FACTORY_TIMEOUT },
    async () => {
      const code = resendFlow(`{
      operation: 'send_email',
      to: 'not-an-email',
      subject: 'Hi',
      text: \`Hello \${recipient}\`,
    }`);
      const result = await validateAndExtract(code, factory, false);
      expect(result.valid).toBe(false);
      const paramErrors = (result.errors ?? []).filter((e) =>
        e.includes('[param-value]')
      );
      expect(paramErrors.length).toBeGreaterThan(0);
      expect(paramErrors[0]).toContain('"to"');
      expect(paramErrors[0]).toContain('resend.send_email');
    }
  );

  it(
    'rejects an unknown operation naming the valid ones',
    { timeout: FACTORY_TIMEOUT },
    async () => {
      // TS itself would flag this too, but the param-value layer must reject
      // it with an actionable message even before type-level feedback.
      const bubbles = {
        1: {
          variableName: 'emailSender',
          bubbleName: 'resend' as const,
          className: 'ResendBubble',
          hasAwait: true,
          hasActionCall: true,
          variableId: 1,
          nodeType: 'service' as const,
          location: { startLine: 12, startCol: 0, endLine: 12, endCol: 10 },
          parameters: [
            {
              name: 'operation',
              value: 'send_emial',
              type: BubbleParameterType.STRING,
            },
          ],
        },
      };
      const errors = validateBubbleParameterValues(bubbles, factory);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('unknown operation "send_emial"');
      expect(errors[0]).toContain('send_email');
    }
  );

  it(
    'rejects an empty literal subject (Zod min(1) is invisible to TypeScript)',
    { timeout: FACTORY_TIMEOUT },
    async () => {
      const code = resendFlow(`{
      operation: 'send_email',
      to: recipient,
      subject: '',
      text: 'Hello there',
    }`);
      const result = await validateAndExtract(code, factory, false);
      expect(result.valid).toBe(false);
      expect(
        (result.errors ?? []).some(
          (e) => e.includes('[param-value]') && e.includes('"subject"')
        )
      ).toBe(true);
    }
  );

  it(
    'accepts valid literals and skips runtime-dependent values',
    { timeout: FACTORY_TIMEOUT },
    async () => {
      const code = resendFlow(`{
      operation: 'send_email',
      to: recipient,
      subject: \`Update for \${recipient}\`,
      text: 'Hello there',
    }`);
      const result = await validateAndExtract(code, factory, false);
      const paramErrors = (result.errors ?? []).filter((e) =>
        e.includes('[param-value]')
      );
      expect(paramErrors).toEqual([]);
      expect(result.valid).toBe(true);
    }
  );
});

describe('evaluateLiteralSource', () => {
  it('evaluates plain object/array/number literals', () => {
    const res = evaluateLiteralSource(
      `{ name: 'a', count: -2, tags: ['x', 'y'], nested: { on: true } }`
    );
    expect(res?.value).toEqual({
      name: 'a',
      count: -2,
      tags: ['x', 'y'],
      nested: { on: true },
    });
    expect(res?.unknownPaths).toEqual([]);
  });

  it('marks runtime-dependent nested values as unknown, keeps siblings', () => {
    const res = evaluateLiteralSource(
      `{ subject: 'Hi', body: buildBody(), when: \`\${now}\` }`
    );
    expect(res).toBeDefined();
    expect((res!.value as Record<string, unknown>).subject).toBe('Hi');
    expect(res!.unknownPaths).toContain('body');
    expect(res!.unknownPaths).toContain('when');
  });

  it('returns undefined for a fully unknown expression', () => {
    expect(evaluateLiteralSource('someVariable')).toBeUndefined();
    expect(evaluateLiteralSource('{ ...spread }')).toBeUndefined();
  });
});
