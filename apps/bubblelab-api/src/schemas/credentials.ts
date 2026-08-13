import { createRoute, z } from '@hono/zod-openapi';
import {
  errorResponseSchema,
  credentialResponseSchema,
  createCredentialSchema,
  createCredentialResponseSchema,
  updateCredentialSchema,
  updateCredentialResponseSchema,
  databaseMetadataSchema,
  credentialScopeCheckRequestSchema,
  credentialScopeCheckResponseSchema,
} from './index.js';

// S9: provider-side outcome of a credential delete. Kept local (not in
// @bubblelab/shared-schemas) so this API-only response shape doesn't require
// rebuilding the shared package's dist for the change to take effect.
export const deleteCredentialResponseSchema = z
  .object({
    message: z.string().openapi({ description: 'Success message' }),
    providerRevocation: z
      .object({
        status: z
          .enum(['revoked', 'already_invalid', 'unsupported', 'error'])
          .openapi({
            description:
              "Outcome of the provider-side revoke call: 'revoked' (grant confirmed gone), " +
              "'already_invalid' (provider had nothing left to revoke, e.g. an expired token), " +
              "'unsupported' (provider has no programmatic revoke endpoint — see manageAppsUrl), " +
              "'error' (the revoke call itself failed).",
          }),
        manageAppsUrl: z.string().url().optional().openapi({
          description:
            "Present when status is 'unsupported': the provider's own connected-apps page where the user must remove BubbleLab to fully disconnect it.",
        }),
        manageAppsInstructions: z.string().optional(),
      })
      .optional()
      .openapi({
        description:
          'Present only when the deleted credential was an OAuth credential.',
      }),
  })
  .openapi('DeleteCredentialResponse');

// POST /credentials/:id/scope-check - Verify granted scopes against requirements
// (suite-aware binding: a Google credential of one type can serve a step of a sibling
// type once its granted scopes cover the step's requirements).
export const credentialScopeCheckRoute = createRoute({
  method: 'post',
  path: '/{id}/scope-check',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'Credential ID',
          example: '123',
        }),
    }),
    body: {
      content: {
        'application/json': {
          schema: credentialScopeCheckRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: credentialScopeCheckResponseSchema,
        },
      },
      description:
        'Granted scopes verified (live probe when the provider supports it) and diffed against the requirements',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description:
        'Credential not found, not owned, or not an OAuth credential',
    },
    500: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
  tags: ['Credentials'],
});

// GET /credentials/platform-types — the effective platform-provided credential
// classification (S1): declared-SYSTEM types the API's env actually backs.
// Every studio binding surface consults this set; a declared-SYSTEM type absent
// here behaves as a user credential (Setup card, dropdown default, auto-bind,
// run gate).
export const platformCredentialTypesResponseSchema = z.object({
  platformCredentialTypes: z.array(z.string()),
});

export const platformCredentialTypesRoute = createRoute({
  method: 'get',
  path: '/platform-types',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: platformCredentialTypesResponseSchema,
        },
      },
      description:
        'Credential types the platform provides from its own environment',
    },
    500: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
  tags: ['Credentials'],
});

// GET /credentials - List user's credentials
export const listCredentialsRoute = createRoute({
  method: 'get',
  path: '/',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.array(credentialResponseSchema),
        },
      },
      description: 'List of user credentials',
    },
    500: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
  tags: ['Credentials'],
});

// POST /credentials - Create new credential
export const createCredentialRoute = createRoute({
  method: 'post',
  path: '/',
  request: {
    body: {
      content: {
        'application/json': {
          schema: createCredentialSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: createCredentialResponseSchema,
        },
      },
      description: 'Credential created successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Validation failed',
    },
    500: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
  tags: ['Credentials'],
});

// DELETE /credentials/:id - Delete credential
export const deleteCredentialRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'Credential ID',
          example: '123',
        }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: deleteCredentialResponseSchema,
        },
      },
      description: 'Credential deleted successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid credential ID format',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Credential not found',
    },
    500: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
  tags: ['Credentials'],
});

// PUT /credentials/:id - Update credential
export const updateCredentialRoute = createRoute({
  method: 'put',
  path: '/{id}',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'Credential ID',
          example: '123',
        }),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateCredentialSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: updateCredentialResponseSchema,
        },
      },
      description: 'Credential updated successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid credential ID format or validation failed',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Credential not found',
    },
    500: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
  tags: ['Credentials'],
});

// GET /credentials/:id/metadata - Get credential metadata
export const getCredentialMetadataRoute = createRoute({
  method: 'get',
  path: '/{id}/metadata',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'Credential ID',
          example: '123',
        }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: databaseMetadataSchema.nullable(),
        },
      },
      description: 'Credential metadata retrieved successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid credential ID format',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Credential not found',
    },
    500: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
  tags: ['Credentials'],
});
