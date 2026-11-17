ALTER TABLE `user` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `invited_by_user_id` text;--> statement-breakpoint
ALTER TABLE `user` ADD `directory_provider` text;--> statement-breakpoint
ALTER TABLE `user` ADD `directory_tenant_id` text;--> statement-breakpoint
ALTER TABLE `user` ADD `directory_remote_id` text;