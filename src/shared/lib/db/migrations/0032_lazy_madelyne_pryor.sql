CREATE TABLE `classifier_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`scheduled_task_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`fire_at` integer NOT NULL,
	`status` text DEFAULT 'classifying' NOT NULL,
	`classify_session_id` text,
	`verdict` text,
	`reason` text,
	`escalate_session_id` text,
	`deadline_at` integer NOT NULL,
	`resolved_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `classifier_runs_task_fire_unique` ON `classifier_runs` (`scheduled_task_id`,`fire_at`);--> statement-breakpoint
CREATE INDEX `classifier_runs_status_idx` ON `classifier_runs` (`status`);--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `execution_mode` text DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `classifier_config` text;