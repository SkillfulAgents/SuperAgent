CREATE TABLE `chat_integration_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`external_chat_id` text NOT NULL,
	`session_id` text NOT NULL,
	`display_name` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_integration_sessions_integration_id_idx` ON `chat_integration_sessions` (`integration_id`);--> statement-breakpoint
CREATE TABLE `chat_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`provider` text NOT NULL,
	`name` text,
	`config` text NOT NULL,
	`show_tool_calls` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`error_message` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_integrations_agent_slug_idx` ON `chat_integrations` (`agent_slug`);--> statement-breakpoint
CREATE INDEX `chat_integrations_status_idx` ON `chat_integrations` (`status`);