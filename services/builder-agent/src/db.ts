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
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from './config.ts';

// subject_id (column name flow_id, kept for migration continuity) holds a
// bubble_flows.id when agent_kind='flow' and a pages.id when
// agent_kind='page'; the two id sequences overlap, hence the composite key.
export const buildThreads = pgTable(
  'build_threads',
  {
    subjectId: integer('flow_id').notNull(),
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
  },
  (table) => [primaryKey({ columns: [table.subjectId, table.agentKind] })]
);

// Pages built by the page-builder agent: a page is a persisted structured
// SPEC (see page-spec.ts), never free-form code. Row creation happens in the
// API (POST /page, which stamps ownership); this sidecar writes title/spec/
// status through the create_page / update_page tools.
export const pages = pgTable('pages', {
  id: serial().primaryKey(),
  userId: text('user_id').notNull(),
  title: text().notNull(),
  spec: jsonb('spec'),
  status: text('status').notNull().default('draft'),
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
  schema: { buildThreads, sessionEntries, pages },
});

export type BuildThread = typeof buildThreads.$inferSelect;
export type PageRow = typeof pages.$inferSelect;
