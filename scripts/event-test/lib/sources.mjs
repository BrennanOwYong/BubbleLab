/**
 * Collectors — one per row of the DISPATCH-CONTRACT Pillar 2 event-source
 * table. Each takes the resolved stack ({ api, sidecar }) plus arguments and
 * returns structured data a test asserts on.
 *
 * Endpoint shapes verified against source (FND.md section 0):
 *  - POST /bubble-flow/:id/execute-stream  SSE StreamingLogEvent frames
 *  - GET  /bubble-flow/:id/executions?limit=N -> { items, total }
 *    (apps/bubblelab-api/src/routes/bubble-flows.ts:1069-1096)
 *  - GET  /build/:flowId/thread -> { sessionId, status, transcript }
 *    POST /build/:flowId/message  SSE named frames
 *    (services/builder-agent/src/index.ts:140,213; frame names in builder.ts frameFor)
 *  - POST/GET /telemetry ring buffer with server-stamped seq
 *    (apps/bubblelab-api/src/routes/telemetry.ts)
 */
import { jsonFetch, sseCollect } from './api.mjs';
import { runErrorSignals } from './signals.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run the flow; returns { events, success, signals }. `events` = StreamingLogEvent list. */
export async function executeStream(stack, flowId, payload = {}, timeoutMs = 240_000) {
  const frames = await sseCollect(
    stack.api,
    `/bubble-flow/${flowId}/execute-stream`,
    payload,
    timeoutMs
  );
  const events = frames.map((f) => f.data).filter((d) => d && typeof d === 'object');
  const complete = events.find((e) => e.type === 'execution_complete');
  const success = complete?.additionalData?.success === true;
  return { events, success, signals: runErrorSignals(events) };
}

/** Persisted run history for the flow, newest first. */
export async function executions(stack, flowId, limit = 10) {
  const { status, body } = await jsonFetch(
    stack.api,
    `/bubble-flow/${flowId}/executions?limit=${limit}`
  );
  if (status !== 200) throw new Error(`executions(${flowId}) -> HTTP ${status}`);
  return body.items ?? [];
}

/** Sidecar build thread: { sessionId, status, transcript }. */
export async function buildThread(stack, flowId) {
  if (!stack.sidecar) throw new Error('no sidecar url resolved');
  const { status, body } = await jsonFetch(stack.sidecar, `/build/${flowId}/thread`);
  if (status !== 200) throw new Error(`buildThread(${flowId}) -> HTTP ${status}`);
  return body;
}

/**
 * Send one message to the flow's builder session, consume the SSE turn.
 * Returns { events, toolCalls, assistantText } — toolCalls from `assistant`
 * frames' tool_use blocks; assistantText joins text blocks + the `result` frame.
 */
export async function buildMessage(stack, flowId, message, timeoutMs = 360_000) {
  if (!stack.sidecar) throw new Error('no sidecar url resolved');
  const frames = await sseCollect(
    stack.sidecar,
    `/build/${flowId}/message`,
    { message },
    timeoutMs
  );
  const toolCalls = [];
  const texts = [];
  for (const f of frames) {
    if (f.event === 'assistant' && Array.isArray(f.data?.blocks)) {
      for (const b of f.data.blocks) {
        if (b.type === 'tool_use') toolCalls.push({ name: b.name, input: b.input });
        else if (b.type === 'text' && b.text) texts.push(b.text);
      }
    } else if (f.event === 'result' && typeof f.data?.result === 'string') {
      texts.push(f.data.result);
    }
  }
  return { events: frames, toolCalls, assistantText: texts.join('\n') };
}

/**
 * Poll the build thread until a user turn containing `markerText` exists,
 * status has left 'building', and an assistant text turn follows the marker.
 * Returns { thread, markerIdx, afterMarker } (markerIdx -1 on timeout).
 */
export async function awaitThreadTurn(stack, flowId, { markerText, timeoutMs = 360_000, pollMs = 5000 }) {
  const deadline = Date.now() + timeoutMs;
  let thread = null;
  let markerIdx = -1;
  for (;;) {
    thread = await buildThread(stack, flowId);
    const items = thread?.transcript ?? [];
    markerIdx = items.findIndex(
      (it) =>
        it.role === 'user' &&
        (it.blocks ?? []).some((b) => b.type === 'text' && b.text?.includes(markerText))
    );
    const done =
      markerIdx !== -1 &&
      thread.status !== 'building' &&
      items
        .slice(markerIdx + 1)
        .some((it) => it.role === 'assistant' && (it.blocks ?? []).some((b) => b.type === 'text'));
    if (done || Date.now() > deadline) break;
    await sleep(pollMs);
  }
  return {
    thread,
    markerIdx,
    afterMarker: markerIdx === -1 ? [] : (thread?.transcript ?? []).slice(markerIdx + 1),
  };
}

/**
 * High-water mark of the telemetry ring buffer (max seq), taken BEFORE acting.
 * The buffer resets on API restart, so tests baseline then filter on seq.
 */
export async function telemetryBaseline(stack) {
  const { status, body } = await jsonFetch(stack.api, '/telemetry?limit=1');
  if (status !== 200) throw new Error(`telemetryBaseline -> HTTP ${status}`);
  const last = body.events?.[body.events.length - 1];
  return last?.seq ?? 0;
}

/** Query telemetry; filters client-side on seq > sinceSeq (server filter is ISO-`since` only). */
export async function telemetry(stack, { type, flowId, sinceSeq, limit = 500 } = {}) {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (flowId !== undefined) params.set('flowId', String(flowId));
  params.set('limit', String(limit));
  const { status, body } = await jsonFetch(stack.api, `/telemetry?${params}`);
  if (status !== 200) throw new Error(`telemetry query -> HTTP ${status}`);
  const events = body.events ?? [];
  return sinceSeq !== undefined ? events.filter((e) => e.seq > sinceSeq) : events;
}
