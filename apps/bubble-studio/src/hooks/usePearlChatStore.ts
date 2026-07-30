/**
 * usePearlChatStore - Combines the flow-page chat state with the Claude
 * harness transport.
 *
 * Messages are the source of truth. Special message types
 * (clarification_request, context_request, plan) are stored as messages in
 * history and rendered as widgets when pending. All agent turns run on the
 * builder-harness session for this flow (see usePearlStream.sendBuildMessage);
 * the old Pearl/Coffee endpoints are gone.
 */

import { useCallback } from 'react';
import type { CredentialType } from '@bubblelab/shared-schemas';
import { sendBuildMessage } from './usePearlStream';
import { getPearlChatStore } from '../stores/pearlChatStore';
import type {
  ClarificationResponseMessage,
  ContextResponseMessage,
  PlanApprovalMessage,
  SystemChatMessage,
  UserChatMessage,
} from '../components/ai/type';
import {
  getPendingClarificationRequest,
  getPendingContextRequest,
  getPendingPlan,
} from '../components/ai/type';
import { useBubbleDetail } from './useBubbleDetail';
import { trackAIAssistant } from '../services/analytics';
import { api } from '../lib/api';

/**
 * Main hook - combines store state with the harness transport and provides
 * the same API surface the pre-effba78 panel consumed.
 */
export function usePearlChatStore(flowId: number | null) {
  const bubbleDetail = useBubbleDetail(flowId);
  const store = getPearlChatStore(flowId ?? -1);

  // Subscribe to state
  const timeline = store((s) => s.timeline);
  const messages = store((s) => s.messages);
  const activeToolCallIds = store((s) => s.activeToolCallIds);
  const prompt = store((s) => s.prompt);
  const selectedBubbleContext = store((s) => s.selectedBubbleContext);
  const selectedTransformationContext = store(
    (s) => s.selectedTransformationContext
  );
  const selectedStepContext = store((s) => s.selectedStepContext);
  const coffeeOriginalPrompt = store((s) => s.coffeeOriginalPrompt);
  const coffeeContextCredentials = store((s) => s.coffeeContextCredentials);
  const isCoffeeLoading = store((s) => s.isCoffeeLoading);

  // Generation state
  const isGenerating = store((s) => s.isGenerating);
  const generationCompleted = store((s) => s.generationCompleted);

  // Derive pending state from messages
  const pendingClarification = getPendingClarificationRequest(messages);
  const pendingContextRequest = getPendingContextRequest(messages);
  const pendingPlan = getPendingPlan(messages);

  // ===== Main send function (chat + explain-with-Gluu triggers) =====
  const startGeneration = (promptText: string) => {
    if (!store || !flowId) return;

    const storeState = store.getState();
    if (storeState.hasActiveGenerationStream()) return;
    let userContent = promptText.trim();

    if (storeState.selectedBubbleContext.length > 0) {
      const bubbleContextText = storeState.selectedBubbleContext
        .map((variableId) => {
          const bubbleInfo = bubbleDetail.getBubbleInfo(variableId);
          const variableName =
            bubbleInfo?.variableName || `Bubble ${variableId}`;
          return `For the selected bubble: ${variableName}, please do the following: \n `;
        })
        .join(', ');

      userContent = `${bubbleContextText}${userContent ? '\n\n' + userContent : ''}`;
    } else if (storeState.selectedStepContext) {
      const stepContextText = `For the selected step: ${storeState.selectedStepContext}, please do the following: \n `;
      userContent = `${stepContextText}${userContent ? '\n\n' + userContent : ''}`;
    } else if (storeState.selectedTransformationContext) {
      const transformationContextText = `For the selected transformation function: ${storeState.selectedTransformationContext}, please do the following: \n `;
      userContent = `${transformationContextText}${userContent ? '\n\n' + userContent : ''}`;
    }

    const userMessage: UserChatMessage = {
      id: Date.now().toString(),
      type: 'user',
      content: userContent,
      timestamp: new Date(),
    };

    storeState.addMessage(userMessage);
    storeState.clearToolCalls();
    storeState.clearPrompt();

    trackAIAssistant({
      action: 'send_message',
      message: userMessage.content,
    });

    sendBuildMessage(flowId, userMessage.content).catch((err) => {
      console.error('[usePearlChatStore] send error:', err);
    });
  };

  // ===== Start a fresh build conversation (kept name from the Coffee era) =====
  const startCoffeePlanning = useCallback(
    async (promptText: string) => {
      if (!store || !flowId) return;

      const storeState = store.getState();
      storeState.setCoffeeOriginalPrompt(promptText);

      const userMessage: UserChatMessage = {
        id: Date.now().toString(),
        type: 'user',
        content: promptText,
        timestamp: new Date(),
      };
      storeState.addMessage(userMessage);

      await sendBuildMessage(flowId, promptText);
    },
    [store, flowId]
  );

  // ===== Submit Clarification Answers =====
  const submitClarificationAnswers = useCallback(
    async (answers: Record<string, string[]>) => {
      if (!store || !flowId) return;

      const storeState = store.getState();
      const pending = getPendingClarificationRequest(storeState.messages);

      const responseMsg: ClarificationResponseMessage = {
        id: `clarification-response-${Date.now()}`,
        type: 'clarification_response',
        answers,
        originalQuestions: pending?.questions,
        timestamp: new Date(),
      };
      storeState.addMessage(responseMsg);

      const lines: string[] = ['Answers to your questions:'];
      for (const [questionId, choiceIds] of Object.entries(answers)) {
        const question = pending?.questions.find((q) => q.id === questionId);
        const labels = choiceIds.map(
          (choiceId) =>
            question?.choices.find((c) => c.id === choiceId)?.label ?? choiceId
        );
        lines.push(
          `- ${question?.question ?? questionId}: ${labels.join(', ')}`
        );
      }
      await sendBuildMessage(flowId, lines.join('\n'));
    },
    [store, flowId]
  );

  // ===== Submit Context =====
  const submitContext = useCallback(async () => {
    if (!store || !flowId) return;

    const storeState = store.getState();
    const pending = getPendingContextRequest(storeState.messages);
    const credentials = storeState.coffeeContextCredentials;

    if (!pending) return;

    storeState.setIsCoffeeLoading(true);

    try {
      // Execute the context-gathering flow, then hand the result to the agent
      const result = (await api.post('/bubble-flow/generate/run-context-flow', {
        flowCode: pending.request.flowCode,
        credentials,
      })) as { success: boolean; result?: unknown; error?: string };

      const responseMsg: ContextResponseMessage = {
        id: `context-response-${Date.now()}`,
        type: 'context_response',
        answer: {
          flowId: pending.request.flowId,
          status: result.success ? 'success' : 'error',
          result: result.result,
          error: result.error,
          originalRequest: pending.request,
        },
        credentialTypes: Object.keys(credentials),
        timestamp: new Date(),
      };
      storeState.addMessage(responseMsg);
      storeState.clearCoffeeContextCredentials();

      const summary = result.success
        ? `Context request result:\n${JSON.stringify(result.result ?? null).slice(0, 4000)}`
        : `Context request failed: ${result.error ?? 'unknown error'}`;
      await sendBuildMessage(flowId, summary);
    } catch (error) {
      console.error('[Context] submission error:', error);
    } finally {
      storeState.setIsCoffeeLoading(false);
    }
  }, [store, flowId]);

  // ===== Reject Context =====
  const rejectContext = useCallback(async () => {
    if (!store || !flowId) return;

    const storeState = store.getState();
    const pending = getPendingContextRequest(storeState.messages);

    if (!pending) return;

    const responseMsg: ContextResponseMessage = {
      id: `context-response-${Date.now()}`,
      type: 'context_response',
      answer: {
        flowId: pending.request.flowId,
        status: 'rejected',
        originalRequest: pending.request,
      },
      timestamp: new Date(),
    };
    storeState.addMessage(responseMsg);

    await sendBuildMessage(
      flowId,
      'I rejected the request to access my data. Continue without it.'
    );
  }, [store, flowId]);

  // ===== Approve Plan =====
  const approvePlanAndBuild = useCallback(
    async (comment?: string) => {
      if (!store || !flowId) return;

      const storeState = store.getState();
      const pending = getPendingPlan(storeState.messages);

      if (!pending) return;

      const approvalMsg: PlanApprovalMessage = {
        id: `plan-approval-${Date.now()}`,
        type: 'plan_approval',
        approved: true,
        comment,
        timestamp: new Date(),
      };
      storeState.addMessage(approvalMsg);

      const message = comment
        ? `The plan is approved. Proceed with the build.\n\nAdditional comments: ${comment}`
        : 'The plan is approved. Proceed with the build.';
      await sendBuildMessage(flowId, message);
    },
    [store, flowId]
  );

  // ===== Skip planning and build directly =====
  const skipCoffeeAndBuild = useCallback(async () => {
    if (!store || !flowId) return;

    const storeState = store.getState();
    const originalPrompt = storeState.coffeeOriginalPrompt;

    if (!originalPrompt) return;

    await sendBuildMessage(
      flowId,
      'Skip further planning and build the flow now.'
    );
  }, [store, flowId]);

  // ===== Retry After Error =====
  const retryAfterError = useCallback(async () => {
    if (!store || !flowId) return;

    const storeState = store.getState();

    const retryMessage: SystemChatMessage = {
      id: `retry-${Date.now()}`,
      type: 'system',
      content: 'Retrying after the previous attempt failed...',
      timestamp: new Date(),
    };
    storeState.addMessage(retryMessage);
    storeState.setGenerationCompleted(false);

    await sendBuildMessage(
      flowId,
      'The previous attempt failed. Please pick up where you left off and finish the build.'
    );
  }, [store, flowId]);

  // ===== Other Actions =====
  const clearMessages = useCallback(() => {
    store?.getState().clearMessages();
  }, [store]);

  const reset = useCallback(() => {
    store?.getState().reset();
  }, [store]);

  // An in-flight harness turn is the pending state (the old Pearl mutation
  // and the generation stream are the same thing now).
  const isPending = isGenerating;

  const setPrompt = useCallback(
    (newPrompt: string) => {
      store?.getState().setPrompt(newPrompt);
    },
    [store]
  );

  const clearPrompt = useCallback(() => {
    store?.getState().clearPrompt();
  }, [store]);

  const addBubbleToContext = useCallback(
    (variableId: number) => {
      store?.getState().addBubbleToContext(variableId);
    },
    [store]
  );

  const removeBubbleFromContext = useCallback(
    (variableId: number) => {
      store?.getState().removeBubbleFromContext(variableId);
    },
    [store]
  );

  const toggleBubbleInContext = useCallback(
    (variableId: number) => {
      store?.getState().toggleBubbleInContext(variableId);
    },
    [store]
  );

  const clearBubbleContext = useCallback(() => {
    store?.getState().clearBubbleContext();
  }, [store]);

  const addTransformationToContext = useCallback(
    (functionName: string) => {
      store?.getState().addTransformationToContext(functionName);
    },
    [store]
  );

  const clearTransformationContext = useCallback(() => {
    store?.getState().clearTransformationContext();
  }, [store]);

  const addStepToContext = useCallback(
    (functionName: string) => {
      store?.getState().addStepToContext(functionName);
    },
    [store]
  );

  const clearStepContext = useCallback(() => {
    store?.getState().clearStepContext();
  }, [store]);

  const setCoffeeContextCredential = useCallback(
    (credType: CredentialType, credId: number | null) => {
      store?.getState().setCoffeeContextCredential(credType, credId);
    },
    [store]
  );

  return {
    // State
    timeline,
    messages,
    activeToolCallIds,
    prompt,
    selectedBubbleContext,
    selectedTransformationContext,
    selectedStepContext,

    // Derived pending state (from messages)
    pendingClarification,
    pendingContextRequest,
    pendingPlan,

    // Transient planning state
    coffeeOriginalPrompt,
    coffeeContextCredentials,
    isCoffeeLoading,

    // Actions
    startGeneration,
    clearMessages,
    reset,
    setPrompt,
    clearPrompt,
    addBubbleToContext,
    removeBubbleFromContext,
    toggleBubbleInContext,
    clearBubbleContext,
    addTransformationToContext,
    clearTransformationContext,
    addStepToContext,
    clearStepContext,

    // Planning actions
    startCoffeePlanning,
    submitClarificationAnswers,
    approvePlanAndBuild,
    skipCoffeeAndBuild,
    setCoffeeContextCredential,
    submitContext,
    rejectContext,
    retryAfterError,

    // Turn state
    isPending,
    isError: false,
    error: null as Error | null,

    // Generation state
    isGenerating,
    generationCompleted,
    hasActiveGenerationStream: () =>
      store.getState().hasActiveGenerationStream(),
    cancelGenerationStream: () => store.getState().cancelGenerationStream(),

    // Unified loading state - true when any agent turn is in progress
    isLoading: isPending || isGenerating || isCoffeeLoading,
  };
}
