ALTER TABLE `media_garbage` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `removed_media` ADD `blob_hash` text;--> statement-breakpoint
ALTER TABLE `removed_media` ADD `blob_size` integer;--> statement-breakpoint
ALTER TABLE `removed_media` ADD `blob_mime` text;--> statement-breakpoint
ALTER TABLE `removed_media` ADD `blob_remote_at` integer;--> statement-breakpoint
ALTER TABLE `removed_media` ADD `restore` text;--> statement-breakpoint
ALTER TABLE `removed_media` ADD `restore_asset` text;--> statement-breakpoint
ALTER TABLE `removed_media` ADD `restore_error` text;