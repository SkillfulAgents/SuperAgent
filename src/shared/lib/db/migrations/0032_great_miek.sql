CREATE TABLE `token_exchange_jti` (
	`jti` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `token_exchange_jti_expires_at_idx` ON `token_exchange_jti` (`expires_at`);--> statement-breakpoint
DELETE FROM `account` WHERE `rowid` NOT IN (SELECT MIN(`rowid`) FROM `account` GROUP BY `provider_id`, `account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account_unique` ON `account` (`provider_id`,`account_id`);