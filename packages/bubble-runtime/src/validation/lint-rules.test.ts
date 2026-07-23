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
