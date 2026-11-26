CREATE TABLE `video_removals` (
	`id` text PRIMARY KEY,
	`collection_id` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`effect` text,
	`removed` integer DEFAULT 0 NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT `fk_video_removals_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `removed_media` ADD `thumbnail_size` integer;--> statement-breakpoint
CREATE INDEX `video_removals_collection` ON `video_removals` (`collection_id`,`created_at`);