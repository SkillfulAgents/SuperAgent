CREATE TABLE `agent_sessions` (
	`agent_slug` text NOT NULL,
	`session_id` text NOT NULL,
	`metadata` text,
	`transcript_mtime_ms` real,
	`transcript_birthtime_ms` real,
	`transcript_size` integer,
	PRIMARY KEY(`agent_slug`, `session_id`)
);
