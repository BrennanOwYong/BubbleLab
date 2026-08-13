import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import {
  enforcePayloadTypeRule,
  noCastPayloadInHandleRule,
  noToStringOnExpectedOutputSchemaRule,
  noJsonStringifyOnExpectedOutputSchemaRule,
  noCapabilityInputsRule,
  requireCronScheduleRule,
  payloadMustExtendTriggerEventRule,
  noNestedThrowInHandleRule,
  noThrowInHandleRule,
  noWideningCastRule,
  noPlaceholderValuesRule,
  noMethodCallingMethodRule,
  noMethodInvocationInComplexExpressionRule,
  noCreateIfMissingRule,
  noBubbleInTernaryOrShortCircuitRule,
  LintRuleRegistry,
} from './lint-rules.js';

function lint(
  code: string,
  ...rules: Parameters<LintRuleRegistry['register']>[0][]
) {
  const sourceFile = ts.createSourceFile(
    'test.ts',
    code,
    ts.ScriptTarget.Latest,
    true
  );
  const registry = new LintRuleRegistry();
  for (const rule of rules) {
    registry.register(rule);
  }
  return registry.validateAll(sourceFile);
}

describe('enforce-payload-type lint rule', () => {
  it('should error when handle payload uses wrong type for slack/bot_mentioned trigger', () => {
    const code = `
import { BubbleFlow } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'slack/bot_mentioned'> {
  constructor() {
    super('my-flow', 'A test flow');
  }

  async handle(payload: WebhookEvent): Promise<{ message: string }> {
    return { message: payload.text };
  }
}
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(enforcePayloadTypeRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('SlackMentionEvent');
    expect(errors[0].message).toContain('slack/bot_mentioned');
  });
});

describe('no-tostring-on-expected-output-schema lint rule', () => {
  it('should error when .toString() is called on expectedOutputSchema', () => {
    const code = `
import { z } from 'zod';
import { AIAgentBubble } from '@bubblelab/bubble-core';

const parser = new AIAgentBubble({
  message: 'Extract companies',
  model: { model: 'google/gemini-2.5-flash' },
  expectedOutputSchema: z.object({
    companies: z.array(z.object({ name: z.string() })),
  }).toString(),
});
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noToStringOnExpectedOutputSchemaRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('Do not call .toString()');
    expect(errors[0].message).toContain('expectedOutputSchema');
  });

  it('should not error when Zod schema is passed directly without .toString()', () => {
    const code = `
import { z } from 'zod';
import { AIAgentBubble } from '@bubblelab/bubble-core';

const parser = new AIAgentBubble({
  message: 'Extract companies',
  model: { model: 'google/gemini-2.5-flash' },
  expectedOutputSchema: z.object({
    companies: z.array(z.object({ name: z.string() })),
  }),
});
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noToStringOnExpectedOutputSchemaRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(0);
  });

  it('should not error when toString is called on other properties', () => {
    const code = `
import { z } from 'zod';

const obj = {
  someOtherProperty: z.object({ name: z.string() }).toString(),
};
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noToStringOnExpectedOutputSchemaRule);

    const errors = registry.validateAll(sourceFile);
    console.log(errors);

    expect(errors.length).toBe(0);
  });
});

describe('no-json-stringify-on-expected-output-schema lint rule', () => {
  it('should error when JSON.stringify() is called on expectedOutputSchema', () => {
    const code = `
import { z } from 'zod';
import { AIAgentBubble } from '@bubblelab/bubble-core';

const schema = z.object({
  companies: z.array(z.object({ name: z.string() })),
});

const parser = new AIAgentBubble({
  message: 'Extract companies',
  model: { model: 'google/gemini-2.5-flash' },
  expectedOutputSchema: JSON.stringify(schema),
});
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noJsonStringifyOnExpectedOutputSchemaRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('Do not call JSON.stringify()');
    expect(errors[0].message).toContain('expectedOutputSchema');
  });

  it('should not error when Zod schema is passed directly without JSON.stringify()', () => {
    const code = `
import { z } from 'zod';
import { AIAgentBubble } from '@bubblelab/bubble-core';

const parser = new AIAgentBubble({
  message: 'Extract companies',
  model: { model: 'google/gemini-2.5-flash' },
  expectedOutputSchema: z.object({
    companies: z.array(z.object({ name: z.string() })),
  }),
});
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noJsonStringifyOnExpectedOutputSchemaRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(0);
  });

  it('should not error when JSON.stringify is called on other properties', () => {
    const code = `
import { z } from 'zod';

const obj = {
  someOtherProperty: JSON.stringify({ name: 'test' }),
};
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noJsonStringifyOnExpectedOutputSchemaRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(0);
  });

  it('should error when JSON.stringify() is called on expectedResultSchema (ResearchAgentTool)', () => {
    const code = `
import { z } from 'zod';
import { ResearchAgentTool } from '@bubblelab/bubble-core';

const schema = z.object({
  programs: z.array(z.object({ name: z.string() })),
});

const researchTool = new ResearchAgentTool({
  task: 'Find programs',
  expectedResultSchema: JSON.stringify(schema),
  model: 'google/gemini-3-pro-preview',
});
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noJsonStringifyOnExpectedOutputSchemaRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('Do not call JSON.stringify()');
    expect(errors[0].message).toContain('expectedResultSchema');
  });
});

describe('no-capability-inputs lint rule', () => {
  it('should error when capability inputs reference variables (template expression)', () => {
    const code = `
import { AIAgentBubble } from '@bubblelab/bubble-core';

const agent = new AIAgentBubble({
  message: 'Research this topic',
  model: { model: 'google/gemini-2.5-flash' },
  capabilities: [{ id: 'knowledge-base', inputs: { sources: [\`google-doc:\${docId}:edit\`] } }],
});
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noCapabilityInputsRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('inputs');
    expect(errors[0].message).toContain('variables');
  });

  it('should error when capability inputs reference a variable directly', () => {
    const code = `
import { AIAgentBubble } from '@bubblelab/bubble-core';

const agent = new AIAgentBubble({
  message: 'Do stuff',
  capabilities: [{ id: 'knowledge-base', inputs: myInputs }],
});
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noCapabilityInputsRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('inputs');
  });

  it('should not error when capabilities only have id', () => {
    const code = `
import { AIAgentBubble } from '@bubblelab/bubble-core';

const agent = new AIAgentBubble({
  message: 'Research this topic',
  model: { model: 'google/gemini-2.5-flash' },
  capabilities: [{ id: 'knowledge-base' }],
});
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noCapabilityInputsRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(0);
  });

  it('should not error when capability inputs are all constants', () => {
    const code = `
import { AIAgentBubble } from '@bubblelab/bubble-core';

const agent = new AIAgentBubble({
  message: 'Do stuff',
  capabilities: [
    { id: 'knowledge-base', inputs: { sources: ['google-doc:1Kf-abc123:edit'] } },
    { id: 'data-analyst', inputs: { schemaContext: '' } },
    { id: 'google-calendar', inputs: { } },
  ],
});
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noCapabilityInputsRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(0);
  });

  it('should error only for capabilities with variable inputs, not constant ones', () => {
    const code = `
import { AIAgentBubble } from '@bubblelab/bubble-core';

const agent = new AIAgentBubble({
  message: 'Do stuff',
  capabilities: [
    { id: 'knowledge-base', inputs: { sources: ['doc1'] } },
    { id: 'data-analyst', inputs: { db: someVariable } },
  ],
});
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noCapabilityInputsRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(1);
  });

  it('should not flag objects without an id property', () => {
    const code = `
const config = {
  capabilities: [{ name: 'something', inputs: { foo: 'bar' } }],
};
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noCapabilityInputsRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(0);
  });
});

describe('no-cast-payload-in-handle lint rule', () => {
  it('should error when payload.body is cast via as unknown as', () => {
    const code = `
import { BubbleFlow, HttpBubble, type WebhookEvent } from '@bubblelab/bubble-core';

interface FlowInputs {
  google_doc_url: string;
  to_email: string;
}

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ success: boolean }> {
    const inputs = payload.body as unknown as FlowInputs;
    return { success: true };
  }
}
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noCastPayloadInHandleRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain(
      'Do not access payload.body and cast it'
    );
    expect(errors[0].message).toContain('extending the trigger event type');
    expect(errors[0].message).toContain('handle(payload: FlowInputs)');
  });

  it('should not error when payload interface properly extends WebhookEvent', () => {
    const code = `
import { BubbleFlow, HttpBubble, type WebhookEvent } from '@bubblelab/bubble-core';

export interface MyPayload extends WebhookEvent {
  google_doc_url: string;
  to_email: string;
}

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: MyPayload): Promise<{ success: boolean }> {
    const { google_doc_url, to_email } = payload;
    return { success: true };
  }
}
`;

    const sourceFile = ts.createSourceFile(
      'test.ts',
      code,
      ts.ScriptTarget.Latest,
      true
    );

    const registry = new LintRuleRegistry();
    registry.register(noCastPayloadInHandleRule);

    const errors = registry.validateAll(sourceFile);

    expect(errors.length).toBe(0);
  });
});

describe('require-cron-schedule lint rule', () => {
  it('should error when a schedule/cron flow has no cronSchedule property', () => {
    const errors = lint(
      `
import { BubbleFlow, type CronEvent } from '@bubblelab/bubble-core';

export class DailyFlow extends BubbleFlow<'schedule/cron'> {
  async handle(payload: CronEvent) {
    return { ok: true };
  }
}
`,
      requireCronScheduleRule
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('cronSchedule');
    expect(errors[0].message).toContain('schedule/cron');
  });

  it('should error when cronSchedule is not a plain string literal', () => {
    const errors = lint(
      `
import { BubbleFlow, type CronEvent } from '@bubblelab/bubble-core';

export class DailyFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = ['0', '0', '*', '*', '*'].join(' ');
  async handle(payload: CronEvent) {
    return { ok: true };
  }
}
`,
      requireCronScheduleRule
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('string literal');
  });

  it('should error when cronSchedule is an invalid cron expression', () => {
    const errors = lint(
      `
import { BubbleFlow, type CronEvent } from '@bubblelab/bubble-core';

export class DailyFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = 'every day at nine';
  async handle(payload: CronEvent) {
    return { ok: true };
  }
}
`,
      requireCronScheduleRule
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('Invalid cron expression');
  });

  it('should not error when a valid literal cronSchedule is declared', () => {
    const errors = lint(
      `
import { BubbleFlow, type CronEvent } from '@bubblelab/bubble-core';

export class DailyFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 9 * * *';
  async handle(payload: CronEvent) {
    return { ok: true };
  }
}
`,
      requireCronScheduleRule
    );
    expect(errors.length).toBe(0);
  });

  it('should not apply to non-cron triggers', () => {
    const errors = lint(
      `
import { BubbleFlow, type WebhookEvent } from '@bubblelab/bubble-core';

export class WebFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent) {
    return { ok: true };
  }
}
`,
      requireCronScheduleRule
    );
    expect(errors.length).toBe(0);
  });
});

describe('payload-must-extend-trigger-event lint rule', () => {
  it('should error when a custom payload interface does not extend the trigger event', () => {
    const errors = lint(
      `
import { BubbleFlow } from '@bubblelab/bubble-core';

export interface MyPayload {
  email: string;
}

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: MyPayload) {
    return { ok: true };
  }
}
`,
      payloadMustExtendTriggerEventRule
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("must extend 'WebhookEvent'");
  });

  it('should error when the payload interface extends the wrong base event', () => {
    const errors = lint(
      `
import { BubbleFlow, type CronEvent } from '@bubblelab/bubble-core';

export interface MyPayload extends CronEvent {
  email: string;
}

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: MyPayload) {
    return { ok: true };
  }
}
`,
      payloadMustExtendTriggerEventRule
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("must extend 'WebhookEvent'");
  });

  it('should not error when the payload interface extends the trigger event', () => {
    const errors = lint(
      `
import { BubbleFlow, type WebhookEvent } from '@bubblelab/bubble-core';

export interface MyPayload extends WebhookEvent {
  email: string;
}

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: MyPayload) {
    return { ok: true };
  }
}
`,
      payloadMustExtendTriggerEventRule
    );
    expect(errors.length).toBe(0);
  });

  it('should resolve a chain of interfaces to the trigger event', () => {
    const errors = lint(
      `
import { BubbleFlow, type WebhookEvent } from '@bubblelab/bubble-core';

interface BasePayload extends WebhookEvent {
  email: string;
}

export interface MyPayload extends BasePayload {
  name: string;
}

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: MyPayload) {
    return { ok: true };
  }
}
`,
      payloadMustExtendTriggerEventRule
    );
    expect(errors.length).toBe(0);
  });

  it('should not error when the base trigger event type is used directly', () => {
    const errors = lint(
      `
import { BubbleFlow, type WebhookEvent } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent) {
    return { ok: true };
  }
}
`,
      payloadMustExtendTriggerEventRule
    );
    expect(errors.length).toBe(0);
  });
});

describe('no-nested-throw-in-handle lint rule', () => {
  it('should error on a throw nested inside an if block in handle', () => {
    const errors = lint(
      `
import { BubbleFlow, type WebhookEvent } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent) {
    if (!payload.body) {
      throw new Error('missing body');
    }
    return { ok: true };
  }
}
`,
      noNestedThrowInHandleRule
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('throw statements are not allowed');
  });

  it('should error on a throw nested inside a for loop in handle', () => {
    const errors = lint(
      `
import { BubbleFlow, type WebhookEvent } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent) {
    for (const item of ['a', 'b']) {
      if (item === 'a') {
        throw new Error('bad item');
      }
    }
    return { ok: true };
  }
}
`,
      noNestedThrowInHandleRule
    );
    expect(errors.length).toBe(1);
  });

  it('should not double-report a direct throw already caught by no-throw-in-handle', () => {
    const code = `
import { BubbleFlow, type WebhookEvent } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent) {
    throw new Error('direct');
  }
}
`;
    const deepErrors = lint(code, noNestedThrowInHandleRule);
    expect(deepErrors.length).toBe(0);
    const shallowErrors = lint(code, noThrowInHandleRule);
    expect(shallowErrors.length).toBe(1);
    const combined = lint(code, noThrowInHandleRule, noNestedThrowInHandleRule);
    expect(combined.length).toBe(1);
  });

  it('should not error on throws in private methods', () => {
    const errors = lint(
      `
import { BubbleFlow, type WebhookEvent } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent) {
    const cleaned = this.cleanInput(payload.path);
    return { cleaned };
  }

  // Trims the incoming path and rejects blank values
  private cleanInput(input: string): string {
    if (!input.trim()) {
      throw new Error('blank input');
    }
    return input.trim();
  }
}
`,
      noNestedThrowInHandleRule
    );
    expect(errors.length).toBe(0);
  });
});

describe('no-widening-cast lint rule', () => {
  it('should error on a plain as-cast of JSON.parse', () => {
    const errors = lint(
      `
interface Config { retries: number }
const config = JSON.parse('{"retries":3}') as Config;
`,
      noWideningCastRule
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("'as Config'");
    expect(errors[0].message).toContain('JSON.parse');
  });

  it('should error once on an as-unknown-as chain', () => {
    const errors = lint(
      `
const value = getValue() as unknown as string;
`,
      noWideningCastRule
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('unknown/any');
  });

  it('should error on as any', () => {
    const errors = lint(
      `
const value = getValue() as any;
`,
      noWideningCastRule
    );
    expect(errors.length).toBe(1);
  });

  it('should error on angle-bracket assertions', () => {
    const errors = lint(
      `
const value = <string>getValue();
`,
      noWideningCastRule
    );
    expect(errors.length).toBe(1);
  });

  it('should allow as const assertions', () => {
    const errors = lint(
      `
const levels = ['low', 'medium', 'high'] as const;
`,
      noWideningCastRule
    );
    expect(errors.length).toBe(0);
  });

  it('should not error on cast-free code', () => {
    const errors = lint(
      `
import { BubbleFlow, GmailBubble, type WebhookEvent } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent) {
    const emails = await this.fetchEmails();
    return { emails };
  }

  // Reads the latest unread emails from the inbox
  private async fetchEmails() {
    const result = await new GmailBubble({ operation: 'read_emails', maxResults: 5 }).action();
    if (!result.success) {
      return [];
    }
    return result.data?.emails ?? [];
  }
}
`,
      noWideningCastRule
    );
    expect(errors.length).toBe(0);
  });
});

describe('no-placeholder-values lint rule', () => {
  it('should flag YOUR_* placeholder constants', () => {
    const errors = lint(
      `
const TELEGRAM_CHAT_ID = 'YOUR_TELEGRAM_CHAT_ID';
`,
      noPlaceholderValuesRule
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('YOUR_TELEGRAM_CHAT_ID');
  });

  it('should flag angle-bracket placeholder strings', () => {
    const errors = lint(
      `
const folderId = '<FOLDER_ID>';
`,
      noPlaceholderValuesRule
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('angle-bracket');
  });

  it('should flag TODO-style placeholder strings', () => {
    const errors = lint(
      `
const apiUrl = 'TODO';
const other = 'REPLACE_ME';
`,
      noPlaceholderValuesRule
    );
    expect(errors.length).toBe(2);
  });

  it('should flag placeholders inside template literal chunks', () => {
    const errors = lint(
      'const msg = `Sending to YOUR_CHANNEL_ID for ${user}`;',
      noPlaceholderValuesRule
    );
    expect(errors.length).toBe(1);
  });

  it('should not flag realistic example defaults or HTML strings', () => {
    const errors = lint(
      `
const email = 'user@example.com';
const spreadsheetId = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const channelId = 'C01234567AB';
const html = '<html><b>bold</b></html>';
const prompt = 'Summarize the TODO items found in the document';
`,
      noPlaceholderValuesRule
    );
    expect(errors.length).toBe(0);
  });
});

describe('narrowed method-call lint rules (bubble-containing chains only)', () => {
  const SEND_MESSAGE_METHOD = `
  // Sends the given text to slack
  private async sendMessage(text: string): Promise<string> {
    const result = await new SlackBubble({ operation: 'send_message', channel: '#general', text }).action();
    return result.success ? 'ok' : 'failed';
  }`;

  const PURE_HELPERS = `
  // Trims and uppercases the raw input
  private cleanInput(input: string): string {
    return this.normalize(input).toUpperCase();
  }

  // Collapses surrounding whitespace
  private normalize(input: string): string {
    return input.trim();
  }`;

  it('allows a pure transform helper to call another pure transform helper', () => {
    const code = `
import { BubbleFlow, SlackBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ message: string }> {
    const cleaned = this.cleanInput(' hi ');
    const sent = await this.sendMessage(cleaned);
    return { message: sent };
  }
${PURE_HELPERS}
${SEND_MESSAGE_METHOD}
}
`;
    const errors = lint(
      code,
      noMethodCallingMethodRule,
      noMethodInvocationInComplexExpressionRule
    );
    expect(errors).toEqual([]);
  });

  it('still errors when a bubble method is called from a non-handle method', () => {
    const code = `
import { BubbleFlow, SlackBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ message: string }> {
    const sent = await this.doWork('hi');
    return { message: sent };
  }

  // Delegates to the slack bubble method
  private async doWork(text: string): Promise<string> {
    return await this.sendMessage(text);
  }
${SEND_MESSAGE_METHOD}
}
`;
    const errors = lint(code, noMethodCallingMethodRule);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("'this.sendMessage()'");
    expect(errors[0].message).toContain('cannot be called from another method');
  });

  it('allows pure helper calls inside object literals and ternaries', () => {
    const code = `
import { BubbleFlow, SlackBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ message: string; flag: string }> {
    return {
      message: this.cleanInput(' hi '),
      flag: payload.path ? this.normalize('a') : 'b',
    };
  }
${PURE_HELPERS}
${SEND_MESSAGE_METHOD}
}
`;
    const errors = lint(
      code,
      noMethodCallingMethodRule,
      noMethodInvocationInComplexExpressionRule
    );
    expect(errors).toEqual([]);
  });

  it('still errors when a bubble method call sits inside an object literal', () => {
    const code = `
import { BubbleFlow, SlackBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ message: string }> {
    return { message: await this.sendMessage('hi') };
  }
${SEND_MESSAGE_METHOD}
}
`;
    const errors = lint(code, noMethodInvocationInComplexExpressionRule);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("'this.sendMessage()'");
    expect(errors[0].message).toContain('cannot be instrumented');
  });

  it('detects bubbles transitively through a helper chain', () => {
    const code = `
import { BubbleFlow, SlackBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ message: string }> {
    const sent = await this.chainA('hi');
    return { message: sent };
  }

  // Forwards to chainB
  private async chainA(text: string): Promise<string> {
    return await this.chainB(text);
  }

  // Forwards to the slack bubble method
  private async chainB(text: string): Promise<string> {
    return await this.sendMessage(text);
  }
${SEND_MESSAGE_METHOD}
}
`;
    const errors = lint(code, noMethodCallingMethodRule);
    // chainA -> chainB and chainB -> sendMessage both reach a bubble
    expect(errors.length).toBe(2);
    expect(errors.some((e) => e.message.includes("'this.chainB()'"))).toBe(
      true
    );
    expect(errors.some((e) => e.message.includes("'this.sendMessage()'"))).toBe(
      true
    );
  });

  it('keeps the restriction for unresolvable callees (class-property arrow)', () => {
    const code = `
import { BubbleFlow, SlackBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  private fmt = (s: string): string => s.trim();

  async handle(payload: WebhookEvent): Promise<{ message: string }> {
    const prepared = this.prepare(' hi ');
    return { message: prepared };
  }

  // Formats via the class-property arrow
  private prepare(s: string): string {
    return this.fmt(s);
  }
}
`;
    const errors = lint(code, noMethodCallingMethodRule);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("'this.fmt()'");
  });

  it('terminates and stays silent on mutually recursive pure helpers', () => {
    const code = `
import { BubbleFlow, SlackBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ value: number }> {
    const value = this.countDown(3);
    return { value };
  }

  // Counts down via countUpGuard
  private countDown(n: number): number {
    return n <= 0 ? 0 : this.countUpGuard(n - 1);
  }

  // Bounces back to countDown
  private countUpGuard(n: number): number {
    return this.countDown(n);
  }
}
`;
    const errors = lint(
      code,
      noMethodCallingMethodRule,
      noMethodInvocationInComplexExpressionRule
    );
    expect(errors).toEqual([]);
  });
});

describe('no-create-if-missing lint rule', () => {
  it('flags create_spreadsheet gated on a failed get_spreadsheet_info (then-branch negation)', () => {
    const code = `
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ id: string }> {
    const id = await this.ensurePipelineSpreadsheet('abc');
    return { id };
  }

  // Makes sure the pipeline spreadsheet exists, creating it when missing
  private async ensurePipelineSpreadsheet(spreadsheetId: string): Promise<string> {
    const info = await new GoogleSheetsBubble({
      operation: 'get_spreadsheet_info',
      spreadsheet_id: spreadsheetId,
    }).action();
    if (!info.success) {
      const created = await new GoogleSheetsBubble({
        operation: 'create_spreadsheet',
        title: 'Pipeline',
      }).action();
      return created.data?.spreadsheet_id ?? '';
    }
    return spreadsheetId;
  }
}
`;
    const errors = lint(code, noCreateIfMissingRule);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('Create-if-missing');
    expect(errors[0].message).toContain('create_spreadsheet');
    expect(errors[0].message).toContain('get_spreadsheet_info');
  });

  it('flags a create in the else branch of a positive existence check', () => {
    const code = `
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ id: string }> {
    const id = await this.resolveSheet('abc');
    return { id };
  }

  // Resolves the tracking spreadsheet, creating it when the lookup fails
  private async resolveSheet(spreadsheetId: string): Promise<string> {
    const info = await new GoogleSheetsBubble({
      operation: 'get_spreadsheet_info',
      spreadsheet_id: spreadsheetId,
    }).action();
    if (info.success) {
      return spreadsheetId;
    } else {
      const created = await new GoogleSheetsBubble({
        operation: 'create_spreadsheet',
        title: 'Tracking',
      }).action();
      return created.data?.spreadsheet_id ?? '';
    }
  }
}
`;
    const errors = lint(code, noCreateIfMissingRule);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('create_spreadsheet');
  });

  it('flags a create after a success guard-clause return', () => {
    const code = `
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ id: string }> {
    const id = await this.resolveSheet('abc');
    return { id };
  }

  // Returns the market watch spreadsheet id, creating the sheet when absent
  private async resolveSheet(spreadsheetId: string): Promise<string> {
    const info = await new GoogleSheetsBubble({
      operation: 'get_spreadsheet_info',
      spreadsheet_id: spreadsheetId,
    }).action();
    if (info.success) return spreadsheetId;
    const created = await new GoogleSheetsBubble({
      operation: 'create_spreadsheet',
      title: 'MarketWatch',
    }).action();
    return created.data?.spreadsheet_id ?? '';
  }
}
`;
    const errors = lint(code, noCreateIfMissingRule);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('create_spreadsheet');
  });

  it('does not flag an unguarded per-run create (fresh output artifact)', () => {
    const code = `
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ id: string }> {
    const id = await this.createDailyReport();
    return { id };
  }

  // Creates a fresh dated report spreadsheet on every run
  private async createDailyReport(): Promise<string> {
    const created = await new GoogleSheetsBubble({
      operation: 'create_spreadsheet',
      title: 'Daily Report',
    }).action();
    return created.data?.spreadsheet_id ?? '';
  }
}
`;
    const errors = lint(code, noCreateIfMissingRule);
    expect(errors).toEqual([]);
  });

  it('does not flag a create preceded by an existence probe without failure gating', () => {
    const code = `
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ id: string }> {
    const id = await this.copyFromTemplate('tmpl');
    return { id };
  }

  // Reads the template spreadsheet's layout and creates a fresh copy for this run
  private async copyFromTemplate(templateId: string): Promise<string> {
    const info = await new GoogleSheetsBubble({
      operation: 'get_spreadsheet_info',
      spreadsheet_id: templateId,
    }).action();
    if (!info.success) return '';
    const created = await new GoogleSheetsBubble({
      operation: 'create_spreadsheet',
      title: 'Run Copy',
    }).action();
    return created.data?.spreadsheet_id ?? '';
  }
}
`;
    const errors = lint(code, noCreateIfMissingRule);
    expect(errors).toEqual([]);
  });

  it('does not flag a create gated by a data read of the same class', () => {
    const code = `
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ id: string }> {
    const id = await this.reportOverdue('abc');
    return { id };
  }

  // Builds a fresh overdue-tasks report spreadsheet when overdue rows were read
  private async reportOverdue(spreadsheetId: string): Promise<string> {
    const rowsResult = await new GoogleSheetsBubble({
      operation: 'read_values',
      spreadsheet_id: spreadsheetId,
      range: 'Tasks!A2:C',
    }).action();
    if (!rowsResult.success) {
      const created = await new GoogleSheetsBubble({
        operation: 'create_spreadsheet',
        title: 'Overdue Report',
      }).action();
      return created.data?.spreadsheet_id ?? '';
    }
    return spreadsheetId;
  }
}
`;
    const errors = lint(code, noCreateIfMissingRule);
    expect(errors).toEqual([]);
  });

  it('does not flag a failure-gated create in a DIFFERENT bubble class', () => {
    const code = `
import { BubbleFlow, GoogleSheetsBubble, NotionBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ ok: boolean }> {
    const ok = await this.recordFailure('abc');
    return { ok };
  }

  // Writes a Notion page describing the unreachable spreadsheet
  private async recordFailure(spreadsheetId: string): Promise<boolean> {
    const info = await new GoogleSheetsBubble({
      operation: 'get_spreadsheet_info',
      spreadsheet_id: spreadsheetId,
    }).action();
    if (!info.success) {
      const page = await new NotionBubble({
        operation: 'create_page',
        title: 'Spreadsheet unreachable',
      }).action();
      return page.success;
    }
    return true;
  }
}
`;
    const errors = lint(code, noCreateIfMissingRule);
    expect(errors).toEqual([]);
  });

  it('flags the success === false comparison form', () => {
    const code = `
import { BubbleFlow, GoogleSheetsBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ id: string }> {
    const id = await this.resolveSheet('abc');
    return { id };
  }

  // Resolves the log spreadsheet, creating it when the lookup fails
  private async resolveSheet(spreadsheetId: string): Promise<string> {
    const info = await new GoogleSheetsBubble({
      operation: 'get_spreadsheet_info',
      spreadsheet_id: spreadsheetId,
    }).action();
    if (info.success === false) {
      const created = await new GoogleSheetsBubble({
        operation: 'create_spreadsheet',
        title: 'Log',
      }).action();
      return created.data?.spreadsheet_id ?? '';
    }
    return spreadsheetId;
  }
}
`;
    const errors = lint(code, noCreateIfMissingRule);
    expect(errors.length).toBe(1);
  });
});

describe('no-bubble-in-ternary-or-short-circuit lint rule', () => {
  const wrap = (stepBody: string) => `
import { BubbleFlow, GoogleDriveBubble } from '@bubblelab/bubble-core';

export class MyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ ok: boolean }> {
    const ok = await this.step(true);
    return { ok };
  }

  private async step(flag: boolean): Promise<boolean> {
    ${stepBody}
  }
}
`;

  it('rejects a bubble call in a ternary consequent as blocking', () => {
    const code = wrap(`
    const result = flag
      ? await new GoogleDriveBubble({ operation: 'list_files' }).action()
      : null;
    return result !== null;`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors.length).toBe(1);
    expect(errors[0].blocking).toBe(true);
    expect(errors[0].message).toContain('ternary operator');
    expect(errors[0].message).toContain('GoogleDriveBubble');
    expect(errors[0].message).toContain('if/else');
    expect(errors[0].message).toContain('const');
  });

  it('rejects a bubble call in a ternary alternate', () => {
    const code = wrap(`
    const result = flag
      ? null
      : await new GoogleDriveBubble({ operation: 'list_files' }).action();
    return result !== null;`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('ternary operator');
  });

  it('rejects a bubble call in a ternary test position', () => {
    const code = wrap(`
    const result = (await new GoogleDriveBubble({ operation: 'list_files' }).action())
      ? 'yes'
      : 'no';
    return result === 'yes';`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('ternary operator');
  });

  it('rejects a bubble call behind && as blocking short-circuit', () => {
    const code = wrap(`
    const result = flag && (await new GoogleDriveBubble({ operation: 'list_files' }).action());
    return Boolean(result);`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors.length).toBe(1);
    expect(errors[0].blocking).toBe(true);
    expect(errors[0].message).toContain('short-circuit expression');
  });

  it('rejects a bubble call behind ||', () => {
    const code = wrap(`
    const result = flag || (await new GoogleDriveBubble({ operation: 'list_files' }).action());
    return Boolean(result);`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('short-circuit expression');
  });

  it('rejects a bubble call behind ??', () => {
    const code = wrap(`
    const cached: string | null = null;
    const result = cached ?? (await new GoogleDriveBubble({ operation: 'list_files' }).action());
    return Boolean(result);`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('short-circuit expression');
  });

  it('allows the if/else equivalent with a const initializer per branch', () => {
    const code = wrap(`
    if (flag) {
      const result = await new GoogleDriveBubble({ operation: 'list_files' }).action();
      return result.success;
    } else {
      return false;
    }`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors).toEqual([]);
  });

  it('allows a plain const-initializer bubble call', () => {
    const code = wrap(`
    const result = await new GoogleDriveBubble({ operation: 'list_files' }).action();
    return result.success;`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors).toEqual([]);
  });

  it('allows bubble calls inside Promise.all array elements', () => {
    const code = wrap(`
    const [a, b] = await Promise.all([
      new GoogleDriveBubble({ operation: 'list_files' }).action(),
      new GoogleDriveBubble({ operation: 'list_files' }).action(),
    ]);
    return Boolean(a) && Boolean(b);`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors).toEqual([]);
  });

  it('allows an arrow concise-body bubble call even when the arrow sits in a ternary', () => {
    const code = wrap(`
    const runner = flag
      ? () => new GoogleDriveBubble({ operation: 'list_files' }).action()
      : null;
    return runner !== null;`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors).toEqual([]);
  });

  it('ignores non-bubble classes in ternaries', () => {
    const code = wrap(`
    const stamp = flag ? new Date() : null;
    return stamp !== null;`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors).toEqual([]);
  });

  it('ternary comparing a PREVIOUS bubble result is allowed', () => {
    const code = wrap(`
    const listing = await new GoogleDriveBubble({ operation: 'list_files' }).action();
    const label = listing.success ? 'found' : 'missing';
    return label === 'found';`);
    const errors = lint(code, noBubbleInTernaryOrShortCircuitRule);
    expect(errors).toEqual([]);
  });
});
