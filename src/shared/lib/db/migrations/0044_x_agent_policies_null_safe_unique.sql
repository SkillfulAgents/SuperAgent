-- A plain unique index treats NULL as distinct, so global (null-target)
-- policies could be duplicated by concurrent writes before setPolicy became a
-- single upsert. Keep the most recently updated global row per (caller,
-- operation), then add the NULL-folded unique key the upsert conflicts on.
DELETE FROM `x_agent_policies` WHERE `target_agent_slug` IS NULL AND `id` NOT IN (
	SELECT `id` FROM (
		SELECT `id`, max(`updated_at`) AS `latest` FROM `x_agent_policies`
		WHERE `target_agent_slug` IS NULL GROUP BY `caller_agent_slug`, `operation`
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX `x_agent_policies_null_safe_unique` ON `x_agent_policies` (`caller_agent_slug`,coalesce(`target_agent_slug`, ''),`operation`);
