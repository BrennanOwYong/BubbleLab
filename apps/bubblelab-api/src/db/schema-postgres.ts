import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  unique,
  uniqueIndex,
  jsonb,
  bigserial,
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { relations, isNotNull } from 'drizzle-orm';
import type { CredentialMetadata } from '@bubblelab/shared-schemas';

export const users = pgTable('users', {
  clerkId: text('clerk_id').primaryKey(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email').notNull(),
  appType: text('app_type').notNull().default('nodex'), // Track which app the user belongs to
  monthlyUsageCount: integer('monthly_usage_count').notNull().default(0),
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bubbleFlows = pgTable('bubble_flows', {
  id: serial().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.clerkId, { onDelete: 'cascade' }),
  name: text().notNull(),
  description: text(),
  prompt: text(), // Store the original prompt used to generate the flow (nullable)
  code: text(), // This will store the processed/transpiled code (nullable for empty flows during generation)
  originalCode: text('original_code'), // Store the original TypeScript code
  generationError: text('generation_error'), // Store any code generation errors
  bubbleParameters: jsonb('bubble_parameters'), // Store parsed bubble parameters as JSONB
  metadata: jsonb('metadata'), // Store workflow metadata (outputDescription, etc.) as JSONB
  workflow: jsonb('workflow'), // Store parsed workflow structure as JSONB
  eventType: text('event_type').notNull(),
  inputSchema: jsonb('input_schema'), // Store input schema
  webhookExecutionCount: integer('webhook_execution_count')
    .notNull()
    .default(0), // Track webhook executions
  webhookFailureCount: integer('webhook_failure_count').notNull().default(0), // Track webhook failures
  cron: text('cron'), // Cron expression extracted from code
  cronActive: boolean('cron_active').notNull().default(false), // Whether cron scheduling is active
  defaultInputs: jsonb('default_inputs'), // User-filled input values for cron execution
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const webhooks = pgTable(
  'webhooks',
  {
    id: serial().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.clerkId, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    bubbleFlowId: integer('bubble_flow_id')
      .notNull()
      .references(() => bubbleFlows.id, { onDelete: 'cascade' }),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique combination of userId and path
    userPathUnique: unique().on(table.userId, table.path),
  })
);

export const bubbleFlowExecutions = pgTable('bubble_flow_executions', {
  id: serial().primaryKey(),
  bubbleFlowId: integer('bubble_flow_id')
    .notNull()
    .references(() => bubbleFlows.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').notNull(), // JSON stored as JSONB
  result: jsonb('result'), // JSON stored as JSONB
  status: text('status').notNull(),
  error: text('error'),
  code: text('code'), // Store the original code at execution time
  executionLogs: jsonb('execution_logs'), // StreamingLogEvent[] from execution
  startedAt: timestamp('started_at', { mode: 'date' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { mode: 'date' }),
});

export const bubbleFlowEvaluations = pgTable('bubble_flow_evaluations', {
  id: serial().primaryKey(),
  executionId: integer('execution_id')
    .notNull()
    .references(() => bubbleFlowExecutions.id, { onDelete: 'cascade' }),
  bubbleFlowId: integer('bubble_flow_id')
    .notNull()
    .references(() => bubbleFlows.id, { onDelete: 'cascade' }),
  // Evaluation result from Rice agent
  working: boolean('working').notNull(), // Whether the workflow is functioning correctly
  issueType: text('issue_type'), // 'setup' | 'workflow' | 'input' | null
  summary: text('summary').notNull(), // Brief summary of execution or issue description
  rating: integer('rating').notNull(), // Quality rating 1-10
  // Metadata
  modelUsed: text('model_used').notNull(), // Model used for evaluation (e.g., RECOMMENDED_MODELS.FAST)
  evaluatedAt: timestamp('evaluated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const userCredentials = pgTable('user_credentials', {
  id: serial().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.clerkId, { onDelete: 'cascade' }),
  credentialType: text('credential_type').notNull(), // e.g., 'OPENAI_CRED', 'SLACK_CRED'
  encryptedValue: text('encrypted_value'), // Encrypted credential value (nullable for OAuth)
  name: text('name'), // Optional user-friendly name for the credential
  metadata: jsonb('metadata').$type<CredentialMetadata>(), // Typed JSONB field for credential metadata (DatabaseMetadata or JiraOAuthMetadata)

  // OAuth-specific fields
  oauthAccessToken: text('oauth_access_token'), // Encrypted OAuth access token
  oauthRefreshToken: text('oauth_refresh_token'), // Encrypted OAuth refresh token
  oauthExpiresAt: timestamp('oauth_expires_at', { mode: 'date' }), // Token expiration
  oauthScopes: jsonb('oauth_scopes').$type<string[]>(), // OAuth scopes granted
  oauthTokenType: text('oauth_token_type').default('Bearer'), // Token type (usually Bearer)
  oauthProvider: text('oauth_provider'), // Provider name (google, slack, github, etc.)
  isOauth: boolean('is_oauth').default(false), // Flag to identify OAuth vs API key credentials

  // BrowserBase session credential fields
  isBrowserSession: boolean('is_browser_session').default(false), // Flag for browser session credentials
  browserbaseContextId: text('browserbase_context_id'), // Context ID for session persistence
  browserbaseCookies: text('browserbase_cookies'), // Encrypted JSON cookies array
  browserbaseSessionData: jsonb('browserbase_session_data').$type<{
    capturedAt: string;
    cookieCount: number;
    domain: string;
  }>(), // Session metadata

  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Persisted derived-credential relationship: parent credential's GRANTED scopes
// cover a sibling type of the same OAuth provider group (e.g. a
// GOOGLE_DRIVE_CRED whose grant includes spreadsheets serves
// GOOGLE_SHEETS_CRED). One row per (parent, derived type); recomputed from the
// parent's oauth_scopes on connect / scope-sync / re-consent so the records
// stay in lockstep with the real grant (a revoked scope drops the row).
export const derivedCredentials = pgTable(
  'derived_credentials',
  {
    id: serial().primaryKey(),
    parentCredentialId: integer('parent_credential_id')
      .notNull()
      .references(() => userCredentials.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.clerkId, { onDelete: 'cascade' }),
    derivedCredentialType: text('derived_credential_type').notNull(), // e.g. 'GOOGLE_SHEETS_CRED'
    provider: text('provider').notNull(), // OAuth provider shared by parent and derived type (e.g. 'google')
    isDerived: boolean('is_derived').notNull().default(true), // capability derived from the parent grant, never a standalone connection
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    parentDerivedTypeUnique: unique().on(
      table.parentCredentialId,
      table.derivedCredentialType
    ),
  })
);

export const userServiceUsage = pgTable(
  'user_service_usage',
  {
    id: serial().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.clerkId, { onDelete: 'cascade' }),
    service: text('service').notNull(), // CredentialType enum value (e.g., 'OPENAI_CRED', 'FIRECRAWL_API_KEY')
    subService: text('sub_service'), // Optional: e.g., 'gpt-4', 'gemini-2.0-flash', 'apify/instagram-scraper'
    monthYear: text('month_year').notNull(), // e.g., '2025-01'
    unit: text('unit').notNull(), // e.g., 'per_1m_tokens', 'per_email', 'per_result'
    usage: doublePrecision('usage').notNull().default(0), // Usage count in the specified unit (high precision float)
    unitCost: doublePrecision('unit_cost').notNull(), // Cost per unit in dollars (high precision float)
    totalCost: doublePrecision('total_cost').notNull().default(0), // Calculated: usage * unitCost (high precision float)
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    // Unique constraint: one record per user, service, subService, and unit
    userServiceUnitUnique: unique().on(
      table.userId,
      table.service,
      table.subService,
      table.unit,
      table.unitCost,
      table.monthYear
    ),
  })
);

export const waitlistedUsers = pgTable('waitlisted_users', {
  email: text('email').primaryKey(),
  name: text('name').notNull(),
  database: text('database').notNull(), // e.g., 'postgres', 'mysql', 'mongodb', etc.
  otherDatabase: text('other_database'), // For when database is 'other'
  status: text('status').notNull().default('pending'), // 'pending', 'approved', 'rejected', 'converted'
  notes: text('notes'), // Admin notes about the user
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Per-user profile: "for me" defaults the flow creator wants auto-filled into
// flow inputs (their OWN recipient email, their OWN Telegram chat id). Stored
// OUTSIDE credentials: these are personal facts, not secrets, and they apply
// across every flow the user creates. One row per user; add future profile
// fields as new nullable columns here.
export const userProfiles = pgTable('user_profiles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.clerkId, { onDelete: 'cascade' }),
  recipientEmail: text('recipient_email'), // where "send it to me" emails go
  telegramChatId: text('telegram_chat_id'), // the user's own Telegram chat id
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bubbleFlowsRelations = relations(bubbleFlows, ({ many }) => ({
  executions: many(bubbleFlowExecutions),
  webhooks: many(webhooks),
  evaluations: many(bubbleFlowEvaluations),
}));

export const webhooksRelations = relations(webhooks, ({ one }) => ({
  bubbleFlow: one(bubbleFlows, {
    fields: [webhooks.bubbleFlowId],
    references: [bubbleFlows.id],
  }),
}));

export const bubbleFlowExecutionsRelations = relations(
  bubbleFlowExecutions,
  ({ one, many }) => ({
    bubbleFlow: one(bubbleFlows, {
      fields: [bubbleFlowExecutions.bubbleFlowId],
      references: [bubbleFlows.id],
    }),
    evaluations: many(bubbleFlowEvaluations),
  })
);

export const bubbleFlowEvaluationsRelations = relations(
  bubbleFlowEvaluations,
  ({ one }) => ({
    execution: one(bubbleFlowExecutions, {
      fields: [bubbleFlowEvaluations.executionId],
      references: [bubbleFlowExecutions.id],
    }),
    bubbleFlow: one(bubbleFlows, {
      fields: [bubbleFlowEvaluations.bubbleFlowId],
      references: [bubbleFlows.id],
    }),
  })
);

// No relations needed for userCredentials as it's a standalone table

// Phase-4 builder-agent harness: one build thread per flow. Holds the Claude
// Agent SDK session id driving the flow's build conversation, its status
// (building / ready / error / blocked_on_credential), and — when a required
// credential is missing — the deferred setup script persisted by the
// credential-gap rule. Written by services/builder-agent (which re-declares
// this shape; keep the two in sync) and read by the API's build proxy.
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

// Verbatim Claude Agent SDK transcript entries (SessionStore adapter target;
// one row per JSONL line). Entries carrying a uuid are deduped by the partial
// unique index, matching the SDK contract that uuid is an idempotency key.
export const sessionEntries = pgTable(
  'session_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectKey: text('project_key').notNull(),
    sessionId: text('session_id').notNull(),
    subpath: text('subpath').notNull().default(''),
    entryUuid: text('entry_uuid'),
    entry: jsonb('entry').notNull(),
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
