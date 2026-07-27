/**
 * Checklist + conversation derivation against REAL saved flow data.
 * Fixture: live flow 21 ("Notion Pipeline Digest") captured from
 * GET /bubble-flow/21 — workflow step graph + metadata.conversationMessages.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedWorkflow } from '@bubblelab/shared-schemas';
import {
  deriveChecklistItems,
  deriveFlowSummary,
  findPlanMessage,
  humanizeFunctionName,
  humanizeToolName,
  parseConversationMessages,
} from './flowChecklist';
import flow21 from './__fixtures__/flow21.json';

const workflow = flow21.workflow as unknown as ParsedWorkflow;
const metadata = flow21.metadata as Record<string, unknown>;

describe('parseConversationMessages', () => {
  it('parses the persisted thread of flow 21', () => {
    const messages = parseConversationMessages(metadata);
    expect(messages.map((m) => m.type)).toEqual([
      'user',
      'clarification_request',
      'clarification_response',
      'user',
      'plan',
      'plan_approval',
    ]);
  });

  it('returns [] for missing or malformed metadata', () => {
    expect(parseConversationMessages(undefined)).toEqual([]);
    expect(parseConversationMessages({})).toEqual([]);
    expect(parseConversationMessages({ conversationMessages: 'nope' })).toEqual(
      []
    );
    expect(
      parseConversationMessages({ conversationMessages: [{ type: 'bogus' }] })
    ).toEqual([]);
  });
});

describe('deriveChecklistItems', () => {
  it('derives plain-language items from flow 21 workflow steps', () => {
    const messages = parseConversationMessages(metadata);
    const items = deriveChecklistItems(workflow, messages);

    expect(items.length).toBeGreaterThanOrEqual(4);
    // Every item reads as a sentence, never a bare camelCase identifier
    for (const item of items) {
      expect(item.text).not.toMatch(/^[a-z]+[A-Z]/);
      expect(item.text.length).toBeGreaterThan(10);
    }
    // The Notion query step carries its generation-time description
    const notionStep = items.find((i) => i.text.includes('Notion'));
    expect(notionStep).toBeDefined();
    expect(notionStep!.tools).toContain('Notion');
  });

  it('falls back to the approved plan when workflow is absent', () => {
    const messages = parseConversationMessages(metadata);
    const items = deriveChecklistItems(undefined, messages);
    const plan = findPlanMessage(messages)!;

    expect(items.length).toBe(plan.plan.steps.length);
    expect(items[0].text.length).toBeGreaterThan(0);
  });

  it('returns [] with neither workflow nor plan', () => {
    expect(deriveChecklistItems(undefined, [])).toEqual([]);
  });
});

describe('deriveFlowSummary', () => {
  it('prefers the approved plan summary', () => {
    const messages = parseConversationMessages(metadata);
    const summary = deriveFlowSummary(messages, 'stored description');
    expect(summary).toContain('Notion');
  });

  it('falls back to the flow description', () => {
    expect(deriveFlowSummary([], 'stored description')).toBe(
      'stored description'
    );
  });
});

describe('humanizers', () => {
  it('humanizes bubble names', () => {
    expect(humanizeToolName('ai-agent')).toBe('AI Agent');
    expect(humanizeToolName('google-sheets')).toBe('Google Sheets');
    expect(humanizeToolName('telegram')).toBe('Telegram');
  });

  it('humanizes function names', () => {
    expect(humanizeFunctionName('queryRecentDeals')).toBe('Query recent deals');
    expect(humanizeFunctionName('buildTelegramDigestMessages')).toBe(
      'Build telegram digest messages'
    );
  });
});
