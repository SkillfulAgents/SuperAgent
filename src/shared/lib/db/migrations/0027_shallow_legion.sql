CREATE INDEX `mcp_audit_log_agent_slug_created_at_idx` ON `mcp_audit_log` (`agent_slug`,`created_at`);--> statement-breakpoint
CREATE INDEX `mcp_audit_log_remote_mcp_id_created_at_idx` ON `mcp_audit_log` (`remote_mcp_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `proxy_audit_log_agent_slug_created_at_idx` ON `proxy_audit_log` (`agent_slug`,`created_at`);--> statement-breakpoint
CREATE INDEX `proxy_audit_log_account_id_created_at_idx` ON `proxy_audit_log` (`account_id`,`created_at`);