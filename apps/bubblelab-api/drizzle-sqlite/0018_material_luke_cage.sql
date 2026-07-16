CREATE TABLE `contract_kb_documents` (
	`integration` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contract_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`integration` text NOT NULL,
	`node_key` text NOT NULL,
	`operation` text,
	`source` text NOT NULL,
	`grounded` integer NOT NULL,
	`accepted` integer NOT NULL,
	`action` text,
	`error_code` text,
	`drift_findings` text,
	`sample` text,
	`bubble_flow_id` integer,
	`execution_id` integer,
	`observed_at` text NOT NULL,
	`created_at` integer NOT NULL
);
