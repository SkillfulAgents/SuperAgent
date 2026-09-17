CREATE TABLE `linear_issue_sync` (
	`integration_id` text NOT NULL,
	`task_id` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`synced_through` text NOT NULL,
	`next_poll_at` integer NOT NULL,
	`inaccessible_since` text,
	PRIMARY KEY(`integration_id`, `task_id`),
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `linear_issue_sync_due_idx` ON `linear_issue_sync` (`integration_id`,`next_poll_at`);