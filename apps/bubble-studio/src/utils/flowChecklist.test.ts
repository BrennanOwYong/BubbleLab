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
  humanizeConditionLabel,
  humanizeFunctionName,
  humanizeToolName,
  parseConversationMessages,
  toPlainLanguage,
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

  it('falls back to the flow description (sentence-cased)', () => {
    expect(deriveFlowSummary([], 'stored description')).toBe(
      'Stored description'
    );
  });
});

describe('humanizers', () => {
  it('gives tool chips user-recognizable names', () => {
    expect(humanizeToolName('ai-agent')).toBe('AI');
    expect(humanizeToolName('http')).toBe('Web');
    expect(humanizeToolName('google-sheets')).toBe('Google Sheets');
    expect(humanizeToolName('telegram')).toBe('Telegram');
  });

  it('turns function names into everyday phrases', () => {
    expect(humanizeFunctionName('queryRecentDeals')).toBe(
      'Looks up recent deals'
    );
    expect(humanizeFunctionName('buildTelegramDigestMessages')).toBe(
      'Creates telegram digest messages'
    );
    expect(humanizeFunctionName('transformSheetRange')).toBe(
      'Prepares sheet range'
    );
  });
});

describe('toPlainLanguage', () => {
  it('replaces technical terms with everyday ones', () => {
    expect(
      toPlainLanguage(
        'Reads the client table from Google Sheets as a 2D array including the header row.'
      )
    ).toBe(
      'Reads the client table from Google Sheets as a table including the header row.'
    );
    expect(
      toPlainLanguage(
        'Uses an AI agent in JSON mode to parse RSS items and filter to the last 7 days.'
      )
    ).toBe('Uses AI to read news items and filter to the last 7 days.');
    expect(
      toPlainLanguage(
        'Sends the final digest text as a single Telegram message to the configured chat_id.'
      )
    ).toBe(
      'Sends the final digest text as a single Telegram message to the chosen chat id.'
    );
  });

  it('spells out camelCase identifiers leaked into descriptions', () => {
    expect(toPlainLanguage('Calls sendReminderEmail for each row.')).toBe(
      'Calls send reminder email for each row.'
    );
  });

  it('keeps noun uses of "query" grammatical and parse modes factual', () => {
    expect(
      toPlainLanguage('Builds a Gmail search query that targets unread mail.')
    ).toBe('Builds a Gmail search that targets unread mail.');
    expect(toPlainLanguage('Sends the digest using HTML parse mode.')).toBe(
      'Sends the digest using formatted text.'
    );
  });

  it('drops bracketed asides and duplicated words from identifier spacing', () => {
    expect(
      toPlainLanguage('Computes the [since, until] window for recent deals.')
    ).toBe('Computes the window for recent deals.');
    expect(toPlainLanguage('Deals edited since sinceIso are kept.')).toBe(
      'Deals edited since iso are kept.'
    );
  });
});

describe('humanizeConditionLabel', () => {
  it('turns branch labels into plain phrases', () => {
    expect(humanizeConditionLabel('else')).toBe('otherwise');
    expect(humanizeConditionLabel('if aiResult.isMatch === true')).toBe(
      'if match'
    );
    expect(humanizeConditionLabel('if deals.length > 0')).toBe(
      'if deals count more than 0'
    );
    expect(humanizeConditionLabel('else if retryCount >= maxRetries')).toBe(
      'or if retry count at least max retries'
    );
    expect(humanizeConditionLabel('if !existing')).toBe('if not existing');
  });

  it('truncates very long conditions', () => {
    const long = `if ${'x'.repeat(80)}`;
    expect(humanizeConditionLabel(long).length).toBeLessThanOrEqual(50);
    expect(humanizeConditionLabel(long)).toContain('…');
  });
});
