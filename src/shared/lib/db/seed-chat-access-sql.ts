export const SEED_CHAT_ACCESS_SQL = `
INSERT INTO chat_integration_access
  (id, integration_id, external_chat_id, chat_type, status, approval_source, requested_at, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))), s.integration_id, s.external_chat_id, NULL, 'allowed', 'migration',
  (strftime('%s','now') * 1000), (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)
FROM (
  SELECT DISTINCT integration_id, external_chat_id
  FROM chat_integration_sessions
  WHERE archived_at IS NULL
) s
JOIN chat_integrations ci ON ci.id = s.integration_id
WHERE ci.provider = 'telegram';
`
