/**
 * User-profile routes: read + upsert the authenticated user's "for me"
 * defaults (recipient email, Telegram chat id). One row per user in
 * user_profiles; values feed resolveUserProfileDefaults which prefills
 * matching flow inputs via GET /bubble-flow/:id `userProfileDefaults`.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { authMiddleware, getUserId } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { userProfiles } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  getUserProfileRoute,
  updateUserProfileRoute,
} from '../schemas/user-profile.js';
import type { UserProfileResponse } from '@bubblelab/shared-schemas';

const app = new OpenAPIHono();

// Apply auth middleware to all routes
app.use('*', authMiddleware);

app.openapi(getUserProfileRoute, async (c) => {
  const userId = getUserId(c);

  const [profile] = await db
    .select({
      recipientEmail: userProfiles.recipientEmail,
      telegramChatId: userProfiles.telegramChatId,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  const response: UserProfileResponse = {
    recipientEmail: profile?.recipientEmail ?? null,
    telegramChatId: profile?.telegramChatId ?? null,
  };
  return c.json(response, 200);
});

app.openapi(updateUserProfileRoute, async (c) => {
  const userId = getUserId(c);
  const body = c.req.valid('json');

  // Partial upsert: only fields present in the body are written; explicit
  // null clears. Build the update set from provided keys so an omitted field
  // never overwrites a stored value.
  const changes: Partial<{
    recipientEmail: string | null;
    telegramChatId: string | null;
  }> = {};
  if (body.recipientEmail !== undefined) {
    changes.recipientEmail = body.recipientEmail;
  }
  if (body.telegramChatId !== undefined) {
    changes.telegramChatId = body.telegramChatId;
  }

  const [row] = await db
    .insert(userProfiles)
    .values({ userId, ...changes })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { ...changes, updatedAt: new Date() },
    })
    .returning({
      recipientEmail: userProfiles.recipientEmail,
      telegramChatId: userProfiles.telegramChatId,
    });

  const response: UserProfileResponse = {
    recipientEmail: row.recipientEmail,
    telegramChatId: row.telegramChatId,
  };
  return c.json(response, 200);
});

export default app;
