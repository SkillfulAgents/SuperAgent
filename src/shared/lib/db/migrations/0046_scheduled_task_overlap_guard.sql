ALTER TABLE `scheduled_tasks` ADD `consecutive_skips` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `last_skipped_at` integer;