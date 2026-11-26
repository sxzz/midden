-- `cache_key` is stored only where it differs from `media_key`: NULL means
-- the same (every X media, most of the table; a 64-character hash less in the
-- row and in the index). '' stays what it was, no immutable key, never
-- reused. The column is nullable, which SQLite only allows by rebuilding the
-- table (nothing refers to `assets`, so dropping it deletes nothing else; the
-- migrations run in a transaction, with foreign keys on). The indexes are
-- created after the rows, so `assets_cache` is built only with the keys that
-- remain in it.
CREATE TABLE `__new_assets` (
	`id` text PRIMARY KEY,
	`capture_id` text NOT NULL,
	`position` integer NOT NULL,
	`source_url` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`alt_text` text DEFAULT '' NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`cache_key` text,
	`media_key` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`blob_id` text,
	CONSTRAINT `fk_assets_capture_id_captures_id_fk` FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_assets_blob_id_blobs_id_fk` FOREIGN KEY (`blob_id`) REFERENCES `blobs`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_assets`(`id`, `capture_id`, `position`, `source_url`, `purpose`, `alt_text`, `sensitive`, `cache_key`, `media_key`, `kind`, `state`, `error`, `blob_id`) SELECT `id`, `capture_id`, `position`, `source_url`, `purpose`, `alt_text`, `sensitive`, CASE WHEN `cache_key` <> '' AND `cache_key` = `media_key` THEN NULL ELSE `cache_key` END, `media_key`, `kind`, `state`, `error`, `blob_id` FROM `assets`;--> statement-breakpoint
DROP TABLE `assets`;--> statement-breakpoint
ALTER TABLE `__new_assets` RENAME TO `assets`;--> statement-breakpoint
CREATE UNIQUE INDEX `assets_position` ON `assets` (`capture_id`,`position`);--> statement-breakpoint
CREATE INDEX `assets_cache` ON `assets` (`cache_key`) WHERE "assets"."state" = 'ready' AND "assets"."cache_key" <> '';--> statement-breakpoint
CREATE INDEX `assets_blob` ON `assets` (`blob_id`);--> statement-breakpoint
CREATE INDEX `assets_media` ON `assets` (`media_key`);