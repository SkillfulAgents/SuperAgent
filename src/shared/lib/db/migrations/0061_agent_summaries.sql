CREATE TABLE `agent_summaries` (
	`agent_slug` text PRIMARY KEY NOT NULL,
	`summary` text NOT NULL,
	`updated_at` integer NOT NULL
);
