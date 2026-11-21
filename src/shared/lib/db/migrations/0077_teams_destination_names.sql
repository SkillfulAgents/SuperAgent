ALTER TABLE `teams_conversation_references` ADD `display_name` text;
--> statement-breakpoint
-- Earlier Teams installations kept destination names on the conversation approval.
UPDATE teams_conversation_references AS ref
SET display_name = (
  SELECT coalesce(access.title, CASE WHEN ref.scope_type = 'personal' THEN access.first_user_name END)
  FROM chat_integration_access AS access
  WHERE access.integration_id = ref.integration_id AND access.external_chat_id = ref.external_id
)
WHERE ref.thread_root IS NULL;
--> statement-breakpoint
DELETE FROM chat_integration_access
WHERE integration_id IN (SELECT id FROM chat_integrations WHERE provider = 'teams');
