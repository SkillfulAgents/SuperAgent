CREATE TABLE `integration_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`external_id` text NOT NULL,
	`event_id` text NOT NULL,
	`envelope` text,
	`session_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`owner` text,
	`next_attempt_at` integer NOT NULL,
	`notice_state` text DEFAULT 'none' NOT NULL,
	`notice_attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_deliveries_event_idx` ON `integration_deliveries` (`integration_id`,`external_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `integration_deliveries_due_idx` ON `integration_deliveries` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `integration_deliveries_notice_idx` ON `integration_deliveries` (`notice_state`,`next_attempt_at`);