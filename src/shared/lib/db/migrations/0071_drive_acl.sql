CREATE TABLE `volume_acl` (
	`id` text PRIMARY KEY NOT NULL,
	`volume_id` text NOT NULL,
	`user_id` text,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`volume_id`) REFERENCES `volume_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "volume_acl_role_check" CHECK("volume_acl"."role" = 'owner')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `volume_acl_member_unique` ON `volume_acl` (`volume_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `volume_acl_workspace_unique` ON `volume_acl` (`volume_id`) WHERE "volume_acl"."user_id" is null;--> statement-breakpoint
CREATE INDEX `volume_acl_user_idx` ON `volume_acl` (`user_id`);--> statement-breakpoint
-- Rebuilding a referenced parent with foreign keys enabled would cascade into its
-- attachments. Preserve every mount identity, name, timestamp and access level.
CREATE TABLE __drive_acl_mounts AS SELECT * FROM agent_volumes;
--> statement-breakpoint
DELETE FROM agent_volumes;--> statement-breakpoint
CREATE TABLE `__new_volume_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`visibility` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`global_access` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "volume_visibility_check" CHECK("__new_volume_definitions"."visibility" in ('public', 'private') and ("__new_volume_definitions"."global_access" is null or "__new_volume_definitions"."visibility" = 'public'))
);
--> statement-breakpoint
INSERT INTO `__new_volume_definitions`("id", "user_id", "visibility", "name", "type", "config", "global_access", "created_at", "updated_at") SELECT "id", "user_id", CASE WHEN user_id IS NULL THEN 'public' ELSE 'private' END, "name", "type", "config", "global_access", "created_at", "updated_at" FROM `volume_definitions`;--> statement-breakpoint
DROP TABLE `volume_definitions`;--> statement-breakpoint
ALTER TABLE `__new_volume_definitions` RENAME TO `volume_definitions`;--> statement-breakpoint
INSERT INTO agent_volumes SELECT * FROM __drive_acl_mounts;
--> statement-breakpoint
DROP TABLE __drive_acl_mounts;--> statement-breakpoint
CREATE INDEX `volume_definitions_creator_idx` ON `volume_definitions` (`user_id`);
--> statement-breakpoint
INSERT INTO volume_acl(id, volume_id, user_id, role, created_at)
SELECT lower(hex(randomblob(16))), id, user_id, 'owner', created_at FROM volume_definitions;
--> statement-breakpoint
-- Creating the definition, including create-and-attach and legacy imports, always
-- creates its first owner in the same statement. Local drives belong to the workspace.
CREATE TRIGGER volume_seed_owner AFTER INSERT ON volume_definitions BEGIN
  INSERT INTO volume_acl(id, volume_id, user_id, role, created_at)
  VALUES(lower(hex(randomblob(16))), NEW.id, NEW.user_id, 'owner', NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER volume_workspace_owner_public BEFORE INSERT ON volume_acl
WHEN NEW.user_id IS NULL AND EXISTS (
  SELECT 1 FROM volume_definitions WHERE id = NEW.volume_id AND visibility = 'private'
) BEGIN
  SELECT RAISE(ABORT, 'A private drive requires a named owner');
END;
--> statement-breakpoint
CREATE TRIGGER volume_acl_immutable_principal BEFORE UPDATE OF volume_id, user_id ON volume_acl
WHEN NEW.volume_id IS NOT OLD.volume_id OR NEW.user_id IS NOT OLD.user_id BEGIN
  SELECT RAISE(ABORT, 'Add an owner before removing another');
END;
--> statement-breakpoint
CREATE TRIGGER volume_remove_workspace_owner AFTER UPDATE OF visibility ON volume_definitions
WHEN NEW.visibility = 'private' AND OLD.visibility = 'public' BEGIN
  DELETE FROM volume_acl WHERE volume_id = NEW.id AND user_id IS NULL;
END;
--> statement-breakpoint
-- Also covers a user's FK cascade. Deleting the drive itself is allowed because
-- SQLite removes the parent before running its cascading deletes.
CREATE TRIGGER volume_keep_owner BEFORE DELETE ON volume_acl
WHEN EXISTS (SELECT 1 FROM volume_definitions WHERE id = OLD.volume_id)
AND NOT EXISTS (SELECT 1 FROM volume_acl WHERE volume_id = OLD.volume_id AND id <> OLD.id AND role = 'owner')
BEGIN
  SELECT RAISE(ABORT, 'A drive must have at least one owner');
END;
