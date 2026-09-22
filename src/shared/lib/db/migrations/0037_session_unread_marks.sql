CREATE TABLE `session_unread_marks` (
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`marked_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `session_unread_marks_agent_slug_user_idx` ON `session_unread_marks` (`agent_slug`,`user_id`);
