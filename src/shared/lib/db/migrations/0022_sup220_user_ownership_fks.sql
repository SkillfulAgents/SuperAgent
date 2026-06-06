-- SUP-220: rebuild the five user-owned tables so they carry the FOREIGN KEY to
-- `user` that schema.ts has always declared (cascade / set null on user delete).
-- The original migration chain only ever added bare `user_id` columns (SQLite
-- cannot attach a FK via ALTER), so deleting a Better Auth user orphaned all of
-- these rows. Each table is rebuilt with the SQLite 12-step pattern.
--
-- foreign_keys cannot be toggled inside drizzle's single migration transaction,
-- so we use `defer_foreign_keys=ON` (delays the constraint *check* to COMMIT).
-- NOTE: defer only delays the *check*, not the cascade *action* — dropping a
-- parent table still fires its children's ON DELETE CASCADE. For the two parent
-- tables (connected_accounts, remote_mcp_servers) we stage their children into
-- scratch tables and re-insert them after the rebuild so no child data is lost.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint

-- ===========================================================================
-- connected_accounts  (onDelete: cascade)  — children: agent_connected_accounts,
-- api_scope_policies
-- ===========================================================================
DELETE FROM `connected_accounts` WHERE `user_id` IS NOT NULL AND `user_id` NOT IN (SELECT `id` FROM `user`);--> statement-breakpoint
CREATE TABLE `__sup220_save_agent_connected_accounts` AS SELECT * FROM `agent_connected_accounts`;--> statement-breakpoint
CREATE TABLE `__sup220_save_api_scope_policies` AS SELECT * FROM `api_scope_policies`;--> statement-breakpoint
CREATE TABLE `__new_connected_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_connection_id` text NOT NULL,
	`provider_name` text DEFAULT 'composio' NOT NULL,
	`toolkit_slug` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_connected_accounts` (`id`, `provider_connection_id`, `provider_name`, `toolkit_slug`, `display_name`, `status`, `user_id`, `created_at`, `updated_at`)
	SELECT `id`, `provider_connection_id`, `provider_name`, `toolkit_slug`, `display_name`, `status`, `user_id`, `created_at`, `updated_at` FROM `connected_accounts`;--> statement-breakpoint
DROP TABLE `connected_accounts`;--> statement-breakpoint
ALTER TABLE `__new_connected_accounts` RENAME TO `connected_accounts`;--> statement-breakpoint
CREATE UNIQUE INDEX `connected_accounts_composio_connection_id_unique` ON `connected_accounts` (`provider_connection_id`);--> statement-breakpoint
CREATE INDEX `connected_accounts_userId_idx` ON `connected_accounts` (`user_id`);--> statement-breakpoint
INSERT INTO `agent_connected_accounts` SELECT * FROM `__sup220_save_agent_connected_accounts`;--> statement-breakpoint
INSERT INTO `api_scope_policies` SELECT * FROM `__sup220_save_api_scope_policies`;--> statement-breakpoint
DROP TABLE `__sup220_save_agent_connected_accounts`;--> statement-breakpoint
DROP TABLE `__sup220_save_api_scope_policies`;--> statement-breakpoint

-- ===========================================================================
-- remote_mcp_servers  (onDelete: cascade)  — children: agent_remote_mcps,
-- mcp_tool_policies
-- ===========================================================================
DELETE FROM `remote_mcp_servers` WHERE `user_id` IS NOT NULL AND `user_id` NOT IN (SELECT `id` FROM `user`);--> statement-breakpoint
CREATE TABLE `__sup220_save_agent_remote_mcps` AS SELECT * FROM `agent_remote_mcps`;--> statement-breakpoint
CREATE TABLE `__sup220_save_mcp_tool_policies` AS SELECT * FROM `mcp_tool_policies`;--> statement-breakpoint
CREATE TABLE `__new_remote_mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`user_id` text,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`token_expires_at` integer,
	`oauth_token_endpoint` text,
	`oauth_client_id` text,
	`oauth_client_secret` text,
	`oauth_resource` text,
	`tools_json` text,
	`tools_discovered_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_remote_mcp_servers` (`id`, `name`, `url`, `user_id`, `auth_type`, `access_token`, `refresh_token`, `token_expires_at`, `oauth_token_endpoint`, `oauth_client_id`, `oauth_client_secret`, `oauth_resource`, `tools_json`, `tools_discovered_at`, `status`, `error_message`, `created_at`, `updated_at`)
	SELECT `id`, `name`, `url`, `user_id`, `auth_type`, `access_token`, `refresh_token`, `token_expires_at`, `oauth_token_endpoint`, `oauth_client_id`, `oauth_client_secret`, `oauth_resource`, `tools_json`, `tools_discovered_at`, `status`, `error_message`, `created_at`, `updated_at` FROM `remote_mcp_servers`;--> statement-breakpoint
DROP TABLE `remote_mcp_servers`;--> statement-breakpoint
ALTER TABLE `__new_remote_mcp_servers` RENAME TO `remote_mcp_servers`;--> statement-breakpoint
INSERT INTO `agent_remote_mcps` SELECT * FROM `__sup220_save_agent_remote_mcps`;--> statement-breakpoint
INSERT INTO `mcp_tool_policies` SELECT * FROM `__sup220_save_mcp_tool_policies`;--> statement-breakpoint
DROP TABLE `__sup220_save_agent_remote_mcps`;--> statement-breakpoint
DROP TABLE `__sup220_save_mcp_tool_policies`;--> statement-breakpoint

-- ===========================================================================
-- agent_acl  (onDelete: cascade, user_id NOT NULL)  — no children
-- ===========================================================================
DELETE FROM `agent_acl` WHERE `user_id` NOT IN (SELECT `id` FROM `user`);--> statement-breakpoint
CREATE TABLE `__new_agent_acl` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_agent_acl` (`id`, `user_id`, `agent_slug`, `role`, `created_at`)
	SELECT `id`, `user_id`, `agent_slug`, `role`, `created_at` FROM `agent_acl`;--> statement-breakpoint
DROP TABLE `agent_acl`;--> statement-breakpoint
ALTER TABLE `__new_agent_acl` RENAME TO `agent_acl`;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_acl_user_agent_unique` ON `agent_acl` (`user_id`,`agent_slug`);--> statement-breakpoint
CREATE INDEX `agent_acl_agent_slug_idx` ON `agent_acl` (`agent_slug`);--> statement-breakpoint

-- ===========================================================================
-- user_settings  (onDelete: cascade, user_id PRIMARY KEY NOT NULL) — no children
-- Non-auth mode stores a row under the 'local' sentinel that has no matching
-- `user`. Seed a reserved 'local' user (only when such a row already exists) so
-- the new FK is satisfiable; fresh installs get no 'local' user here, and the
-- runtime seeds it lazily on first write (see user-settings-service.ts).
-- ===========================================================================
INSERT OR IGNORE INTO `user` (`id`, `name`, `email`)
	SELECT 'local', 'Local', 'local@superagent.invalid'
	WHERE EXISTS (SELECT 1 FROM `user_settings` WHERE `user_id` = 'local');--> statement-breakpoint
DELETE FROM `user_settings` WHERE `user_id` <> 'local' AND `user_id` NOT IN (SELECT `id` FROM `user`);--> statement-breakpoint
CREATE TABLE `__new_user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_user_settings` (`user_id`, `settings`, `updated_at`)
	SELECT `user_id`, `settings`, `updated_at` FROM `user_settings`;--> statement-breakpoint
DROP TABLE `user_settings`;--> statement-breakpoint
ALTER TABLE `__new_user_settings` RENAME TO `user_settings`;--> statement-breakpoint

-- ===========================================================================
-- notifications  (onDelete: set null)  — no children
-- ===========================================================================
UPDATE `notifications` SET `user_id` = NULL WHERE `user_id` IS NOT NULL AND `user_id` NOT IN (SELECT `id` FROM `user`);--> statement-breakpoint
CREATE TABLE `__new_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_notifications` (`id`, `type`, `session_id`, `agent_slug`, `title`, `body`, `is_read`, `user_id`, `created_at`, `read_at`)
	SELECT `id`, `type`, `session_id`, `agent_slug`, `title`, `body`, `is_read`, `user_id`, `created_at`, `read_at` FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
CREATE INDEX `notifications_agent_slug_is_read_idx` ON `notifications` (`agent_slug`,`is_read`);--> statement-breakpoint
CREATE INDEX `notifications_session_id_idx` ON `notifications` (`session_id`);--> statement-breakpoint
CREATE INDEX `notifications_created_at_idx` ON `notifications` (`created_at`);
