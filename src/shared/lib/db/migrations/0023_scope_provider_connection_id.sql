-- SUP-222: provider connection IDs must be unique *per provider*, not globally.
-- 0021 renamed composio_connection_id -> provider_connection_id but left the old
-- single-column UNIQUE index in place, so two different providers (e.g. composio
-- and nango) returning the same opaque connection ID collide. Replace the
-- single-column unique with a composite (provider_name, provider_connection_id).
-- Index-only change; no table rebuild required.
DROP INDEX `connected_accounts_composio_connection_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `connected_accounts_provider_conn_unique` ON `connected_accounts` (`provider_name`,`provider_connection_id`);
