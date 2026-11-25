ALTER TABLE `catalog` RENAME COLUMN `search` TO `search_text`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_catalog` (
	`collection_id` text PRIMARY KEY,
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
INSERT INTO `__new_catalog`(`collection_id`, `revision_id`, `revision_at`, `observed_at`, `published_at`, `storage_bytes`, `root_entity_id`, `root_kind`, `author_entity_id`, `author_name`, `subject_entity_id`, `subject_protected`, `has_media`, `has_image`, `has_video`, `has_sensitive`, `quotes`, `search_text`, `followers_count`, `following_count`) SELECT `collection_id`, `revision_id`, `revision_at`, `observed_at`, `published_at`, `storage_bytes`, `root_entity_id`, `root_kind`, `author_entity_id`, `author_name`, `subject_entity_id`, `subject_protected`, `has_media`, `has_image`, `has_video`, `has_sensitive`, `quotes`, `search_text`, `followers_count`, `following_count` FROM `catalog`;--> statement-breakpoint
DROP TABLE `catalog`;--> statement-breakpoint
ALTER TABLE `__new_catalog` RENAME TO `catalog`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `catalog_observed` ON `catalog` (`observed_at`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_published` ON `catalog` (`published_at`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_storage` ON `catalog` (`storage_bytes`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_followers_desc` ON `catalog` (`followers_desc`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_followers_asc` ON `catalog` (`followers_asc`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_following_desc` ON `catalog` (`following_desc`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_following_asc` ON `catalog` (`following_asc`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_root` ON `catalog` (`root_entity_id`);--> statement-breakpoint
CREATE INDEX `catalog_author` ON `catalog` (`author_entity_id`,`author_name`,`revision_at`,`revision_id`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_subject` ON `catalog` (`subject_entity_id`,`revision_at`,`revision_id`);