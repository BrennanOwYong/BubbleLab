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
    // Step lines derived from the parsed workflow's descriptions
    expect(text).toContain('Queries your Notion deals database');
    expect(text).toContain(
      'classify whether a deal looks stalled and propose actionable next steps'
    );
    expect(text).toContain('Sends one Telegram message');
    // Tool chips resolved from the workflow bubbles map
    expect(text).toContain('AI Agent');
    expect(text).toContain('Telegram');
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
