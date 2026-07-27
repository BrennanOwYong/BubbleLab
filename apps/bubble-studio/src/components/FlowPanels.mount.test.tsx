/**
 * @vitest-environment jsdom
 *
 * Mount tests: FlowConversationPanel and FlowChecklistPanel render REAL flow
 * data end to end through the same path the app uses — the react-query cache
 * key ['bubbleFlow', id] that useBubbleFlow reads. The fixture is live flow
 * 21 captured from GET /bubble-flow/21.
 */
import { describe, expect, it } from 'vitest';
import { act } from 'react';

// React requires this flag before it honors act() outside a test renderer
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BubbleFlowDetailsResponse } from '@bubblelab/shared-schemas';
import { FlowConversationPanel } from './FlowConversationPanel';
import { FlowChecklistPanel } from './FlowChecklistPanel';
import flow21 from '../utils/__fixtures__/flow21.json';

const FLOW_ID = 21;

function flowData(): BubbleFlowDetailsResponse {
  return {
    id: FLOW_ID,
    name: 'Gi Hoon: Notion Pipeline Digest',
    workflow: flow21.workflow,
    metadata: flow21.metadata,
  } as unknown as BubbleFlowDetailsResponse;
}

async function renderWithFlow(
  element: React.ReactElement,
  data: BubbleFlowDetailsResponse | undefined
): Promise<HTMLElement> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (data) {
    // Same cache key useBubbleFlow reads; staleTime keeps it fresh so no
    // network fetch fires during the test.
    queryClient.setQueryData(['bubbleFlow', FLOW_ID], data);
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    );
  });
  return container;
}

describe('FlowConversationPanel', () => {
  it('renders flow 21 saved conversation from metadata.conversationMessages', async () => {
    const container = await renderWithFlow(
      <FlowConversationPanel flowId={FLOW_ID} />,
      flowData()
    );
    const text = container.textContent ?? '';

    expect(text).toContain('How this flow was built');
    // The user's original prompt
    expect(text).toContain('Every Friday');
    // The approved plan's summary and the approval marker
    expect(text).toContain('pull deals from your Notion database');
    expect(text).toContain('You approved the plan');
    // Clarification Q&A round survived
    expect(text).toContain('Assistant asked');
    expect(text).toContain('You answered');
  });

  it('renders workflow-status messages and the inline needs-info form', async () => {
    const data = flowData();
    data.metadata = {
      conversationMessages: [
        ...(flow21.metadata.conversationMessages as unknown[]),
        {
          role: 'system',
          kind: 'workflow-done',
          timestampMs: 1753600000000,
          text: 'Workflow done! Check it out now',
        },
        {
          role: 'system',
          kind: 'workflow-done-needs-info',
          timestampMs: 1753600001000,
          text: 'Workflow done, but I still need some information',
          fields: [
            {
              key: 'notionDatabaseId',
              header: 'Notion database ID',
              hint: 'The long ID from your Notion database link',
              value: '1234567890abcdef1234567890abcdef',
            },
            {
              key: 'telegramChatId',
              header: 'Telegram chat ID',
              hint: 'Where the digest should be delivered',
            },
          ],
        },
      ],
    };
    const container = await renderWithFlow(
      <FlowConversationPanel flowId={FLOW_ID} />,
      data
    );
    const text = container.textContent ?? '';

    expect(text).toContain('Workflow done! Check it out now');
    expect(text).toContain('Workflow done, but I still need some information');
    expect(text).toContain('Notion database ID');
    expect(text).toContain('Telegram chat ID');

    // C1: the known value renders as REAL input text, not placeholder
    const notionInput = container.querySelector<HTMLInputElement>(
      '#needs-info-notionDatabaseId'
    );
    expect(notionInput?.value).toBe('1234567890abcdef1234567890abcdef');
    // No known value -> empty value, hint as placeholder
    const telegramInput = container.querySelector<HTMLInputElement>(
      '#needs-info-telegramChatId'
    );
    expect(telegramInput?.value).toBe('');
    expect(telegramInput?.placeholder).toBe(
      'Where the digest should be delivered'
    );
  });

  it('shows the empty state when no conversation is saved', async () => {
    const data = flowData();
    data.metadata = {};
    const container = await renderWithFlow(
      <FlowConversationPanel flowId={FLOW_ID} />,
      data
    );
    expect(container.textContent).toContain(
      'No conversation saved for this flow'
    );
  });
});

describe('FlowChecklistPanel', () => {
  it('renders flow 21 workflow steps as a plain-language checklist', async () => {
    const container = await renderWithFlow(
      <FlowChecklistPanel flowId={FLOW_ID} />,
      flowData()
    );
    const text = container.textContent ?? '';

    expect(text).toContain('What this flow does');
    // Step lines derived from the parsed workflow's descriptions,
    // plain-language ('Queries' -> 'Looks up')
    expect(text).toContain('Looks up your Notion deals database');
    expect(text).toContain(
      'classify whether a deal looks stalled and propose actionable next steps'
    );
    expect(text).toContain('Sends one Telegram message');
    // Tool chips resolved from the workflow bubbles map ('ai-agent' -> 'AI')
    expect(text).toContain('Notion');
    expect(text).toContain('Telegram');
    // B3 sections: outcomes and error responses render; no technical tokens
    expect(text).toContain('If something goes wrong');
    expect(text).not.toMatch(/ISO-8601|JSON\b|\b2D array\b/);
    // Raw code demoted to a link, still reachable
    expect(text).toContain('View code');
  });

  it('shows the empty state for a flow with no steps and no plan', async () => {
    const data = flowData();
    data.workflow = undefined;
    data.metadata = {};
    const container = await renderWithFlow(
      <FlowChecklistPanel flowId={FLOW_ID} />,
      data
    );
    expect(container.textContent).toContain('No steps to describe yet');
  });
});
