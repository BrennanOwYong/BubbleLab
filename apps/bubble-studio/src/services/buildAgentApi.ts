/**
 * Client for the /build API (Phase-4 builder agent). The API proxies these
 * routes to the builder-agent sidecar; the studio never talks to the sidecar
 * directly.
 */
import { api } from '../lib/api';

export interface BuildStreamFrame {
  event: string;
  data: unknown;
}

export interface BuildTranscriptItem {
  role: 'user' | 'assistant';
  blocks: Array<{
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
    is_error?: boolean;
  }>;
}

export interface BuildThreadResponse {
  flowId: number;
  sessionId: string | null;
  status: string;
  agentKind: string | null;
  deferredSetup: {
    credentialType: string;
    deferredSetupScript: unknown[];
    reportedAt: string;
  } | null;
  transcript: BuildTranscriptItem[];
}

export function fetchBuildThread(flowId: number): Promise<BuildThreadResponse> {
  return api.get<BuildThreadResponse>(`/build/${flowId}/thread`);
}

/**
 * POST /build/:flowId/message and invoke `onFrame` for every SSE frame.
 * Resolves when the stream ends.
 */
export async function streamBuildMessage(
  flowId: number,
  message: string,
  onFrame: (frame: BuildStreamFrame) => void,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const response = await api.postStream(
    `/build/${flowId}/message`,
    { message },
    options
  );
  if (!response.body) throw new Error('Build stream has no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const raw of frames) {
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data === '') continue;
        try {
          onFrame({ event, data: JSON.parse(data) });
        } catch {
          // Malformed frame (heartbeat/comment): skip.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
