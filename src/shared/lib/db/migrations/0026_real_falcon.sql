PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_webhook_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`kind` text DEFAULT 'composio' NOT NULL,
	`composio_trigger_id` text,
	`connected_account_id` text,
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
	`model` text,
	`effort` text,
	`created_at` integer NOT NULL,
	`cancelled_at` integer,
	`paused_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_webhook_triggers`("id", "agent_slug", "kind", "composio_trigger_id", "connected_account_id", "trigger_type", "trigger_config", "prompt", "name", "status", "last_fired_at", "fire_count", "last_session_id", "created_by_session_id", "created_by_user_id", "model", "effort", "created_at", "cancelled_at", "paused_at") SELECT "id", "agent_slug", 'composio', "composio_trigger_id", "connected_account_id", "trigger_type", "trigger_config", "prompt", "name", "status", "last_fired_at", "fire_count", "last_session_id", "created_by_session_id", "created_by_user_id", "model", "effort", "created_at", "cancelled_at", "paused_at" FROM `webhook_triggers`;--> statement-breakpoint
DROP TABLE `webhook_triggers`;--> statement-breakpoint
ALTER TABLE `__new_webhook_triggers` RENAME TO `webhook_triggers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `webhook_triggers_agent_slug_idx` ON `webhook_triggers` (`agent_slug`);--> statement-breakpoint
CREATE INDEX `webhook_triggers_status_idx` ON `webhook_triggers` (`status`);--> statement-breakpoint
CREATE INDEX `webhook_triggers_composio_idx` ON `webhook_triggers` (`composio_trigger_id`);