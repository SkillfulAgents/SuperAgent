CREATE TABLE `agent_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`key` text NOT NULL,
	`env_var` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
