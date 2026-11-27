ALTER TABLE `blob_thumbnails` ADD `remote_at` integer;--> statement-breakpoint
ALTER TABLE `removed_media` ADD `thumbnail_remote_at` integer;--> statement-breakpoint
CREATE INDEX `blob_thumbnails_local` ON `blob_thumbnails` (`key`) WHERE "blob_thumbnails"."key" IS NOT NULL AND "blob_thumbnails"."remote_at" IS NULL;