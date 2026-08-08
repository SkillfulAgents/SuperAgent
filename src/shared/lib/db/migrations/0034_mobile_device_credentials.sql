CREATE TABLE `mobile_device` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`device_name` text,
	`platform` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_device_refresh_token_hash_unique` ON `mobile_device` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `mobile_device_user_id_idx` ON `mobile_device` (`user_id`);--> statement-breakpoint
CREATE INDEX `mobile_device_expires_at_idx` ON `mobile_device` (`expires_at`);--> statement-breakpoint
CREATE TABLE `mobile_pairing_token` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mobile_pairing_token_expires_at_idx` ON `mobile_pairing_token` (`expires_at`);--> statement-breakpoint
ALTER TABLE `session` ADD `device_id` text REFERENCES mobile_device(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `session_device_id_idx` ON `session` (`device_id`);
