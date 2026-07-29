/**
 * Drizzle handle over the repo's shared Postgres for the two builder tables.
 *
 * The canonical DDL lives in the repo migration
 * apps/bubblelab-api/drizzle-postgres/0020_*.sql (generated from
 * apps/bubblelab-api/src/db/schema-postgres.ts, which declares the same two
 * tables). This file re-declares them for the Node sidecar because the Bun
 * API's db layer is not importable from outside the pnpm workspace; the
 * column shapes here MUST stay in sync with schema-postgres.ts.
 */
import { isNotNull } from 'drizzle-orm';
import {
  bigserial,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from './config.ts';

export const buildThreads = pgTable('build_threads', {
  flowId: integer('flow_id').primaryKey(),
  sessionId: text('session_id'),
  agentKind: text('agent_kind').notNull().default('flow'),
  status: text('status').notNull().default('idle'),
  deferredSetup: jsonb('deferred_setup'),
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sessionEntries = pgTable(
  'session_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectKey: text('project_key').notNull(),
    sessionId: text('session_id').notNull(),
    subpath: text('subpath').notNull().default(''),
    entryUuid: text('entry_uuid'),
    entry: jsonb('entry')
      .$type<{ type: string; uuid?: string; [k: string]: unknown }>()
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('session_entries_uuid_unique')
      .on(table.projectKey, table.sessionId, table.subpath, table.entryUuid)
      .where(isNotNull(table.entryUuid)),
  ]
);

const pool = new pg.Pool({ connectionString: config.databaseUrl });

export const db = drizzle(pool, {
  schema: { buildThreads, sessionEntries },
});

export type BuildThread = typeof buildThreads.$inferSelect;
