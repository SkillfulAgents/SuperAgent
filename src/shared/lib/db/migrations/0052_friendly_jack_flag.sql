ALTER TABLE `todos` ADD `new_agent` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `todos` ADD `model` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `llm_provider_id` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `speed` text;