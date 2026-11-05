ALTER TABLE `chat_integrations` ADD `version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Hand-written: drizzle-kit does not model triggers. Every update of a row that
-- does not raise its version itself moves it by one, in the same statement, so
-- no writer can leave a changed row at an old version. A migration that rebuilds
-- this table drops the trigger; integration-row-version.test.ts fails until it
-- is created again.
CREATE TRIGGER `chat_integrations_version_bump` AFTER UPDATE ON `chat_integrations` FOR EACH ROW WHEN NEW.`version` <= OLD.`version` BEGIN UPDATE `chat_integrations` SET `version` = OLD.`version` + 1 WHERE `id` = NEW.`id`; END;
