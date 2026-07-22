/**
 * Conversation-thread persistence for BubbleFlow generation.
 *
 * The codegen conversation (CoffeeMessage[]) lives in bubble_flows.metadata
 * under `conversationMessages`, with a `lastUpdatedPhase` marker
 * ('planning' | 'building') the studio uses to resume. Historically the
 * thread was written only after a round finished (planning) or after a
 * successful build, so an errored or abandoned generation dropped it.
 *
 * This module writes the thread incrementally: callers persist BEFORE the
 * agent runs (the user's side of the round survives any crash) and again in
 * a finally block with the round's outcome appended. Writes never throw —
 * a persistence failure must not break the generation stream.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bubbleFlows } from '../db/schema.js';
import type { CoffeeMessage, CoffeeResponse } from '@bubblelab/shared-schemas';

export type GenerationPhase = 'planning' | 'building';

/**
 * Persist the conversation thread onto the flow's metadata JSON, merging with
 * whatever metadata already exists. Returns true when a write was attempted
 * and succeeded, false when skipped (empty thread) or failed (logged).
 */
export async function persistConversationThread(
  userId: string,
  flowId: number,
  messages: CoffeeMessage[],
  phase: GenerationPhase
): Promise<boolean> {
  if (messages.length === 0) {
    return false;
  }

  try {
    // Fetch current metadata to merge with existing data
    const currentFlow = await db.query.bubbleFlows.findFirst({
      where: and(eq(bubbleFlows.id, flowId), eq(bubbleFlows.userId, userId)),
      columns: { metadata: true },
    });

    const existingMetadata =
      (currentFlow?.metadata as Record<string, unknown>) || {};

    await db
      .update(bubbleFlows)
      .set({
        metadata: {
          ...existingMetadata,
          conversationMessages: messages,
          lastUpdatedPhase: phase,
        },
        updatedAt: new Date(),
      })
      .where(and(eq(bubbleFlows.id, flowId), eq(bubbleFlows.userId, userId)));

    return true;
  } catch (saveError) {
    console.error(
      `[API] Error saving conversation messages to flow ${flowId}:`,
      saveError
    );
    // Non-blocking: generation continues even if the save fails
    return false;
  }
}

/**
 * Build the thread to persist from a generate request. The studio sends its
 * full message list (already containing the user's messages); external
 * callers may send only a prompt — synthesize a user message for it so the
 * very first round leaves a visible thread.
 */
export function buildThreadFromRequest(
  prompt: string,
  messages: CoffeeMessage[] | undefined
): CoffeeMessage[] {
  const thread: CoffeeMessage[] = [...(messages ?? [])];

  const hasUserMessage = thread.some((m) => m.type === 'user');
  if (!hasUserMessage && prompt) {
    thread.push({
      id: `user-${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: 'user',
      content: prompt,
    });
  }

  return thread;
}

/**
 * Map a Coffee round's outcome to a persistable message so the thread carries
 * the assistant's side (clarification questions / plan / context request)
 * even when the client never comes back to re-send it. Error outcomes become
 * a system message the studio can surface on resume.
 */
export function coffeeResponseToMessage(
  result: CoffeeResponse
): CoffeeMessage | null {
  const base = {
    id: `coffee-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    timestamp: new Date().toISOString(),
  };

  switch (result.type) {
    case 'clarification':
      return result.clarification
        ? {
            ...base,
            type: 'clarification_request',
            questions: result.clarification.questions,
          }
        : null;
    case 'plan':
      return result.plan ? { ...base, type: 'plan', plan: result.plan } : null;
    case 'context_request':
      return result.contextRequest
        ? { ...base, type: 'context_request', request: result.contextRequest }
        : null;
    case 'error':
      return {
        ...base,
        type: 'system',
        content: `Planning failed: ${result.error || 'Unknown error'}`,
      };
    default:
      return null;
  }
}

/**
 * Marker message for a round that died before producing any outcome
 * (stream drop, crash, abandoned tab).
 */
export function interruptedGenerationMessage(
  phase: GenerationPhase
): CoffeeMessage {
  return {
    id: `interrupted-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: 'system',
    content: `Generation was interrupted during the ${phase} phase before completing.`,
  };
}
