import { createRoute, z } from '@hono/zod-openapi';
import { errorResponseSchema } from './index.js';

// POST /ai/speech-to-text - Convert audio to text
export const SpeechToTextRequestSchema = z.object({
  audio: z.string().openapi({
    description: 'Base64 encoded audio data',
    example: 'UklGRi...',
  }),
  language: z
    .array(z.string())
    .optional()
    .openapi({
      description: 'Preferred languages for transcription',
      example: ['en'],
    }),
});

export const SpeechToTextResponseSchema = z.object({
  text: z.string().openapi({
    description: 'Transcribed text',
    example: 'Hello world',
  }),
  duration: z.number().optional().openapi({
    description: 'Duration of the transcription in seconds',
    example: 1.5,
  }),
});

export const speechToTextRoute = createRoute({
  method: 'post',
  path: '/speech-to-text',
  summary: 'Speech to Text',
  description: 'Convert base64 encoded audio to text using Wispr API',
  request: {
    body: {
      content: {
        'application/json': {
          schema: SpeechToTextRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Transcription successful',
      content: {
        'application/json': {
          schema: SpeechToTextResponseSchema,
        },
      },
    },
    400: {
      description: 'Bad request or validation failed',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    },
  },
  tags: ['AI'],
});
