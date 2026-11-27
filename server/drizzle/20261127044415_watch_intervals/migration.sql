-- A watch's interval is a number and a unit instead of three fixed choices:
-- `6h` is 6 hours, `daily` 1 day, `weekly` 1 week. Their slots stay where
-- they were (the same duration, from the same offset), so `next_run_at`
-- carries over. Months and years count from the local day of `anchor_at` in
-- `time_zone`; the old watches start from when they were made, in UTC.
-- The new NOT NULL columns have no default, which SQLite only allows by
-- rebuilding the table. Dropping `watches` sets `updates.watch_id` to NULL
-- (the migrations run in a transaction, with foreign keys on), so the runs'
-- watches are kept aside and put back.
CREATE TABLE `__new_watches` (
	`id` text PRIMARY KEY,
	`collection_id` text,
	`folder_id` text,
	`every_count` integer NOT NULL,
	`every_unit` text NOT NULL,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`anchor_at` integer NOT NULL,
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
INSERT INTO `__new_watches`(`id`, `collection_id`, `folder_id`, `every_count`, `every_unit`, `time_zone`, `anchor_at`, `options`, `enabled`, `next_run_at`, `error`, `created_at`)
SELECT `id`, `collection_id`, `folder_id`,
  CASE `frequency` WHEN '6h' THEN 6 ELSE 1 END,
  CASE `frequency` WHEN '6h' THEN 'hour' WHEN 'weekly' THEN 'week' ELSE 'day' END,
  'UTC', `created_at`, `options`, `enabled`, `next_run_at`, `error`, `created_at`
FROM `watches`;--> statement-breakpoint
CREATE TEMP TABLE `watch_runs` AS
SELECT `id`, `watch_id` FROM `updates` WHERE `watch_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `watches`;--> statement-breakpoint
ALTER TABLE `__new_watches` RENAME TO `watches`;--> statement-breakpoint
UPDATE `updates` SET `watch_id` = (
    SELECT r.`watch_id` FROM temp.`watch_runs` r WHERE r.`id` = `updates`.`id`)
WHERE `id` IN (SELECT `id` FROM temp.`watch_runs`);--> statement-breakpoint
DROP TABLE temp.`watch_runs`;--> statement-breakpoint
CREATE UNIQUE INDEX `watches_collection` ON `watches` (`collection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `watches_folder` ON `watches` (`folder_id`);--> statement-breakpoint
CREATE INDEX `watches_due` ON `watches` (`enabled`,`next_run_at`);
