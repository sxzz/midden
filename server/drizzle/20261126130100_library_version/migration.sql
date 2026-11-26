CREATE TABLE `library_version` (
	`id` integer PRIMARY KEY,
	`n` integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
-- The one row the triggers below move: by any write that may change what a
-- library filter selects (`library/counts.ts`). Not by the columns that
-- change with every capture or download and that no filter reads (the
-- observation time, the published time, the storage size, follower counts,
-- when a follow was last seen, a note).
INSERT INTO `library_version` (`id`, `n`) VALUES (1, 0);--> statement-breakpoint
CREATE TRIGGER `library_version_catalog_insert` AFTER INSERT ON `catalog` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_catalog_update` AFTER UPDATE OF `revision_id`, `revision_at`, `root_entity_id`, `root_kind`, `author_entity_id`, `author_name`, `subject_entity_id`, `subject_protected`, `has_media`, `has_image`, `has_video`, `has_sensitive`, `quotes`, `search_name`, `search_text`, `search_quoted`, `search_extra` ON `catalog` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_catalog_delete` AFTER DELETE ON `catalog` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_library_insert` AFTER INSERT ON `library` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_library_update` AFTER UPDATE OF `collection_id`, `created_at` ON `library` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_library_delete` AFTER DELETE ON `library` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_tags_insert` AFTER INSERT ON `collection_tags` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_tags_update` AFTER UPDATE ON `collection_tags` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_tags_delete` AFTER DELETE ON `collection_tags` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_follows_insert` AFTER INSERT ON `follow_edges` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_follows_update` AFTER UPDATE OF `follower_id`, `followee_id`, `ended_at` ON `follow_edges` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_follows_delete` AFTER DELETE ON `follow_edges` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `library_version_source_state` AFTER UPDATE OF `source_state` ON `collections`
WHEN old.`source_state` IS NOT new.`source_state` BEGIN
  UPDATE `library_version` SET `n` = `n` + 1 WHERE `id` = 1;
END;
