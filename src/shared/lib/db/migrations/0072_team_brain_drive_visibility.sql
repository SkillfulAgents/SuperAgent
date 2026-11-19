-- Drive visibility checks the current Team Brain designation in its UPDATE.
-- Check the other direction at the settings write too: choosing a drive and
-- making it private in another window cannot both succeed.
CREATE TRIGGER team_brain_public_drive_insert BEFORE INSERT ON app_records
WHEN NEW.key = 'settings' AND json_valid(NEW.value) AND EXISTS (
  SELECT 1 FROM volume_definitions
  WHERE id = json_extract(NEW.value, '$.teamBrain.volumeId') AND visibility = 'private'
)
BEGIN
  SELECT RAISE(ABORT, 'Team Brain requires a public drive');
END;
--> statement-breakpoint
CREATE TRIGGER team_brain_public_drive_update BEFORE UPDATE OF value ON app_records
WHEN NEW.key = 'settings' AND json_valid(NEW.value)
AND json_extract(NEW.value, '$.teamBrain.volumeId') IS NOT
  CASE WHEN json_valid(OLD.value) THEN json_extract(OLD.value, '$.teamBrain.volumeId') END
AND EXISTS (
  SELECT 1 FROM volume_definitions
  WHERE id = json_extract(NEW.value, '$.teamBrain.volumeId') AND visibility = 'private'
)
BEGIN
  SELECT RAISE(ABORT, 'Team Brain requires a public drive');
END;
