import { createRoute, z } from '@hono/zod-openapi';
import {
  errorResponseSchema,
  createBubbleFlowSchema,
  createBubbleFlowResponseSchema,
  createEmptyBubbleFlowSchema,
  createEmptyBubbleFlowResponseSchema,
  executeBubbleFlowSchema,
  executeBubbleFlowResponseSchema,
  testBubbleFlowSchema,
  bubbleFlowDetailsResponseSchema,
  updateBubbleFlowParametersSchema,
  updateBubbleFlowNameSchema,
  bubbleFlowListResponseSchema,
  activateBubbleFlowResponseSchema,
  listBubbleFlowExecutionsResponseSchema,
  bubbleFlowExecutionDetailSchema,
  successMessageResponseSchema,
  validateBubbleFlowCodeSchema,
  validateBubbleFlowCodeResponseSchema,
} from './index.js';

// POST /bubble-flow - Validate and store BubbleFlow
export const createBubbleFlowRoute = createRoute({
  method: 'post',
  path: '/',
  request: {
    body: {
      content: {
        'application/json': {
          schema: createBubbleFlowSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: createBubbleFlowResponseSchema,
        },
      },
      description: 'BubbleFlow created successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Validation failed or invalid input',
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
  tags: ['BubbleFlow'],
});

// POST /bubble-flow/empty - Create empty BubbleFlow (for async code generation)
export const createEmptyBubbleFlowRoute = createRoute({
  method: 'post',
  path: '/empty',
  request: {
    body: {
      content: {
        'application/json': {
          schema: createEmptyBubbleFlowSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: createEmptyBubbleFlowResponseSchema,
        },
      },
      description:
        'Empty BubbleFlow created successfully. Code generation in progress.',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid input',
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
  tags: ['BubbleFlow'],
});

// POST /:id/execute - Execute stored BubbleFlow
export const executeBubbleFlowRoute = createRoute({
  method: 'post',
  path: '/{id}/execute',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
    }),
    body: {
      content: {
        'application/json': {
          schema: executeBubbleFlowSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: executeBubbleFlowResponseSchema,
        },
      },
      description: 'BubbleFlow executed successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow not found',
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
  tags: ['BubbleFlow'],
});

// POST /:id/test - Execute stored BubbleFlow in TEST MODE (write-hinted
// operations are mocked in BaseBubble.action(); reads run for real)
export const testBubbleFlowRoute = createRoute({
  method: 'post',
  path: '/{id}/test',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
    }),
    body: {
      content: {
        'application/json': {
          schema: testBubbleFlowSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: executeBubbleFlowResponseSchema,
        },
      },
      description: 'BubbleFlow test run completed',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format or test run failed',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow not found',
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
  tags: ['BubbleFlow'],
});

// POST /:id/execute-stream - Execute stored BubbleFlow with live streaming
export const executeBubbleFlowStreamRoute = createRoute({
  method: 'post',
  path: '/{id}/execute-stream',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
    }),
    body: {
      content: {
        'application/json': {
          schema: executeBubbleFlowSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'text/event-stream': {
          schema: z.string().openapi({
            description: 'Server-Sent Events stream with execution logs',
            example:
              'data: {"type":"log_line","timestamp":"2024-01-01T00:00:00Z","lineNumber":1,"message":"Statement: VariableDeclaration"}\n\n',
          }),
        },
      },
      description: 'BubbleFlow execution stream started successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow not found',
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
  tags: ['BubbleFlow'],
});

// GET /bubble-flow/:id - Get bubble flow details with parameters
export const getBubbleFlowRoute = createRoute({
  method: 'get',
  path: '/{id}',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: bubbleFlowDetailsResponseSchema,
        },
      },
      description: 'BubbleFlow details retrieved successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow not found',
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
  tags: ['BubbleFlow'],
});

// PUT /bubble-flow/:id - Update bubble flow parameters
export const updateBubbleFlowRoute = createRoute({
  method: 'put',
  path: '/{id}',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateBubbleFlowParametersSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: updateBubbleFlowParametersSchema,
        },
      },
      description: 'BubbleFlow parameters updated successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format or validation failed',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow not found',
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
  tags: ['BubbleFlow'],
});

// PATCH /bubble-flow/:id/name - Update bubble flow name
export const updateBubbleFlowNameRoute = createRoute({
  method: 'patch',
  path: '/{id}/name',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateBubbleFlowNameSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: successMessageResponseSchema,
        },
      },
      description: 'BubbleFlow name updated successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format or name validation failed',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow not found',
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
  tags: ['BubbleFlow'],
});

// U2: the flow's registered headline output, persisted at
// bubble_flows.metadata.primaryOutput. Every registered key is a top-level
// property of the handle() return object, so finalResult[key] is always
// defined on a successful run (the builder SOP enforces the invariant).
export const primaryOutputSchema = z
  .object({
    kind: z.enum(['artefact', 'process', 'both']).openapi({
      description:
        "What the flow's headline result is: 'artefact' = a produced thing with a link (doc/sheet/file URL); 'process' = something that happened with no artefact (stated outcomes); 'both' = an artefact plus stated outcomes",
    }),
    label: z.string().min(1).max(80).openapi({
      description:
        'User-facing plain-language label for the result, in the user\'s own vocabulary (e.g. "Your weekly digest")',
    }),
    artefactKey: z.string().min(1).optional().openapi({
      description:
        "Top-level handle() return key whose value is the artefact link; required when kind is 'artefact' or 'both'",
    }),
    outcomeKeys: z.array(z.string().min(1)).optional().openapi({
      description:
        "Top-level handle() return keys whose values state what happened; required (non-empty) when kind is 'process' or 'both'",
    }),
  })
  .refine(
    (value) => value.kind === 'process' || value.artefactKey !== undefined,
    {
      message: "artefactKey is required when kind is 'artefact' or 'both'",
    }
  )
  .refine(
    (value) =>
      value.kind === 'artefact' || (value.outcomeKeys?.length ?? 0) > 0,
    {
      message: "outcomeKeys must be non-empty when kind is 'process' or 'both'",
    }
  )
  .openapi('PrimaryOutput');

export type PrimaryOutput = z.infer<typeof primaryOutputSchema>;

// PATCH /bubble-flow/:id/primary-output - Register the flow's headline output
// (mirrors updateBubbleFlowNameRoute; the handler MERGES into metadata jsonb)
export const updatePrimaryOutputRoute = createRoute({
  method: 'patch',
  path: '/{id}/primary-output',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
    }),
    body: {
      content: {
        'application/json': {
          schema: primaryOutputSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: successMessageResponseSchema,
        },
      },
      description: 'Primary output updated successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format or primary output validation failed',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow not found',
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
  tags: ['BubbleFlow'],
});

// GET /bubble-flow - List all bubble flows for the user
export const listBubbleFlowsRoute = createRoute({
  method: 'get',
  path: '/',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: bubbleFlowListResponseSchema,
        },
      },
      description: 'List of user bubble flows',
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
  tags: ['BubbleFlow'],
});

// POST /bubble-flow/:id/activate - Activate bubble flow webhook
export const activateBubbleFlowRoute = createRoute({
  method: 'post',
  path: '/{id}/activate',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: activateBubbleFlowResponseSchema,
        },
      },
      description: 'BubbleFlow activated successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format',
    },
    403: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Webhook limit exceeded',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow not found',
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
  tags: ['BubbleFlow'],
});

// POST /bubble-flow/:id/deactivate - Deactivate bubble flow webhook
export const deactivateBubbleFlowRoute = createRoute({
  method: 'post',
  path: '/{id}/deactivate',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean().openapi({
              description: 'Whether the deactivation was successful',
              example: true,
            }),
            message: z.string().openapi({
              description: 'Success message',
              example: 'Webhook deactivated successfully',
            }),
          }),
        },
      },
      description: 'Webhook deactivated successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow not found',
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
  tags: ['BubbleFlow'],
});

// DELETE /bubble-flow/:id - Delete bubble flow
export const deleteBubbleFlowRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: successMessageResponseSchema,
        },
      },
      description: 'BubbleFlow deleted successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow not found',
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
  tags: ['BubbleFlow'],
});

// GET /bubble-flow/:id/executions - Get BubbleFlow execution history
export const listBubbleFlowExecutionsRoute = createRoute({
  method: 'get',
  path: '/{id}/executions',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
    }),
    query: z.object({
      limit: z
        .string()
        .regex(/^[0-9]+$/)
        .optional()
        .openapi({
          description: 'Maximum number of executions to return',
          example: '50',
        }),
      offset: z
        .string()
        .regex(/^[0-9]+$/)
        .optional()
        .openapi({
          description: 'Number of executions to skip',
          example: '0',
        }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: listBubbleFlowExecutionsResponseSchema,
        },
      },
      description: 'BubbleFlow execution history retrieved successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow not found',
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
  tags: ['BubbleFlow'],
});

// GET /bubble-flow/:id/executions/:executionId - Get single execution with logs
export const getBubbleFlowExecutionDetailRoute = createRoute({
  method: 'get',
  path: '/{id}/executions/{executionId}',
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'BubbleFlow ID',
          example: '123',
        }),
      executionId: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description: 'Execution ID',
          example: '456',
        }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: bubbleFlowExecutionDetailSchema,
        },
      },
      description: 'Execution detail with logs retrieved successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid ID format',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'BubbleFlow or execution not found',
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
  tags: ['BubbleFlow'],
});

export const validateBubbleFlowCodeRoute = createRoute({
  method: 'post',
  path: '/validate',
  request: {
    body: {
      content: {
        'application/json': {
          schema: validateBubbleFlowCodeSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: validateBubbleFlowCodeResponseSchema,
        },
      },
      description: 'BubbleFlow code validation result',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid request body',
    },
    403: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Webhook limit exceeded',
    },
    404: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description:
        'BubbleFlow not found or user does not have permission to update it',
    },
    500: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Internal server error during validation',
    },
  },
  tags: ['BubbleFlow'],
  summary: 'Validate BubbleFlow Code',
  description:
    'Validates TypeScript BubbleFlow code for syntax, type errors, and bubble structure',
});

// POST /bubble-flow/generate/run-context-flow - Execute a context-gathering flow
// Used by external agents to gather context (e.g., database schema, file
// listings) before authoring a flow.
export const runContextFlowSchema = z.object({
  flowCode: z.string().min(1).openapi({
    description: 'The validated BubbleFlow TypeScript code to execute',
    example: 'class ContextGatheringFlow extends BubbleFlow { ... }',
  }),
  credentials: z.record(z.string(), z.number()).openapi({
    description: 'Mapping of credential types to credential IDs for execution',
    example: { GOOGLE_DRIVE_CRED: 123, DATABASE_CRED: 456 },
  }),
});

export const runContextFlowResponseSchema = z.object({
  success: z.boolean().openapi({
    description: 'Whether the flow execution succeeded',
  }),
  result: z.any().optional().openapi({
    description: 'The result data from the flow execution',
  }),
  error: z.string().optional().openapi({
    description: 'Error message if execution failed',
  }),
});

export const runContextFlowRoute = createRoute({
  method: 'post',
  path: '/generate/run-context-flow',
  request: {
    body: {
      content: {
        'application/json': {
          schema: runContextFlowSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: runContextFlowResponseSchema,
        },
      },
      description: 'Context flow executed successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid flow code or credentials',
    },
    500: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Flow execution failed',
    },
  },
  tags: ['BubbleFlow'],
  summary: 'Execute Context-Gathering Flow',
  description:
    'Executes a validated BubbleFlow to gather external context (e.g., database schema, file listings) for an external authoring agent',
});
