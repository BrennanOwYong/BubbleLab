CREATE TABLE `derived_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_credential_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`derived_credential_type` text NOT NULL,
	`provider` text NOT NULL,
	`is_derived` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_credential_id`) REFERENCES `user_credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`clerk_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `derived_credentials_parent_credential_id_derived_credential_type_unique` ON `derived_credentials` (`parent_credential_id`,`derived_credential_type`);