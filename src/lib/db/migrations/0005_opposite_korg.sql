CREATE TABLE `agent_connected_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`connected_account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `connected_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`composio_connection_id` text NOT NULL,
	`toolkit_slug` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connected_accounts_composio_connection_id_unique` ON `connected_accounts` (`composio_connection_id`);