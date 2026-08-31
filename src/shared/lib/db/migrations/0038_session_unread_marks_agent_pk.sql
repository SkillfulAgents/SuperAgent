-- Session ids are unique only WITHIN an agent (import/clone gives two agents
-- the same id), so the mark's identity is (agent, session, user), not
-- (session, user). Under the old PK a second agent's mark for a shared id was
-- swallowed by the INSERT ... ON CONFLICT DO NOTHING, and a clear/delete on the
-- bare id crossed agents. SQLite cannot alter a primary key in place, so
-- rebuild the table. agent_slug is already NOT NULL, so every existing row
-- carries into the wider key unchanged.
CREATE TABLE `session_unread_marks_new` (
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`marked_at` integer NOT NULL,
	PRIMARY KEY(`agent_slug`, `session_id`, `user_id`)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `session_unread_marks_new` (`session_id`, `user_id`, `agent_slug`, `marked_at`)
	SELECT `session_id`, `user_id`, `agent_slug`, `marked_at` FROM `session_unread_marks`;
--> statement-breakpoint
DROP TABLE `session_unread_marks`;
--> statement-breakpoint
ALTER TABLE `session_unread_marks_new` RENAME TO `session_unread_marks`;
--> statement-breakpoint
CREATE INDEX `session_unread_marks_agent_slug_user_idx` ON `session_unread_marks` (`agent_slug`,`user_id`);
