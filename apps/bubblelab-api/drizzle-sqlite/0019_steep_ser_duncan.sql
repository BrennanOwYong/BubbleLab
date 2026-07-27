CREATE TABLE `user_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`recipient_email` text,
	`telegram_chat_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`clerk_id`) ON UPDATE no action ON DELETE cascade
);
