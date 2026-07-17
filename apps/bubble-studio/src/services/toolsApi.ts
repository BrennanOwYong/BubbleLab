/**
 * Client for the /tools API: streamed tool generation + registered-tools
 * registry the catalog merges in.
 */
import { API_BASE_URL } from '@/env';
import type { RegisteredTool, ToolGenEvent } from '@/types/toolGeneration';

export interface GenerateToolBody {
  specText?: string;
  specUrl?: string;
  specFileName?: string;
}

/**
 * POST /tools/generate and invoke `onEvent` for every SSE telemetry event as
 * it arrives. Resolves when the stream ends.
 */
export async function streamToolGeneration(
  body: GenerateToolBody,
  onEvent: (event: ToolGenEvent) => void
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/tools/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Generation request failed (HTTP ${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const dataLine = frame
          .split('\n')
          .find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        try {
          onEvent(JSON.parse(dataLine.slice(6)) as ToolGenEvent);
        } catch {
          // Ignore malformed frames (heartbeats, comments).
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function fetchRegisteredTools(): Promise<RegisteredTool[]> {
  const response = await fetch(`${API_BASE_URL}/tools/registered`);
  if (!response.ok) {
    throw new Error(
      `Failed to load registered tools (HTTP ${response.status})`
    );
  }
  const payload = (await response.json()) as { tools: RegisteredTool[] };
  return payload.tools;
}
