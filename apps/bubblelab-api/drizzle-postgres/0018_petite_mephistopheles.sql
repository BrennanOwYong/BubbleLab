CREATE TABLE "workflow_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"execution_id" integer NOT NULL,
	"bubble_flow_id" integer NOT NULL,
	"type" text NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"step_id" text,
	"variable_id" integer,
	"bubble_name" text,
	"message" text NOT NULL,
	"error_class" text,
	"payload" jsonb,
	"timestamp" timestamp NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bubble_flows" ADD COLUMN "event_policy" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_execution_id_bubble_flow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."bubble_flow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_bubble_flow_id_bubble_flows_id_fk" FOREIGN KEY ("bubble_flow_id") REFERENCES "public"."bubble_flows"("id") ON DELETE cascade ON UPDATE no action;