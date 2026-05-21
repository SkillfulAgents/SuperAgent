CREATE TABLE `x_agent_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`caller_agent_slug` text NOT NULL,
	`target_agent_slug` text,
	`operation` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `x_agent_policies_unique` ON `x_agent_policies` (`caller_agent_slug`,`target_agent_slug`,`operation`);--> statement-breakpoint
CREATE INDEX `x_agent_policies_caller_idx` ON `x_agent_policies` (`caller_agent_slug`);
