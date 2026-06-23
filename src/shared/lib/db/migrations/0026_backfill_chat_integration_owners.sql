-- Backfill the integration owner for single-user / local deployments so the
-- dashboard share button/photo path (gated on createdByUserId) isn't blocked by
-- legacy rows that predate owner attribution. Guarded by `(SELECT COUNT(*) FROM
-- user) = 0`: only single-user/local installs have no user rows, so this never
-- claims an agent-created integration for the wrong owner on a multi-user
-- deployment. Idempotent — safe to leave applied.
UPDATE chat_integrations
SET created_by_user_id = 'local'
WHERE (created_by_user_id IS NULL OR created_by_user_id = '')
  AND (SELECT COUNT(*) FROM user) = 0;
