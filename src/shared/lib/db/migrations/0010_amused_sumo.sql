CREATE TABLE `stt_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`cost_micro` integer NOT NULL,
	`agent_slug` text,
	`user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `stt_usage_created_at_idx` ON `stt_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `stt_usage_user_id_idx` ON `stt_usage` (`user_id`);--> statement-breakpoint
CREATE INDEX `stt_usage_agent_slug_idx` ON `stt_usage` (`agent_slug`);