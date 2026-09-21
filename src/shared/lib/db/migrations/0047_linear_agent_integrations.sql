-- Consolidated before release. IF NOT EXISTS preserves earlier PR test installations.
CREATE TABLE IF NOT EXISTS `integration_task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`external_event_id` text NOT NULL,
	`task_id` text NOT NULL,
	`interaction_id` text NOT NULL,
	`event_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`session_id` text,
	`response_text` text,
	`publication_json` text,
	`published_id` text,
	`input_request_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `integration_task_events_delivery_unique` ON `integration_task_events` (`integration_id`,`external_event_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_task_events_work_idx` ON `integration_task_events` (`integration_id`,`task_id`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `linear_issue_sync` (
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
CREATE INDEX IF NOT EXISTS `linear_issue_sync_due_idx` ON `linear_issue_sync` (`integration_id`,`next_poll_at`);