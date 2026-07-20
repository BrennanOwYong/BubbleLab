CREATE TABLE `workflow_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` integer NOT NULL,
	`bubble_flow_id` integer NOT NULL,
	`type` text NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`step_id` text,
	`variable_id` integer,
	`bubble_name` text,
	`message` text NOT NULL,
	`error_class` text,
	`payload` text,
	`timestamp` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `bubble_flow_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bubble_flow_id`) REFERENCES `bubble_flows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `bubble_flows` ADD `event_policy` text;