ALTER TABLE `team_directories` ADD `provisioning_credentials` text;--> statement-breakpoint
ALTER TABLE `team_directories` ADD `provisioning_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `team_directories` ADD `provisioning_status` text;--> statement-breakpoint
ALTER TABLE `team_directories` ADD `provisioning_error` text;--> statement-breakpoint
ALTER TABLE `team_directories` ADD `directory_app` text;