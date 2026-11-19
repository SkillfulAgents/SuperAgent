CREATE TABLE `agent_browser_accounts` (
	`agent_slug` text NOT NULL,
	`account_id` text NOT NULL,
	`granted_by` text,
	`applied_session_version` integer,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	PRIMARY KEY(`agent_slug`, `account_id`),
	FOREIGN KEY (`agent_slug`) REFERENCES `agents`(`slug`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `browser_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_browser_accounts_account_idx` ON `agent_browser_accounts` (`account_id`);--> statement-breakpoint
CREATE TABLE `browser_account_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`browser_type` text NOT NULL,
	`bundle` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`captured_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `browser_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_account_sessions_account_type_unique` ON `browser_account_sessions` (`account_id`,`browser_type`);--> statement-breakpoint
CREATE TABLE `browser_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`site` text NOT NULL,
	`username` text NOT NULL,
	`username_key` text NOT NULL,
	`label` text,
	`origin` text NOT NULL,
	`via_account_id` text,
	`secrets` text,
	`parts` text DEFAULT '[]' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`rejected_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`via_account_id`) REFERENCES `browser_accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_accounts_owner_site_username_unique` ON `browser_accounts` (coalesce(`user_id`, ''),`site`,`username_key`);--> statement-breakpoint
CREATE INDEX `browser_accounts_user_site_idx` ON `browser_accounts` (`user_id`,`site`);--> statement-breakpoint
CREATE INDEX `browser_accounts_via_idx` ON `browser_accounts` (`via_account_id`);