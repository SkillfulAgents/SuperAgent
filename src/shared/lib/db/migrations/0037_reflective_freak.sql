PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`schedule_type` text NOT NULL,
	`schedule_expression` text NOT NULL,
	`prompt` text NOT NULL,
	`name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`next_execution_at` integer,
	`last_executed_at` integer,
	`is_recurring` integer DEFAULT false NOT NULL,
	`execution_count` integer DEFAULT 0 NOT NULL,
	`last_session_id` text,
	`created_by_session_id` text,
	`created_by_user_id` text,
	`resume_session_id` text,
	`wake_on_sessions` text,
	`timezone` text,
	`model` text,
	`effort` text,
	`speed` text,
	`created_at` integer NOT NULL,
	`cancelled_at` integer,
	`paused_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_scheduled_tasks`("id", "agent_slug", "schedule_type", "schedule_expression", "prompt", "name", "status", "next_execution_at", "last_executed_at", "is_recurring", "execution_count", "last_session_id", "created_by_session_id", "created_by_user_id", "resume_session_id", "wake_on_sessions", "timezone", "model", "effort", "speed", "created_at", "cancelled_at", "paused_at") SELECT "id", "agent_slug", "schedule_type", "schedule_expression", "prompt", "name", "status", "next_execution_at", "last_executed_at", "is_recurring", "execution_count", "last_session_id", "created_by_session_id", "created_by_user_id", "resume_session_id", NULL, "timezone", "model", "effort", "speed", "created_at", "cancelled_at", "paused_at" FROM `scheduled_tasks`;--> statement-breakpoint
DROP TABLE `scheduled_tasks`;--> statement-breakpoint
ALTER TABLE `__new_scheduled_tasks` RENAME TO `scheduled_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_tasks_pending_wake_unique` ON `scheduled_tasks` (`resume_session_id`) WHERE status = 'pending' AND resume_session_id IS NOT NULL;