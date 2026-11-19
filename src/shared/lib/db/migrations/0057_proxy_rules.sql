CREATE TABLE `proxy_rule_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`effect` text NOT NULL,
	`description` text NOT NULL,
	`restatement` text NOT NULL,
	`patterns` text NOT NULL,
	`code` text NOT NULL,
	`tests` text NOT NULL,
	`warnings` text NOT NULL,
	`tool_schema_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `proxy_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_rule_versions_unique` ON `proxy_rule_versions` (`rule_id`,`version`);--> statement-breakpoint
CREATE TABLE `proxy_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`account_id` text,
	`mcp_id` text,
	`agent_slug` text,
	`created_by` text NOT NULL,
	`created_by_agent_slug` text,
	`current_version_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `connected_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mcp_id`) REFERENCES `remote_mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "proxy_rules_target_check" CHECK(("proxy_rules"."kind" = 'api' and "proxy_rules"."account_id" is not null and "proxy_rules"."mcp_id" is null) or ("proxy_rules"."kind" = 'mcp' and "proxy_rules"."mcp_id" is not null and "proxy_rules"."account_id" is null))
);
--> statement-breakpoint
CREATE INDEX `proxy_rules_account_idx` ON `proxy_rules` (`account_id`);--> statement-breakpoint
CREATE INDEX `proxy_rules_mcp_idx` ON `proxy_rules` (`mcp_id`);--> statement-breakpoint
ALTER TABLE `mcp_audit_log` ADD `rule_version_id` text;--> statement-breakpoint
ALTER TABLE `mcp_audit_log` ADD `rule_outcomes` text;--> statement-breakpoint
ALTER TABLE `proxy_audit_log` ADD `rule_version_id` text;--> statement-breakpoint
ALTER TABLE `proxy_audit_log` ADD `rule_outcomes` text;