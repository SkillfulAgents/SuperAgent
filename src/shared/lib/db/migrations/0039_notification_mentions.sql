ALTER TABLE `notifications` ADD `recipient_user_id` text;
--> statement-breakpoint
ALTER TABLE `notifications` ADD `message_uuid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_message_recipient_unique` ON `notifications` (`message_uuid`,`recipient_user_id`);
