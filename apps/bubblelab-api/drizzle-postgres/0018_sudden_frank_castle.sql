CREATE TABLE "contract_kb_documents" (
	"integration" text PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"integration" text NOT NULL,
	"node_key" text NOT NULL,
	"operation" text,
	"source" text NOT NULL,
	"grounded" boolean NOT NULL,
	"accepted" boolean NOT NULL,
	"action" text,
	"error_code" text,
	"drift_findings" jsonb,
	"sample" jsonb,
	"bubble_flow_id" integer,
	"execution_id" integer,
	"observed_at" text NOT NULL,
	"created_at" timestamp NOT NULL
);
