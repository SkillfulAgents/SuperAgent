CREATE TABLE `todos` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`agent_slug` text,
	`session_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	CONSTRAINT "todos_session_check" CHECK("todos"."session_id" is null or ("todos"."agent_slug" is not null and "todos"."status" <> 'draft'))
);
--> statement-breakpoint
CREATE INDEX `todos_user_idx` ON `todos` (`user_id`);--> statement-breakpoint
CREATE INDEX `todos_agent_session_idx` ON `todos` (`agent_slug`,`session_id`);