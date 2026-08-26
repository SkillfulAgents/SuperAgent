CREATE TABLE `session_unread_marks` (
	`session_id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`marked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_unread_marks_agent_slug_idx` ON `session_unread_marks` (`agent_slug`);
