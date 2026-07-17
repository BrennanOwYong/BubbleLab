/**
 * Add-a-Tool routes: run the real spec-to-tool generator with streamed
 * telemetry (SSE), and expose the registered-tools registry the studio
 * "Third Party Integrations" catalog merges in.
 *
 *   POST   /tools/generate         SSE stream of ToolGenEvents
 *   GET    /tools/registered       registered tools list
 *   DELETE /tools/registered/:name unregister (catalog reset; keeps files)
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import {
  setupErrorHandler,
  validationErrorHook,
} from '../utils/error-handler.js';
import {
  generateTool,
  readRegistry,
  unregisterTool,
  type GenerateToolRequest,
  type ToolGenEvent,
} from '../services/tool-generator.js';

const app = new OpenAPIHono({
  defaultHook: validationErrorHook,
});
setupErrorHandler(app);

app.post('/generate', async (c) => {
  let body: GenerateToolRequest;
  try {
    body = (await c.req.json()) as GenerateToolRequest;
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400);
  }
  if (!body.specText && !body.specUrl) {
    return c.json({ error: 'Provide specText or specUrl' }, 400);
  }

  return streamSSE(c, async (stream) => {
    let sequence = 0;
    const emit = async (event: ToolGenEvent) => {
      // Console mirror keeps the run assertable from server logs too.
      console.log(`[tools:generate] ${event.type}`);
      await stream.writeSSE({
        data: JSON.stringify(event),
        event: event.type,
        id: String(sequence++),
      });
    };
    try {
      await generateTool(body, emit);
    } catch (error) {
      // generateTool reports its own failures; this catches transport-level
      // surprises so the client always gets a terminal event.
      await emit({
        type: 'generation_error',
        data: {
          code: 'CONTRACT_EMIT_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
    await stream.writeSSE({
      data: JSON.stringify({ type: 'stream_complete' }),
      event: 'stream_complete',
      id: String(sequence++),
    });
  });
});

app.get('/registered', async (c) => {
  const tools = await readRegistry();
  return c.json({ tools });
});

app.delete('/registered/:name', async (c) => {
  const removed = await unregisterTool(c.req.param('name'));
  if (!removed) {
    return c.json({ error: 'Tool is not registered' }, 404);
  }
  return c.json({ success: true });
});

export default app;
