CREATE TABLE `session_thread_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`session_id` text NOT NULL,
	`parent_message_uuid` text NOT NULL,
	`user_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_thread_replies_thread_idx` ON `session_thread_replies` (`agent_slug`,`session_id`,`parent_message_uuid`,`created_at`);--> statement-breakpoint
CREATE TABLE `session_threads` (
	`agent_slug` text NOT NULL,
	`session_id` text NOT NULL,
	`parent_message_uuid` text NOT NULL,
	`tagged_user_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_slug`, `session_id`, `parent_message_uuid`)
);
