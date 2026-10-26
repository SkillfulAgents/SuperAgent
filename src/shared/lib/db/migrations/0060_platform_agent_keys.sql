CREATE TABLE `platform_agent_keys` (
	`agent_slug` text NOT NULL,
	`parent_hash` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_slug`, `parent_hash`)
);
