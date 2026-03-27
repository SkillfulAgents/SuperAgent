CREATE TABLE `api_scope_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`scope` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `connected_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_scope_policies_unique` ON `api_scope_policies` (`account_id`,`scope`);--> statement-breakpoint
CREATE TABLE `mcp_tool_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`mcp_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mcp_id`) REFERENCES `remote_mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tool_policies_unique` ON `mcp_tool_policies` (`mcp_id`,`tool_name`);--> statement-breakpoint
ALTER TABLE `mcp_audit_log` ADD `policy_decision` text;--> statement-breakpoint
ALTER TABLE `mcp_audit_log` ADD `matched_tool` text;--> statement-breakpoint
ALTER TABLE `proxy_audit_log` ADD `policy_decision` text;--> statement-breakpoint
ALTER TABLE `proxy_audit_log` ADD `matched_scopes` text;