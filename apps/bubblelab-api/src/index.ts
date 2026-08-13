// Load environment variables first
import './config/env.js';
import { env } from './config/env.js';
import { posthog } from './services/posthog.js';

// Disable console.debug in dev mode (can be enabled with ENABLE_DEBUG_LOGS=true)
if (!process.env.ENABLE_DEBUG_LOGS) {
  console.debug = () => {};
}

import { runMigrations } from './db/migrate.js';
import { seedDevUser } from './db/seed-dev-user.js';
import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { type HealthCheckResponse } from './schemas/index.js';
import { authMiddleware } from './middleware/auth.js';
import { telemetryMiddleware } from './middleware/telemetry.js';
import {
  setupErrorHandler,
  validationErrorHook,
} from './utils/error-handler.js';

// Memory monitoring function
function logMemoryUsage() {
  // Memory logging disabled - can be re-enabled for debugging
}

// Import route modules
import bubbleFlowRoutes from './routes/bubble-flows.js';
import bubbleFlowTemplateRoutes from './routes/bubble-flow-templates.js';
import credentialRoutes from './routes/credentials.js';
import oauthRoutes from './routes/oauth.js';
import webhookRoutes from './routes/webhooks.js';
import authRoutes from './routes/auth.js';
import subscriptionRoutes from './routes/subscription.js';
import userProfileRoutes from './routes/user-profile.js';
import joinWaitlistRoutes from './routes/join-waitlist.js';
import { startCronScheduler } from './services/cron-scheduler.js';
import aiRoutes from './routes/ai.js';
import templateSubmissionRoutes from './routes/template-submission.js';
import browserbaseRoutes from './routes/browserbase.js';
import toolsRoutes from './routes/tools.js';
import buildRoutes from './routes/build.js';
import buildPageRoutes from './routes/build-page.js';
import buildRuntimeRoutes from './routes/build-runtime.js';
import pageRoutes from './routes/pages.js';
import telemetryRoutes from './routes/telemetry.js';
import { getBubbleFactory } from './services/bubble-factory-instance.js';
import {
  initBuilderRuntime,
  getBuilderTarget,
  builderAuthHeaders,
} from './services/builder-runtime.js';

const app = new OpenAPIHono({
  defaultHook: validationErrorHook,
});

// Global error handler
setupErrorHandler(app);

// Middleware
app.use('*', logger());
app.use('*', cors());
// Centralized request telemetry (structured [TELEMETRY] sink + PostHog when enabled).
// Registered before auth so it wraps every route; userId is read after next().
app.use('*', telemetryMiddleware);

// Apply auth middleware to specific routes that need it
app.use('/bubble-flow/*', authMiddleware);
app.use('/bubbleflow-template/*', authMiddleware);
app.use('/credentials/*', authMiddleware);
// Protect specific OAuth routes, but allow callbacks to be unauthenticated
app.use('/oauth/:provider/initiate', authMiddleware);
app.use('/oauth/:provider/refresh', authMiddleware);
app.use('/oauth/:provider/revoke/*', authMiddleware);
app.use('/auth/*', authMiddleware);
app.use('/execute-bubble-flow/*', authMiddleware);
app.use('/ai/*', authMiddleware);
app.use('/browserbase/*', authMiddleware);
app.use('/user-profile/*', authMiddleware);
app.use('/build/*', authMiddleware);
app.use('/build-page/*', authMiddleware);
// FE5 ops toggle: auth-gated like /build (ops control only, no studio UI).
app.use('/build-runtime', authMiddleware);
app.use('/build-runtime/*', authMiddleware);
app.use('/page', authMiddleware);
app.use('/page/*', authMiddleware);
app.use('/telemetry', authMiddleware);
app.use('/telemetry/*', authMiddleware);

// Note: webhook and execute-bubble-flow routes will handle verification internally
// They don't need auth middleware since they use their own authentication

// Health check
app.get('/', (c) => {
  const response: HealthCheckResponse = {
    message: 'BubbleLab API is running!',
    timestamp: new Date().toISOString(),
  };
  return c.json(response);
});

// Wake endpoint for the Telegram bot's "give me a live MVP link" trigger.
// This request landing here already wakes bubblelab-api itself (a free-tier
// Render web service wakes on the first inbound request); this handler also
// pings builder-agent's own /health over Render's private network to wake
// that service too, then returns the studio URL the bot sends the user —
// the same fixed URL every time, since Render's free tier sleeps/wakes a
// service without changing its address. Shared-secret gated so this isn't a
// public "keep every service awake forever" lever for anyone who finds it.
app.get('/wake', async (c) => {
  const secret = process.env.WAKE_SECRET;
  if (secret && c.req.query('secret') !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const builderTarget = getBuilderTarget();
  let builderAwake = false;
  if (builderTarget !== null) {
    try {
      const res = await fetch(`${builderTarget}/health`, {
        signal: AbortSignal.timeout(60_000),
        headers: builderAuthHeaders(),
      });
      builderAwake = res.ok;
    } catch {
      builderAwake = false;
    }
  }
  return c.json({
    apiAwake: true,
    builderAwake,
    studioUrl: process.env.STUDIO_URL ?? null,
  });
});

// Mount route modules
app.route('/bubble-flow', bubbleFlowRoutes);
app.route('/bubbleflow-template', bubbleFlowTemplateRoutes);
app.route('/credentials', credentialRoutes);
app.route('/oauth', oauthRoutes);
app.route('/webhook', webhookRoutes);
app.route('/auth', authRoutes);
app.route('/subscription', subscriptionRoutes);
app.route('/user-profile', userProfileRoutes);
app.route('/join-waitlist', joinWaitlistRoutes);
app.route('/ai', aiRoutes);
app.route('/template-submission', templateSubmissionRoutes);
app.route('/browserbase', browserbaseRoutes);
app.route('/tools', toolsRoutes);
app.route('/build', buildRoutes);
app.route('/build-page', buildPageRoutes);
app.route('/build-runtime', buildRuntimeRoutes);
app.route('/page', pageRoutes);
app.route('/telemetry', telemetryRoutes);

// OpenAPI documentation endpoint
app.doc('/doc', {
  openapi: '3.0.0',
  info: {
    version: '1.0.0',
    title: 'BubbleLab API',
    description: 'API for BubbleLab',
  },
  servers: [
    {
      url: process.env.NODEX_API_URL || 'http://localhost:3001',
      description: 'BubbleLab API Server',
    },
  ],
});

// Swagger UI endpoint
app.get('/ui', swaggerUI({ url: '/doc' }));

const port = process.env.PORT || 3001;

// Run migrations before starting the server
try {
  await runMigrations();
  // Seed dev user after migrations (only in dev mode)
  await seedDevUser();
  // Eagerly initialize bubble factory before handling any requests or starting cron
  await getBubbleFactory();
} catch (error) {
  console.error('Failed to run migrations or seed dev user, exiting...');
  process.exit(1);
}

console.log(`Server is running on port ${port}`);

// Log initial memory usage
logMemoryUsage();

// Log memory usage every 30 seconds
// setInterval(logMemoryUsage, 30000);

// Print ip address (best-effort; must never crash the server on a network failure)
fetch('https://api.ipify.org?format=json')
  .then((response) => response.json())
  .then((data) => console.log('Current IP:', (data as { ip: string }).ip))
  .catch((e) =>
    console.warn('IP lookup failed (non-fatal):', (e as Error)?.message)
  );
// Initialize PostHog error tracking
posthog.init({
  apiKey: env.POSTHOG_API_KEY || '',
  host: env.POSTHOG_HOST,
  enabled: env.POSTHOG_ENABLED,
});

// Start cron scheduler (in-process)
startCronScheduler();

// FE5: builder runtime manager — under env BUILDER_MODE=managed this spawns
// the sidecar child; every mode registers the shutdown hooks that kill the
// child by exact pid on API exit.
await initBuilderRuntime();

export default {
  port,
  fetch: app.fetch,
  // Configure timeout for streaming AI agent requests (max 255 seconds for Bun)
  idleTimeout: 255, // 4 minutes 15 seconds (maximum allowed by Bun)
  maxRequestBodySize: 20 * 1024 * 1024, // 20MB
};
