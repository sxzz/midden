CREATE TABLE `watches` (
	`id` text PRIMARY KEY,
	`collection_id` text,
	`folder_id` text,
	`frequency` text NOT NULL,
	`options` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_watches_collection_id_library_collection_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `library`(`collection_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_watches_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE CASCADE,
	CONSTRAINT "watches_one_target" CHECK(("collection_id" IS NULL) <> ("folder_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE `updates` ADD `origin` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `updates` ADD `watch_id` text REFERENCES watches(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `updates_watch` ON `updates` (`watch_id`,`created_at`) WHERE "updates"."watch_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `watches_collection` ON `watches` (`collection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `watches_folder` ON `watches` (`folder_id`);--> statement-breakpoint
CREATE INDEX `watches_due` ON `watches` (`enabled`,`next_run_at`);--> statement-breakpoint
-- Watch runs rank between updates and maintenance: maintenance moves from
-- rank 2 to 3. A job's priority is its type's own (thumbnails 4, the rest
-- 0) plus its rank (`#jobs/queue.ts`).
UPDATE `jobs` SET `priority` = `priority` + 1
WHERE `priority` = CASE WHEN `type` = 'thumbnail' THEN 6 ELSE 2 END;
