/**
 * Tool source-of-truth watchdog routes:
 *
 *   POST /tool-watchdog/check   run one check cycle now, return its events
 *   GET  /tool-watchdog/status  scheduler state + last cycle's events
 *
 * The event payloads are the same typed ToolWatchdogEvents the scheduler
 * logs — the studio (or a test) can render/assert the full decision trail.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  setupErrorHandler,
  validationErrorHook,
} from '../utils/error-handler.js';
import { getToolSourceWatchdog } from '../services/tool-source-watchdog.js';

const app = new OpenAPIHono({
  defaultHook: validationErrorHook,
});
setupErrorHandler(app);

app.post('/check', async (c) => {
  const watchdog = getToolSourceWatchdog();
  if (!watchdog) {
    return c.json({ error: 'watchdog not started' }, 503);
  }
  if (watchdog.isRunning()) {
    return c.json({ error: 'a check cycle is already running' }, 409);
  }
  const { events, exitCode } = await watchdog.runOnce('manual');
  return c.json({ exitCode, events });
});

app.get('/status', (c) => {
  const watchdog = getToolSourceWatchdog();
  if (!watchdog) {
    return c.json({ error: 'watchdog not started' }, 503);
  }
  return c.json({
    running: watchdog.isRunning(),
    lastCycleEvents: watchdog.recentEvents(),
  });
});

export default app;
