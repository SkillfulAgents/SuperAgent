CREATE TABLE `agents` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`runtime` text DEFAULT 'local' NOT NULL,
	`workspace_handle` text
);
