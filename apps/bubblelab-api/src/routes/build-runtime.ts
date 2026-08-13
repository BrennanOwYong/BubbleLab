/**
 * FE5 — builder runtime toggle surface (ops control only; no studio UI, per
 * the F0.5 non-technical principle). Auth-gated like /build in src/index.ts.
 *
 *   GET  /build-runtime          -> BuilderRuntimeStatus {mode, target, child, health}
 *   PUT  /build-runtime          {mode: 'external'|'managed'|'off', url?}
 *                                url (optional) overrides the external target
 *   POST /build-runtime/restart  kill + respawn the managed child (the S8
 *                                stale-auth heal seam)
 *
 * State lives in services/builder-runtime.ts; every transition emits
 * builder_runtime.* events to the [TELEMETRY] console sink and the /telemetry
 * ring buffer (Pillar 2).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  BUILDER_MODES,
  getBuilderRuntimeStatus,
  restartBuilderRuntime,
  setBuilderMode,
} from '../services/builder-runtime.js';

const app = new Hono();

const putBodySchema = z.object({
  mode: z.enum(BUILDER_MODES),
  url: z.string().url().optional(),
});

app.get('/', async (c) => c.json(await getBuilderRuntimeStatus()));

app.put('/', async (c) => {
  const parsed = putBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: "Body must be {mode: 'external'|'managed'|'off', url?: string}",
      },
      400
    );
  }
  try {
    return c.json(await setBuilderMode(parsed.data.mode, parsed.data.url));
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
});

app.post('/restart', async (c) => {
  try {
    return c.json(await restartBuilderRuntime());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
});

export default app;
