CREATE TABLE `host_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`version` integer NOT NULL,
	`expires_at` integer
);
