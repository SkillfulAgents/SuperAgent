DROP INDEX `audit_log_object_idx`;--> statement-breakpoint
CREATE INDEX `audit_log_object_created_at_idx` ON `audit_log` (`object`,`created_at`);--> statement-breakpoint
DROP INDEX `chat_integration_sessions_integration_id_idx`;--> statement-breakpoint
CREATE INDEX `chat_integration_sessions_integration_chat_idx` ON `chat_integration_sessions` (`integration_id`,`external_chat_id`);--> statement-breakpoint
DROP INDEX `notifications_agent_slug_is_read_idx`;--> statement-breakpoint
CREATE INDEX `notifications_agent_read_type_idx` ON `notifications` (`agent_slug`,`is_read`,`type`,`recipient_user_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `notifications_agent_created_at_idx` ON `notifications` (`agent_slug`,`created_at`);--> statement-breakpoint
CREATE INDEX `scheduled_tasks_agent_slug_status_idx` ON `scheduled_tasks` (`agent_slug`,`status`);