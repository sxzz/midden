CREATE TABLE `removed_media` (
	`media_key` text PRIMARY KEY,
	`kind` text NOT NULL,
	`thumbnail_key` text,
	`thumbnail_mime` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `media_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `assets_media` ON `assets` (`media_key`);--> statement-breakpoint
CREATE INDEX `removed_media_thumbnail` ON `removed_media` (`thumbnail_key`) WHERE "removed_media"."thumbnail_key" IS NOT NULL;--> statement-breakpoint
-- The identity is the cache key, as new captures compute it wherever the two
-- agree (all but Instagram, whose cache key adds the rendition); media
-- without one are known by address, as new ones are.
UPDATE `assets` SET `media_key` = CASE WHEN `cache_key` <> '' THEN `cache_key` ELSE 'url:' || `source_url` END;
