-- Convert existing timestamp columns from seconds to milliseconds
-- The WHERE clause prevents double-conversion (values already in ms are > 10 billion)
UPDATE "connected_accounts" SET "created_at" = "created_at" * 1000 WHERE "created_at" IS NOT NULL AND "created_at" < 10000000000;--> statement-breakpoint
UPDATE "connected_accounts" SET "updated_at" = "updated_at" * 1000 WHERE "updated_at" IS NOT NULL AND "updated_at" < 10000000000;--> statement-breakpoint
UPDATE "scheduled_tasks" SET "created_at" = "created_at" * 1000 WHERE "created_at" IS NOT NULL AND "created_at" < 10000000000;--> statement-breakpoint
UPDATE "scheduled_tasks" SET "next_execution_at" = "next_execution_at" * 1000 WHERE "next_execution_at" IS NOT NULL AND "next_execution_at" < 10000000000;--> statement-breakpoint
UPDATE "scheduled_tasks" SET "last_executed_at" = "last_executed_at" * 1000 WHERE "last_executed_at" IS NOT NULL AND "last_executed_at" < 10000000000;--> statement-breakpoint
UPDATE "scheduled_tasks" SET "cancelled_at" = "cancelled_at" * 1000 WHERE "cancelled_at" IS NOT NULL AND "cancelled_at" < 10000000000;--> statement-breakpoint
UPDATE "notifications" SET "created_at" = "created_at" * 1000 WHERE "created_at" IS NOT NULL AND "created_at" < 10000000000;--> statement-breakpoint
UPDATE "remote_mcp_servers" SET "created_at" = "created_at" * 1000 WHERE "created_at" IS NOT NULL AND "created_at" < 10000000000;--> statement-breakpoint
UPDATE "remote_mcp_servers" SET "updated_at" = "updated_at" * 1000 WHERE "updated_at" IS NOT NULL AND "updated_at" < 10000000000;--> statement-breakpoint
UPDATE "remote_mcp_servers" SET "tools_discovered_at" = "tools_discovered_at" * 1000 WHERE "tools_discovered_at" IS NOT NULL AND "tools_discovered_at" < 10000000000;--> statement-breakpoint
UPDATE "remote_mcp_servers" SET "token_expires_at" = "token_expires_at" * 1000 WHERE "token_expires_at" IS NOT NULL AND "token_expires_at" < 10000000000;--> statement-breakpoint
UPDATE "agent_connected_accounts" SET "created_at" = "created_at" * 1000 WHERE "created_at" IS NOT NULL AND "created_at" < 10000000000;--> statement-breakpoint
UPDATE "agent_remote_mcps" SET "created_at" = "created_at" * 1000 WHERE "created_at" IS NOT NULL AND "created_at" < 10000000000;--> statement-breakpoint
UPDATE "agent_acl" SET "created_at" = "created_at" * 1000 WHERE "created_at" IS NOT NULL AND "created_at" < 10000000000;--> statement-breakpoint
UPDATE "notifications" SET "read_at" = "read_at" * 1000 WHERE "read_at" IS NOT NULL AND "read_at" < 10000000000;--> statement-breakpoint
UPDATE "proxy_tokens" SET "created_at" = "created_at" * 1000 WHERE "created_at" IS NOT NULL AND "created_at" < 10000000000;--> statement-breakpoint
UPDATE "proxy_audit_log" SET "created_at" = "created_at" * 1000 WHERE "created_at" IS NOT NULL AND "created_at" < 10000000000;--> statement-breakpoint
UPDATE "mcp_audit_log" SET "created_at" = "created_at" * 1000 WHERE "created_at" IS NOT NULL AND "created_at" < 10000000000;--> statement-breakpoint
UPDATE "user_settings" SET "updated_at" = "updated_at" * 1000 WHERE "updated_at" IS NOT NULL AND "updated_at" < 10000000000;--> statement-breakpoint
CREATE INDEX `connected_accounts_userId_idx` ON `connected_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `notifications_agent_slug_is_read_idx` ON `notifications` (`agent_slug`,`is_read`);--> statement-breakpoint
CREATE INDEX `notifications_session_id_idx` ON `notifications` (`session_id`);--> statement-breakpoint
CREATE INDEX `notifications_created_at_idx` ON `notifications` (`created_at`);
