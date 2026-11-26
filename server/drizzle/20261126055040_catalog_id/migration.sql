-- The catalog's rowid keys the search indexes (`catalog_fts`, `catalog_cjk`),
-- and VACUUM may renumber the rowids of a table without an INTEGER PRIMARY
-- KEY, which would point them at the wrong rows. An INTEGER PRIMARY KEY is
-- the rowid itself, kept as it is. The table is rebuilt with one, and the
-- triggers keeping the indexes in step use it. Nothing refers to the catalog,
-- so dropping it deletes nothing else (the migrations run in a transaction,
-- with foreign keys on); dropping it drops its triggers too.
CREATE TABLE `__new_catalog` (
	`id` integer PRIMARY KEY,
	`collection_id` text NOT NULL UNIQUE,
	`revision_id` text NOT NULL,
	`revision_at` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`published_at` integer NOT NULL,
	`storage_bytes` integer NOT NULL,
	`root_entity_id` text,
	`root_kind` text,
	`author_entity_id` text,
	`author_name` text NOT NULL,
	`subject_entity_id` text,
	`subject_protected` integer,
	`has_media` integer NOT NULL,
	`has_image` integer NOT NULL,
	`has_video` integer NOT NULL,
	`has_sensitive` integer NOT NULL,
	`quotes` integer NOT NULL,
	`search_name` text DEFAULT '' NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`search_quoted` text DEFAULT '' NOT NULL,
	`search_extra` text DEFAULT '' NOT NULL,
	`followers_count` integer,
	`following_count` integer,
	`followers_desc` integer GENERATED ALWAYS AS (coalesce(followers_count, -1)) VIRTUAL,
	`followers_asc` integer GENERATED ALWAYS AS (coalesce(followers_count, 9007199254740991)) VIRTUAL,
	`following_desc` integer GENERATED ALWAYS AS (coalesce(following_count, -1)) VIRTUAL,
	`following_asc` integer GENERATED ALWAYS AS (coalesce(following_count, 9007199254740991)) VIRTUAL,
	CONSTRAINT `fk_catalog_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- Each row keeps its rowid as its id: the search indexes hold it, so they
-- stay as they are.
INSERT INTO `__new_catalog`(`id`, `collection_id`, `revision_id`, `revision_at`, `observed_at`, `published_at`, `storage_bytes`, `root_entity_id`, `root_kind`, `author_entity_id`, `author_name`, `subject_entity_id`, `subject_protected`, `has_media`, `has_image`, `has_video`, `has_sensitive`, `quotes`, `search_name`, `search_text`, `search_quoted`, `search_extra`, `followers_count`, `following_count`) SELECT `rowid`, `collection_id`, `revision_id`, `revision_at`, `observed_at`, `published_at`, `storage_bytes`, `root_entity_id`, `root_kind`, `author_entity_id`, `author_name`, `subject_entity_id`, `subject_protected`, `has_media`, `has_image`, `has_video`, `has_sensitive`, `quotes`, `search_name`, `search_text`, `search_quoted`, `search_extra`, `followers_count`, `following_count` FROM `catalog`;--> statement-breakpoint
DROP TABLE `catalog`;--> statement-breakpoint
ALTER TABLE `__new_catalog` RENAME TO `catalog`;--> statement-breakpoint
CREATE INDEX `catalog_observed` ON `catalog` (`observed_at`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_published` ON `catalog` (`published_at`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_storage` ON `catalog` (`storage_bytes`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_followers_desc` ON `catalog` (`followers_desc`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_followers_asc` ON `catalog` (`followers_asc`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_following_desc` ON `catalog` (`following_desc`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_following_asc` ON `catalog` (`following_asc`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_root` ON `catalog` (`root_entity_id`);--> statement-breakpoint
CREATE INDEX `catalog_author` ON `catalog` (`author_entity_id`,`author_name`,`revision_at`,`revision_id`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_subject` ON `catalog` (`subject_entity_id`,`revision_at`,`revision_id`);;--> statement-breakpoint
CREATE TRIGGER `catalog_search_insert` AFTER INSERT ON `catalog` BEGIN
  INSERT INTO `catalog_fts` (`rowid`, `text`, `name`, `quoted`, `extra`)
  VALUES (new.`id`, new.`search_text`, new.`search_name`,
    new.`search_quoted`, new.`search_extra`);
  INSERT INTO `catalog_cjk` (`rowid`, `text`, `name`, `quoted`, `extra`)
  VALUES (new.`id`, search_words(new.`search_text`),
    search_words(new.`search_name`), search_words(new.`search_quoted`),
    search_words(new.`search_extra`));
END;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_update`
AFTER UPDATE OF `search_name`, `search_text`, `search_quoted`, `search_extra` ON `catalog`
WHEN old.`search_name` IS NOT new.`search_name`
  OR old.`search_text` IS NOT new.`search_text`
  OR old.`search_quoted` IS NOT new.`search_quoted`
  OR old.`search_extra` IS NOT new.`search_extra`
BEGIN
  DELETE FROM `catalog_fts` WHERE `rowid` = old.`id`;
  DELETE FROM `catalog_cjk` WHERE `rowid` = old.`id`;
  INSERT INTO `catalog_fts` (`rowid`, `text`, `name`, `quoted`, `extra`)
  VALUES (new.`id`, new.`search_text`, new.`search_name`,
    new.`search_quoted`, new.`search_extra`);
  INSERT INTO `catalog_cjk` (`rowid`, `text`, `name`, `quoted`, `extra`)
  VALUES (new.`id`, search_words(new.`search_text`),
    search_words(new.`search_name`), search_words(new.`search_quoted`),
    search_words(new.`search_extra`));
END;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_delete` AFTER DELETE ON `catalog` BEGIN
  DELETE FROM `catalog_fts` WHERE `rowid` = old.`id`;
  DELETE FROM `catalog_cjk` WHERE `rowid` = old.`id`;
END;
