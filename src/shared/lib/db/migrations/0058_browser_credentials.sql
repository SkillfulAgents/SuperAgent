CREATE TABLE `agent_browser_credentials` (
	`agent_slug` text NOT NULL,
	`credential_id` text NOT NULL,
	`site` text NOT NULL,
	`applied_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`agent_slug`, `site`),
	FOREIGN KEY (`credential_id`) REFERENCES `browser_credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_browser_credentials_credential_idx` ON `agent_browser_credentials` (`credential_id`);--> statement-breakpoint
CREATE TABLE `browser_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`site` text NOT NULL,
	`browser_type` text NOT NULL,
	`bundle` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`captured_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `browser_credentials_user_site_idx` ON `browser_credentials` (`user_id`,`site`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_credentials_owner_site_type_unique` ON `browser_credentials` (coalesce(`user_id`, ''),`site`,`browser_type`);