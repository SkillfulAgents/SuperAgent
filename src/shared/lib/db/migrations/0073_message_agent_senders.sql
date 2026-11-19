PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_message_author` (
	`id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`user_id` text,
	`integration_id` text,
	`display` text,
	`author_agent_slug` text,
	`billed_user_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`agent_slug`, `session_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`billed_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "message_author_author_check" CHECK(
    ("__new_message_author"."user_id" is not null) + ("__new_message_author"."integration_id" is not null) + ("__new_message_author"."author_agent_slug" is not null) = 1
    and ("__new_message_author"."integration_id" is null) = ("__new_message_author"."display" is null)
    and ("__new_message_author"."billed_user_id" is null or "__new_message_author"."author_agent_slug" is not null))
);
--> statement-breakpoint
-- Main has person and integration rows. The previous PR build also recorded
-- the calling agent alongside its payer in user_id. The trailing NULL supplies
-- the missing column on main; an existing column from * takes precedence.
INSERT INTO `__new_message_author` (id, session_id, agent_slug, user_id, integration_id, display, author_agent_slug, billed_user_id, created_at)
SELECT id, session_id, agent_slug, CASE WHEN author_agent_slug IS NULL THEN user_id END, integration_id, display,
       author_agent_slug, CASE WHEN author_agent_slug IS NOT NULL THEN user_id END, created_at
FROM (SELECT *, NULL AS author_agent_slug FROM `message_author`);
--> statement-breakpoint
DROP TABLE `message_author`;--> statement-breakpoint
ALTER TABLE `__new_message_author` RENAME TO `message_author`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `message_author_session_idx` ON `message_author` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_author_integration_delivery_idx` ON `message_author` (`id`) WHERE "message_author"."integration_id" is not null;
