CREATE TABLE `apns_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`environment` text DEFAULT 'production' NOT NULL,
	`user_id` text,
	`mobile_device_id` text,
	`workspace_tag` text,
	`device_name` text,
	`platform` text DEFAULT 'ios' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mobile_device_id`) REFERENCES `mobile_device`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apns_devices_token_unique` ON `apns_devices` (`token`);--> statement-breakpoint
CREATE INDEX `apns_devices_user_id_idx` ON `apns_devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `apns_devices_mobile_device_id_idx` ON `apns_devices` (`mobile_device_id`);