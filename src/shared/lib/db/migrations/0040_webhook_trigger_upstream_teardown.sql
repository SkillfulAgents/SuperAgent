ALTER TABLE `webhook_triggers` ADD `upstream_deleted_at` integer;--> statement-breakpoint
ALTER TABLE `webhook_triggers` ADD `upstream_teardown_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `webhook_triggers` SET `upstream_deleted_at` = COALESCE(`cancelled_at`, `created_at`) WHERE `status` IN ('cancelled', 'failed') AND `composio_trigger_id` IS NOT NULL AND `upstream_deleted_at` IS NULL;
