/**
 * Postgres SessionStore adapter for the Claude Agent SDK, modeled on the
 * SDK's Postgres reference adapter
 * (github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores).
 *
 * Contract (sdk.d.ts `SessionStore`, @alpha):
 * - append(): persist entries in append-call order; entries with a `uuid`
 *   are idempotent (upsert / ignore duplicate), entries without one are
 *   appended as-is.
 * - load(): return entries deep-equal to what was appended, in order, or
 *   null for a session never written.
 * - listSubkeys(): subagent transcript discovery on resume (we spawn no
 *   subagents, but implement it so resume materialization is complete).
 */
import { and, asc, eq } from 'drizzle-orm';
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import { db, sessionEntries } from './db.ts';

function subpathOf(key: SessionKey): string {
  return key.subpath ?? '';
}

export function createPostgresSessionStore(): SessionStore {
  return {
    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      for (const entry of entries) {
        const row = {
          projectKey: key.projectKey,
          sessionId: key.sessionId,
          subpath: subpathOf(key),
          entryUuid: typeof entry.uuid === 'string' ? entry.uuid : null,
          entry,
        };
        if (row.entryUuid !== null) {
          // The dedup index is partial (WHERE entry_uuid IS NOT NULL), so a
          // column-list conflict target cannot infer it; the bare form
          // (ON CONFLICT DO NOTHING) covers partial unique indexes.
          await db.insert(sessionEntries).values(row).onConflictDoNothing();
        } else {
          await db.insert(sessionEntries).values(row);
        }
      }
    },

    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const rows = await db
        .select({ entry: sessionEntries.entry })
        .from(sessionEntries)
        .where(
          and(
            eq(sessionEntries.projectKey, key.projectKey),
            eq(sessionEntries.sessionId, key.sessionId),
            eq(sessionEntries.subpath, subpathOf(key))
          )
        )
        .orderBy(asc(sessionEntries.id));
      if (rows.length === 0) return null;
      return rows.map((row) => row.entry);
    },

    async listSubkeys(key: {
      projectKey: string;
      sessionId: string;
    }): Promise<string[]> {
      const rows = await db
        .selectDistinct({ subpath: sessionEntries.subpath })
        .from(sessionEntries)
        .where(
          and(
            eq(sessionEntries.projectKey, key.projectKey),
            eq(sessionEntries.sessionId, key.sessionId)
          )
        );
      return rows.map((row) => row.subpath).filter((subpath) => subpath !== '');
    },
  };
}

/**
 * Load the stored transcript for a session (main transcript only), for the
 * studio's thread rehydration. Keyed by sessionId alone: session ids are
 * UUIDs, and the SDK derives projectKey from its sanitized cwd, which this
 * service does not re-derive.
 */
export async function loadTranscript(
  sessionId: string
): Promise<SessionStoreEntry[]> {
  const rows = await db
    .select({ entry: sessionEntries.entry })
    .from(sessionEntries)
    .where(
      and(
        eq(sessionEntries.sessionId, sessionId),
        eq(sessionEntries.subpath, '')
      )
    )
    .orderBy(asc(sessionEntries.id));
  return rows.map((row) => row.entry);
}
