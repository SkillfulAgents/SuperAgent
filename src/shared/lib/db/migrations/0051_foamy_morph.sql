CREATE TABLE `agent_volumes` (
	`id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`volume_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_slug`, `id`),
	FOREIGN KEY (`agent_slug`) REFERENCES `agents`(`slug`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`volume_id`) REFERENCES `volume_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_volumes_source_unique` ON `agent_volumes` (`agent_slug`,`volume_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_volumes_name_unique` ON `agent_volumes` (`agent_slug`,`name`);--> statement-breakpoint
CREATE INDEX `agent_volumes_volume_idx` ON `agent_volumes` (`volume_id`);--> statement-breakpoint
CREATE TABLE `volume_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `volume_definitions_owner_idx` ON `volume_definitions` (`user_id`);