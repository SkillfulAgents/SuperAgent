PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_todos` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`agent_slug` text,
	`new_agent` integer DEFAULT false NOT NULL,
	`llm_provider_id` text,
	`model` text,
	`effort` text,
	`speed` text,
	`session_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`position` real NOT NULL,
	`start_claim` text,
	`start_claimed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`llm_provider_id`) REFERENCES `llm_connections`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "todos_session_check" CHECK("__new_todos"."session_id" is null or ("__new_todos"."agent_slug" is not null and "__new_todos"."status" <> 'draft'))
);
--> statement-breakpoint
INSERT INTO `__new_todos`("id", "user_id", "title", "description", "agent_slug", "new_agent", "llm_provider_id", "model", "effort", "speed", "session_id", "status", "position", "start_claim", "start_claimed_at", "created_at", "updated_at", "started_at", "completed_at") SELECT "id", "user_id", "title", "description", "agent_slug", "new_agent", CASE WHEN "llm_provider_id" IN (SELECT "id" FROM `llm_connections`) THEN "llm_provider_id" END, "model", "effort", "speed", "session_id", "status", "position", "start_claim", "start_claimed_at", "created_at", "updated_at", "started_at", "completed_at" FROM `todos`;--> statement-breakpoint
DROP TABLE `todos`;--> statement-breakpoint
ALTER TABLE `__new_todos` RENAME TO `todos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `todos_user_idx` ON `todos` (`user_id`);--> statement-breakpoint
CREATE INDEX `todos_agent_session_idx` ON `todos` (`agent_slug`,`session_id`);