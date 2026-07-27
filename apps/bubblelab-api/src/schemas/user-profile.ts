import { createRoute } from '@hono/zod-openapi';
import {
  userProfileResponseSchema,
  updateUserProfileRequestSchema,
} from '@bubblelab/shared-schemas';

// GET /user-profile - Get the current user's profile ("for me" defaults)
export const getUserProfileRoute = createRoute({
  method: 'get',
  path: '/',
  summary: 'Get the current user profile',
  description:
    'Returns the authenticated user\'s "for me" defaults (recipient email, Telegram chat id). Fields are null when unset; a user with no profile row gets all-null fields.',
  tags: ['UserProfile'],
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: 'User profile retrieved successfully',
      content: {
        'application/json': {
          schema: userProfileResponseSchema,
        },
      },
    },
    401: {
      description: 'Unauthorized',
    },
  },
});

// PUT /user-profile - Upsert the current user's profile
export const updateUserProfileRoute = createRoute({
  method: 'put',
  path: '/',
  summary: 'Update the current user profile',
  description:
    'Upserts the authenticated user\'s "for me" defaults. Partial: omitted fields stay untouched, explicit null clears a field. Returns the resulting profile.',
  tags: ['UserProfile'],
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: updateUserProfileRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'User profile updated successfully',
      content: {
        'application/json': {
          schema: userProfileResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request body',
    },
    401: {
      description: 'Unauthorized',
    },
  },
});
