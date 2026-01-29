CREATE TABLE `proxy_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`account_id` text NOT NULL,
	`toolkit` text NOT NULL,
	`target_host` text NOT NULL,
	`target_path` text NOT NULL,
	`method` text NOT NULL,
	`status_code` integer,
	`error_message` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proxy_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_tokens_agent_slug_unique` ON `proxy_tokens` (`agent_slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_tokens_token_unique` ON `proxy_tokens` (`token`);