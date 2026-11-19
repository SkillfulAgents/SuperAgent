-- Hand-written (SUP-220, SUP-222). schema.ts has always declared a cascading FK
-- from connected_accounts, remote_mcp_servers and agent_acl to `user`, and the
-- snapshots claim it exists, but the tables only ever got a bare `user_id`
-- column (SQLite cannot add a FK with ALTER). Deleting a user left their
-- accounts, MCP servers (with stored tokens and client secrets) and ACL rows
-- behind. This rebuilds the three tables with the FK, and scopes the
-- provider connection id's uniqueness to its provider.
--
-- Migrations run in one transaction, where `PRAGMA foreign_keys=OFF` is a
-- no-op, so dropping a parent table runs its children's ON DELETE CASCADE. The
-- children of connected_accounts and remote_mcp_servers are therefore set
-- aside first and put back once both parents are rebuilt. Every statement
-- leaves the foreign keys satisfied, so no check is deferred.
--
-- Nothing here relies on a cascade either: `drizzle-kit migrate` runs on
-- libsql, whose migrate() turns foreign keys off, so each delete names the
-- rows it removes and only children of surviving parents are put back.

-- Non-auth mode now stores no owner (as account sync always has) instead of
-- the 'local' sentinel, which has no user row to reference.
UPDATE `connected_accounts` SET `user_id` = NULL WHERE `user_id` = 'local';--> statement-breakpoint
UPDATE `remote_mcp_servers` SET `user_id` = NULL WHERE `user_id` = 'local';--> statement-breakpoint

-- Rows whose owner is already deleted: what the cascade would have removed.
-- Their children are left out of the copies below.
DELETE FROM `connected_accounts` WHERE `user_id` IS NOT NULL AND `user_id` NOT IN (SELECT `id` FROM `user`);--> statement-breakpoint
DELETE FROM `remote_mcp_servers` WHERE `user_id` IS NOT NULL AND `user_id` NOT IN (SELECT `id` FROM `user`);--> statement-breakpoint
DELETE FROM `agent_acl` WHERE `user_id` NOT IN (SELECT `id` FROM `user`);--> statement-breakpoint
DELETE FROM `user_settings` WHERE `user_id` <> 'local' AND `user_id` NOT IN (SELECT `id` FROM `user`);--> statement-breakpoint

CREATE TABLE `__saved_agent_connected_accounts` AS SELECT * FROM `agent_connected_accounts` WHERE `connected_account_id` IN (SELECT `id` FROM `connected_accounts`);--> statement-breakpoint
CREATE TABLE `__saved_api_scope_policies` AS SELECT * FROM `api_scope_policies` WHERE `account_id` IN (SELECT `id` FROM `connected_accounts`);--> statement-breakpoint
CREATE TABLE `__saved_agent_remote_mcps` AS SELECT * FROM `agent_remote_mcps` WHERE `remote_mcp_id` IN (SELECT `id` FROM `remote_mcp_servers`);--> statement-breakpoint
CREATE TABLE `__saved_mcp_tool_policies` AS SELECT * FROM `mcp_tool_policies` WHERE `mcp_id` IN (SELECT `id` FROM `remote_mcp_servers`);--> statement-breakpoint
CREATE TABLE `__saved_proxy_rules` AS SELECT * FROM `proxy_rules` WHERE `account_id` IN (SELECT `id` FROM `connected_accounts`) OR `mcp_id` IN (SELECT `id` FROM `remote_mcp_servers`);--> statement-breakpoint
CREATE TABLE `__saved_proxy_rule_versions` AS SELECT * FROM `proxy_rule_versions` WHERE `rule_id` IN (SELECT `id` FROM `__saved_proxy_rules`);--> statement-breakpoint
DELETE FROM `proxy_rule_versions`;--> statement-breakpoint
DELETE FROM `proxy_rules`;--> statement-breakpoint
DELETE FROM `agent_connected_accounts`;--> statement-breakpoint
DELETE FROM `api_scope_policies`;--> statement-breakpoint
DELETE FROM `agent_remote_mcps`;--> statement-breakpoint
DELETE FROM `mcp_tool_policies`;--> statement-breakpoint

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
);
--> statement-breakpoint
INSERT INTO `__new_connected_accounts`("id", "provider_connection_id", "provider_name", "toolkit_slug", "display_name", "status", "user_id", "created_at", "updated_at") SELECT "id", "provider_connection_id", "provider_name", "toolkit_slug", "display_name", "status", "user_id", "created_at", "updated_at" FROM `connected_accounts`;--> statement-breakpoint
DROP TABLE `connected_accounts`;--> statement-breakpoint
ALTER TABLE `__new_connected_accounts` RENAME TO `connected_accounts`;--> statement-breakpoint
CREATE INDEX `connected_accounts_userId_idx` ON `connected_accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `connected_accounts_provider_connection_unique` ON `connected_accounts` (`provider_name`,`provider_connection_id`);--> statement-breakpoint

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
);
--> statement-breakpoint
INSERT INTO `__new_remote_mcp_servers`("id", "name", "url", "user_id", "auth_type", "access_token", "refresh_token", "token_expires_at", "oauth_token_endpoint", "oauth_client_id", "oauth_client_secret", "oauth_resource", "tools_json", "tools_discovered_at", "status", "error_message", "created_at", "updated_at") SELECT "id", "name", "url", "user_id", "auth_type", "access_token", "refresh_token", "token_expires_at", "oauth_token_endpoint", "oauth_client_id", "oauth_client_secret", "oauth_resource", "tools_json", "tools_discovered_at", "status", "error_message", "created_at", "updated_at" FROM `remote_mcp_servers`;--> statement-breakpoint
DROP TABLE `remote_mcp_servers`;--> statement-breakpoint
ALTER TABLE `__new_remote_mcp_servers` RENAME TO `remote_mcp_servers`;--> statement-breakpoint

INSERT INTO `agent_connected_accounts` SELECT * FROM `__saved_agent_connected_accounts`;--> statement-breakpoint
INSERT INTO `api_scope_policies` SELECT * FROM `__saved_api_scope_policies`;--> statement-breakpoint
INSERT INTO `agent_remote_mcps` SELECT * FROM `__saved_agent_remote_mcps`;--> statement-breakpoint
INSERT INTO `mcp_tool_policies` SELECT * FROM `__saved_mcp_tool_policies`;--> statement-breakpoint
INSERT INTO `proxy_rules` SELECT * FROM `__saved_proxy_rules`;--> statement-breakpoint
INSERT INTO `proxy_rule_versions` SELECT * FROM `__saved_proxy_rule_versions`;--> statement-breakpoint
DROP TABLE `__saved_agent_connected_accounts`;--> statement-breakpoint
DROP TABLE `__saved_api_scope_policies`;--> statement-breakpoint
DROP TABLE `__saved_agent_remote_mcps`;--> statement-breakpoint
DROP TABLE `__saved_mcp_tool_policies`;--> statement-breakpoint
DROP TABLE `__saved_proxy_rules`;--> statement-breakpoint
DROP TABLE `__saved_proxy_rule_versions`;--> statement-breakpoint

CREATE TABLE `__new_agent_acl` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_agent_acl`("id", "user_id", "agent_slug", "role", "created_at") SELECT "id", "user_id", "agent_slug", "role", "created_at" FROM `agent_acl`;--> statement-breakpoint
DROP TABLE `agent_acl`;--> statement-breakpoint
ALTER TABLE `__new_agent_acl` RENAME TO `agent_acl`;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_acl_user_agent_unique` ON `agent_acl` (`user_id`,`agent_slug`);--> statement-breakpoint
CREATE INDEX `agent_acl_agent_slug_idx` ON `agent_acl` (`agent_slug`);
