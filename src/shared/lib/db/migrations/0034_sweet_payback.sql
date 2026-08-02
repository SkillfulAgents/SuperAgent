CREATE TABLE `mobile_pairing_token` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mobile_pairing_token_expires_at_idx` ON `mobile_pairing_token` (`expires_at`);--> statement-breakpoint
ALTER TABLE `session` ADD `device_name` text;