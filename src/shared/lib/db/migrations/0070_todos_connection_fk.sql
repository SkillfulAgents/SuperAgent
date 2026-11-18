-- Generated, then one statement added by hand (the UPDATE below).
-- `todos.llm_provider_id` was a bare column: unlike scheduled_tasks,
-- webhook_triggers and chat_integrations it had no reference to
-- `llm_connections`, so deleting a connection left drafts pointing at it.
-- SQLite cannot add a FK with ALTER, so the table is rebuilt.
--
-- Migrations run in one transaction, where `PRAGMA foreign_keys=OFF` is a
-- no-op, so the copy into the new table is checked row by row. A todo that
-- already points at a deleted connection would fail it; those picks are
-- cleared first, which is what ON DELETE SET NULL would have done. Nothing
-- references `todos`, so dropping it cascades into nothing.
UPDATE `todos` SET `llm_provider_id` = NULL WHERE `llm_provider_id` IS NOT NULL AND `llm_provider_id` NOT IN (SELECT `id` FROM `llm_connections`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_todos` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`agent_slug` text,
	`new_agent` integer DEFAULT false NOT NULL,
	`model` text,
	`llm_provider_id` text,
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
	`attachments` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`llm_provider_id`) REFERENCES `llm_connections`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "todos_session_check" CHECK("__new_todos"."session_id" is null or ("__new_todos"."agent_slug" is not null and "__new_todos"."status" <> 'draft'))
);
--> statement-breakpoint
INSERT INTO `__new_todos`("id", "user_id", "title", "description", "agent_slug", "new_agent", "model", "llm_provider_id", "effort", "speed", "session_id", "status", "position", "start_claim", "start_claimed_at", "created_at", "updated_at", "started_at", "completed_at", "attachments") SELECT "id", "user_id", "title", "description", "agent_slug", "new_agent", "model", "llm_provider_id", "effort", "speed", "session_id", "status", "position", "start_claim", "start_claimed_at", "created_at", "updated_at", "started_at", "completed_at", "attachments" FROM `todos`;--> statement-breakpoint
DROP TABLE `todos`;--> statement-breakpoint
ALTER TABLE `__new_todos` RENAME TO `todos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `todos_user_idx` ON `todos` (`user_id`);--> statement-breakpoint
CREATE INDEX `todos_agent_session_idx` ON `todos` (`agent_slug`,`session_id`);