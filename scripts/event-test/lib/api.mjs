/**
 * Raw transports: JSON fetch + SSE collection.
 *
 * sseCollect handles both framings seen in this repo:
 *  - API execute-stream: bare `data: {...}` lines (StreamingLogEvent), no
 *    `event:` field (apps/bubblelab-api/src/routes/bubble-flows.ts).
 *  - Sidecar /build/:id/message: named frames `event: assistant|result|...`
 *    followed by `data: {...}` (services/builder-agent/src/index.ts:176-186).
 */

/** JSON in/out against a base url. Returns { status, body } (body = parsed JSON or raw text). */
export async function jsonFetch(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/**
 * POST `payload` to `base+path`, consume the SSE stream fully.
 * Returns frames: [{ event, data }] where `event` is the SSE event name
 * ('message' when unnamed) and `data` is the parsed `data:` payload.
 */
export async function sseCollect(base, path, payload, timeoutMs = 240_000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const frames = [];
  let eventName = 'message';
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text() : '';
      throw new Error(`SSE POST ${path} -> HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 1);
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim() || 'message';
        } else if (line.startsWith('data:')) {
          const raw = line.slice(5).trimStart();
          try {
            frames.push({ event: eventName, data: JSON.parse(raw) });
          } catch {
            frames.push({ event: eventName, data: raw });
          }
        } else if (line === '') {
          eventName = 'message'; // frame boundary resets the event name
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return frames;
}
