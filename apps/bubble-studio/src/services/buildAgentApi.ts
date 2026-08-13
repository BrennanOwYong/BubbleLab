/**
 * Client for the /build and /build-page APIs (Phase-4 builder agents: one
 * harness, two agent kinds). The API proxies these routes to the
 * builder-agent sidecar; the studio never talks to the sidecar directly.
 */
import { api } from '../lib/api';

export type BuilderKind = 'flow' | 'page';

const BASE_PATH: Record<BuilderKind, string> = {
  flow: '/build',
  page: '/build-page',
};

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
  subjectId: number;
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

export function fetchBuildThread(
  kind: BuilderKind,
  subjectId: number
): Promise<BuildThreadResponse> {
  return api.get<BuildThreadResponse>(`${BASE_PATH[kind]}/${subjectId}/thread`);
}

/** Shared SSE-frame parser for both the POST /message and GET /subscribe
 * streams, so the two never drift on how a frame is split/decoded. */
async function pumpSseResponse(
  response: Response,
  onFrame: (frame: BuildStreamFrame) => void
): Promise<void> {
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

/**
 * POST /build[-page]/:id/message and invoke `onFrame` for every SSE frame.
 * Resolves when the stream ends.
 */
export async function streamBuildMessage(
  kind: BuilderKind,
  subjectId: number,
  message: string,
  onFrame: (frame: BuildStreamFrame) => void,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const response = await api.postStream(
    `${BASE_PATH[kind]}/${subjectId}/message`,
    { message },
    options
  );
  await pumpSseResponse(response, onFrame);
}

/**
 * GET /build[-page]/:id/subscribe — rejoin a thread regardless of whether
 * it's mid-turn. First frame is always `history` (the current snapshot);
 * if the thread is still building, live frames follow in the exact same
 * shape streamBuildMessage's frames use, until the turn ends. If it isn't
 * building, the stream closes right after `history` — indistinguishable
 * from a plain one-shot fetch from the caller's side.
 */
export async function streamBuildSubscribe(
  kind: BuilderKind,
  subjectId: number,
  onFrame: (frame: BuildStreamFrame) => void,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const response = await api.getStream(
    `${BASE_PATH[kind]}/${subjectId}/subscribe`,
    options
  );
  await pumpSseResponse(response, onFrame);
}
