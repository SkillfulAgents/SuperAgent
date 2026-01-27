CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`schedule_type` text NOT NULL,
	`schedule_expression` text NOT NULL,
	`prompt` text NOT NULL,
	`name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`next_execution_at` integer NOT NULL,
	`last_executed_at` integer,
	`is_recurring` integer DEFAULT false NOT NULL,
	`execution_count` integer DEFAULT 0 NOT NULL,
	`last_session_id` text,
	`created_by_session_id` text,
	`created_at` integer NOT NULL,
	`cancelled_at` integer
);
