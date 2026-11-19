CREATE TABLE `team_directories` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`tenant_id` text NOT NULL,
	`tenant_name` text NOT NULL,
	`credentials` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`error_message` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_directories_provider_tenant_unique` ON `team_directories` (`provider`,`tenant_id`);