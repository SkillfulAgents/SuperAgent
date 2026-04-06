CREATE TABLE `webhook_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`composio_trigger_id` text,
	`connected_account_id` text NOT NULL,
	`trigger_type` text NOT NULL,
	`trigger_config` text,
	`prompt` text NOT NULL,
	`name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_fired_at` integer,
	`fire_count` integer DEFAULT 0 NOT NULL,
	`last_session_id` text,
	`created_by_session_id` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`cancelled_at` integer
);
--> statement-breakpoint
CREATE INDEX `webhook_triggers_agent_slug_idx` ON `webhook_triggers` (`agent_slug`);--> statement-breakpoint
CREATE INDEX `webhook_triggers_status_idx` ON `webhook_triggers` (`status`);--> statement-breakpoint
CREATE INDEX `webhook_triggers_composio_idx` ON `webhook_triggers` (`composio_trigger_id`);