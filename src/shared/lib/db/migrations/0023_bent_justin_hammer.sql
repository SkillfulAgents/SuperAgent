CREATE TABLE `chat_integration_access` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`external_chat_id` text NOT NULL,
	`chat_type` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`approval_source` text,
	`title` text,
	`first_user_id` text,
	`first_user_name` text,
	`first_message_preview` text,
	`request_notice_sent_at` integer,
	`requested_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chat_integration_access_status_check" CHECK("chat_integration_access"."status" in ('pending','allowed','denied')),
	CONSTRAINT "chat_integration_access_chat_type_check" CHECK("chat_integration_access"."chat_type" is null or "chat_integration_access"."chat_type" in ('private','group','supergroup')),
	CONSTRAINT "chat_integration_access_source_check" CHECK("chat_integration_access"."approval_source" is null or "chat_integration_access"."approval_source" in ('auto_first_contact','owner','migration'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_integration_access_unique` ON `chat_integration_access` (`integration_id`,`external_chat_id`);--> statement-breakpoint
CREATE INDEX `chat_integration_access_status_idx` ON `chat_integration_access` (`integration_id`,`status`);--> statement-breakpoint
ALTER TABLE `chat_integrations` ADD `require_approval` integer DEFAULT true NOT NULL;