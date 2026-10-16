ALTER TABLE `proxy_audit_log` ADD `tool_use_id` text;--> statement-breakpoint
CREATE INDEX `proxy_audit_log_tool_use_id_idx` ON `proxy_audit_log` (`tool_use_id`);