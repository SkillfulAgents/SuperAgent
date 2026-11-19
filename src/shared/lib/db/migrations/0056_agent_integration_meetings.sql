CREATE TABLE `agent_integration_meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`meeting_url` text NOT NULL,
	`platform` text NOT NULL,
	`bot_name` text NOT NULL,
	`mode` text DEFAULT 'voice' NOT NULL,
	`bot_id` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`status_detail` text,
	`session_id` text,
	`context` text,
	`participant_token_hash` text NOT NULL,
	`created_by_user_id` text,
	`requested_at` integer NOT NULL,
	`joined_at` integer,
	`ended_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_integration_meetings_integration_idx` ON `agent_integration_meetings` (`integration_id`);--> statement-breakpoint
CREATE INDEX `agent_integration_meetings_session_idx` ON `agent_integration_meetings` (`agent_slug`,`session_id`);--> statement-breakpoint
CREATE INDEX `agent_integration_meetings_status_idx` ON `agent_integration_meetings` (`status`);