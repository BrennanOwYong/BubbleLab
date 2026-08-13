/**
 * FE2 — cross-flow user memory (PLAN-DOCS/discovery/FE2.md).
 *
 * Single owner of the user_defaults store shape: canonical per-user standing
 * datapoints ('email', 'telegram_bot', 'telegram_chat_id', free-form slugs)
 * the builder agent captures silently via the hidden remember_user_default
 * tool (tools.ts) and reads back as a per-turn system-prompt block
 * (prompts.ts via builder.ts). Keeps builder.ts/tools.ts thin.
 *
 * Identity: the API build proxy forwards the authenticated user as x-user-id;
 * direct sidecar hits fall back to FALLBACK_USER_ID, matching the API's dev
 * user (apps/bubblelab-api/src/db/seed-dev-user.ts) so records line up across
 * paths.
 */
import { and, eq } from 'drizzle-orm';
import { db, userDefaults, type UserDefaultRow } from './db.ts';

export type { UserDefaultRow };

/** Matches the Bun API's dev fallback user (seed-dev-user.ts). */
export const FALLBACK_USER_ID = 'mock-user-id';

/** Canonicalize a key to a stable slug: 'Telegram Bot' -> 'telegram_bot'. */
export function canonicalKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '_');
}

/** All stored defaults for one user, oldest key first (stable prompt order). */
export async function loadUserDefaults(
  userId: string
): Promise<UserDefaultRow[]> {
  const rows = await db
    .select()
    .from(userDefaults)
    .where(eq(userDefaults.userId, userId));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Upsert on (user_id, key); newest value wins. Returns the stored row. */
export async function upsertUserDefault(opts: {
  userId: string;
  key: string;
  value: string;
  description?: string;
  sourceFlowId?: number;
}): Promise<UserDefaultRow> {
  const key = canonicalKey(opts.key);
  const rows = await db
    .insert(userDefaults)
    .values({
      userId: opts.userId,
      key,
      value: opts.value,
      description: opts.description ?? null,
      sourceFlowId: opts.sourceFlowId ?? null,
    })
    .onConflictDoUpdate({
      target: [userDefaults.userId, userDefaults.key],
      set: {
        value: opts.value,
        ...(opts.description !== undefined
          ? { description: opts.description }
          : {}),
        ...(opts.sourceFlowId !== undefined
          ? { sourceFlowId: opts.sourceFlowId }
          : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`upsertUserDefault returned no row for key '${key}'`);
  }
  return row;
}

/** Delete one stored default; returns whether a row existed (test cleanup seam). */
export async function deleteUserDefault(
  userId: string,
  key: string
): Promise<boolean> {
  const rows = await db
    .delete(userDefaults)
    .where(
      and(
        eq(userDefaults.userId, userId),
        eq(userDefaults.key, canonicalKey(key))
      )
    )
    .returning({ key: userDefaults.key });
  return rows.length > 0;
}

/**
 * The silent-context module injected into the system prompt each turn.
 * Returns '' when the user has no stored defaults — the capture rules
 * (prompts.ts MEMORY_SOP) are always present regardless.
 */
export function formatDefaultsPromptBlock(rows: UserDefaultRow[]): string {
  if (rows.length === 0) return '';
  const lines = rows.map((row) => {
    const label = row.description !== null ? ` (${row.description})` : '';
    return `- ${row.key}: ${row.value}${label}`;
  });
  return `
# Known user defaults (silent context)

Standing defaults this user supplied in earlier conversations. Rules:
- When the user's request implies one of these ("email me" -> the stored email), use the stored value as the input default (e.g. via set_flow_defaults) without asking.
- NEVER re-ask for a datapoint listed here.
- NEVER tell the user a value was remembered or where it came from; use it as if it were given.
- An explicit value in the user's message wins over the stored one; when they present a NEW standing value ("use X from now on"), call remember_user_default again with the same key so the store updates.

${lines.join('\n')}
`;
}
