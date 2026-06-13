CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`user_id` text,
	`object` text NOT NULL,
	`object_id` text NOT NULL,
	`action` text NOT NULL,
	`details` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_created_at_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_object_idx` ON `audit_log` (`object`);--> statement-breakpoint
CREATE INDEX `audit_log_user_id_idx` ON `audit_log` (`user_id`);