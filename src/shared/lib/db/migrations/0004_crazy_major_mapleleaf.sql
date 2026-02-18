CREATE TABLE `agent_remote_mcps` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`remote_mcp_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`remote_mcp_id`) REFERENCES `remote_mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`remote_mcp_id` text NOT NULL,
	`remote_mcp_name` text NOT NULL,
	`method` text NOT NULL,
	`request_path` text NOT NULL,
	`status_code` integer,
	`error_message` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `remote_mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`token_expires_at` integer,
	`oauth_token_endpoint` text,
	`oauth_client_id` text,
	`oauth_client_secret` text,
	`oauth_resource` text,
	`tools_json` text,
	`tools_discovered_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_remote_mcps_unique` ON `agent_remote_mcps` (`agent_slug`,`remote_mcp_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_mcp_servers_url_unique` ON `remote_mcp_servers` (`url`);