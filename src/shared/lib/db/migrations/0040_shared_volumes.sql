CREATE TABLE `agent_shared_volumes` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`volume_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`volume_id`) REFERENCES `shared_volumes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_shared_volumes_unique` ON `agent_shared_volumes` (`agent_slug`,`volume_id`);--> statement-breakpoint
CREATE TABLE `shared_volumes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`mount_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_volumes_mount_name_unique` ON `shared_volumes` (`mount_name`);