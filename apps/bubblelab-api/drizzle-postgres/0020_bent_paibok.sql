CREATE TABLE "build_threads" (
	"flow_id" integer PRIMARY KEY NOT NULL,
	"session_id" text,
	"agent_kind" text DEFAULT 'flow' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"deferred_setup" jsonb,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_key" text NOT NULL,
	"session_id" text NOT NULL,
	"subpath" text DEFAULT '' NOT NULL,
	"entry_uuid" text,
	"entry" jsonb NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_entries_uuid_unique" ON "session_entries" USING btree ("project_key","session_id","subpath","entry_uuid") WHERE "session_entries"."entry_uuid" is not null;