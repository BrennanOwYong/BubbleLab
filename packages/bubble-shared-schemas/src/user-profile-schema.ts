import { z } from '@hono/zod-openapi';

// ============================================================================
// USER PROFILE SCHEMAS
// ============================================================================
// Per-user "for me" defaults stored outside credentials: the flow creator's
// OWN recipient email and Telegram chat id, auto-filled into flow inputs when
// the user says "send it to me / do it for me". One profile row per user.

// GET /user-profile response
export const userProfileResponseSchema = z
  .object({
    recipientEmail: z.string().nullable().openapi({
      description:
        'The email address "send it to me" flows deliver to (the user\'s own inbox choice), or null when unset',
      example: 'me@example.com',
    }),
    telegramChatId: z.string().nullable().openapi({
      description:
        'The user\'s own Telegram chat id for "message me" flows, or null when unset',
      example: '123456789',
    }),
  })
  .openapi('UserProfileResponse');

// PUT /user-profile request: partial upsert; omitted fields stay untouched,
// explicit null clears a field.
export const updateUserProfileRequestSchema = z
  .object({
    recipientEmail: z
      .string()
      .email('Valid email is required')
      .nullable()
      .optional()
      .openapi({
        description:
          'New recipient email; null clears it, omit to leave unchanged',
        example: 'me@example.com',
      }),
    telegramChatId: z.string().min(1).nullable().optional().openapi({
      description:
        'New Telegram chat id; null clears it, omit to leave unchanged',
      example: '123456789',
    }),
  })
  .openapi('UpdateUserProfileRequest');

export type UserProfileResponse = z.infer<typeof userProfileResponseSchema>;
export type UpdateUserProfileRequest = z.infer<
  typeof updateUserProfileRequestSchema
>;
