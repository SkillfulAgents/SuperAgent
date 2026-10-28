PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_notifications`("id", "type", "session_id", "agent_slug", "title", "body", "is_read", "created_at", "read_at") SELECT "id", "type", "session_id", "agent_slug", "title", "body", "is_read", "created_at", "read_at" FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `notifications_agent_slug_is_read_idx` ON `notifications` (`agent_slug`,`is_read`);--> statement-breakpoint
CREATE INDEX `notifications_session_id_idx` ON `notifications` (`session_id`);--> statement-breakpoint
CREATE INDEX `notifications_created_at_idx` ON `notifications` (`created_at`);