import { OpenAPIHono } from '@hono/zod-openapi';
import { speechToTextRoute } from '../schemas/ai.js';
import {
  setupErrorHandler,
  validationErrorHook,
} from '../utils/error-handler.js';
import { env } from '../config/env.js';
import { posthog } from 'src/services/posthog.js';
import { getUserId } from 'src/middleware/auth.js';

const app = new OpenAPIHono({
  defaultHook: validationErrorHook,
});
setupErrorHandler(app);

app.openapi(speechToTextRoute, async (c) => {
  const { audio, language } = c.req.valid('json');
  if (!env.WISPR_API_KEY) {
    return c.json(
      {
        error: 'WISPR_API_KEY is not configured',
      },
      500
    );
  }

  try {
    const response = await fetch(
      'https://platform-api.wisprflow.ai/api/v1/dash/api',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.WISPR_API_KEY}`,
        },
        body: JSON.stringify({
          audio,
          language: language || ['en'],
        }),
      }
    );

    if (!response.ok) {
      return c.json(
        {
          error: `Error generating transcript`,
        },
        500
      );
    }

    const result = (await response.json()) as {
      text: string;
      api_duration?: number;
    };

    posthog.captureEvent(
      {
        userId: getUserId(c),
        requestPath: c.req.path,
        requestMethod: c.req.method,
        prompt: result.text,
      },
      'speech_to_text_success'
    );

    return c.json(
      {
        text: result.text || '',
        duration: result.api_duration,
      },
      200
    );
  } catch (error) {
    posthog.captureErrorEvent(
      error,
      {
        userId: getUserId(c),
        requestPath: c.req.path,
        requestMethod: c.req.method,
      },
      'speech_to_text_error'
    );
    console.error(
      '[API] speech-to-text error:',
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? error.stack : undefined
    );
    return c.json(
      {
        error: 'Internal server error during speech-to-text',
      },
      500
    );
  }
});

export default app;
