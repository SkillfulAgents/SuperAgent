CREATE TABLE `llm_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`managed` integer DEFAULT false NOT NULL,
	`config` text NOT NULL,
	`model_overrides` text DEFAULT '[]' NOT NULL,
	`browser_model` text,
	`dashboard_model` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `llm_connections_owner_idx` ON `llm_connections` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `llm_connections_platform_unique` ON `llm_connections` (`provider`) WHERE provider = 'platform';--> statement-breakpoint
ALTER TABLE `chat_integrations` ADD `connection_id` text REFERENCES llm_connections(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `connection_id` text REFERENCES llm_connections(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `webhook_triggers` ADD `connection_id` text REFERENCES llm_connections(id) ON DELETE SET NULL;