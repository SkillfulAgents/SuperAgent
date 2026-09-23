CREATE TABLE `integration_state` (
	`integration_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`available_at` integer,
	PRIMARY KEY(`integration_id`, `key`),
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `integration_state_due_idx` ON `integration_state` (`integration_id`,`available_at`);--> statement-breakpoint
INSERT INTO `integration_state` (`integration_id`, `key`, `value`, `available_at`)
SELECT `integration_id`, `key`, `value`,
  CASE WHEN substr(`key`, 1, 10) = 'reply-job:' AND json_valid(`value`)
    THEN COALESCE(json_extract(`value`, '$.retryAfter'), 0) ELSE NULL END
FROM `email_integration_state`;
--> statement-breakpoint
INSERT INTO `integration_state` (`integration_id`, `key`, `value`)
SELECT `integration_id`, 'slack:participation',
  json_object('botUserId', `bot_user_id`, 'activeThreads', json(`active_threads`))
FROM `slack_thread_state`;
--> statement-breakpoint
DROP TABLE `email_integration_state`;--> statement-breakpoint
DROP TABLE `slack_thread_state`;
