-- A message's author is either a person in the app or an agent integration.
-- Integration rows carry no user, so user_id becomes nullable, and they hold
-- the card the app draws for the message (display, JSON). SQLite cannot drop
-- NOT NULL in place, so rebuild the table; every existing row is a user row
-- and carries over unchanged. Nothing references message_author.
CREATE TABLE `message_author_new` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`user_id` text,
	`integration_id` text,
	`display` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_author_author_check" CHECK(("user_id" is null) <> ("integration_id" is null) and ("integration_id" is null) = ("display" is null))
);
--> statement-breakpoint
INSERT INTO `message_author_new` (`id`, `session_id`, `agent_slug`, `user_id`, `created_at`)
	SELECT `id`, `session_id`, `agent_slug`, `user_id`, `created_at` FROM `message_author`;
--> statement-breakpoint
DROP TABLE `message_author`;
--> statement-breakpoint
ALTER TABLE `message_author_new` RENAME TO `message_author`;
--> statement-breakpoint
CREATE INDEX `message_author_session_idx` ON `message_author` (`session_id`);
