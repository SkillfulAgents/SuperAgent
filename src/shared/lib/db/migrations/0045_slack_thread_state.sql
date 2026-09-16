CREATE TABLE `slack_thread_state` (
	`integration_id` text PRIMARY KEY NOT NULL,
	`bot_user_id` text NOT NULL,
	`active_threads` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
