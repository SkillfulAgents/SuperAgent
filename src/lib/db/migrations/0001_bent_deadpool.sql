CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`name` text NOT NULL,
	`input` text NOT NULL,
	`result` text,
	`is_error` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
