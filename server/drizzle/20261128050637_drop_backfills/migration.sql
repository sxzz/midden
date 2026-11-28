ALTER TABLE `catalog` ADD `facets_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- What the one-off facets backfill (progress in `settings`) did is now kept
-- per row: the rows version 2 worked out (all of them once it was done) are
-- of version 2, and maintenance works out any others again
-- (`library/facets.ts`).
UPDATE `catalog` SET `facets_version` = 2
WHERE EXISTS (
  SELECT 1 FROM `settings` s
  WHERE s.`key` = 'facets_backfill' AND s.`value` ->> '$.version' = 2
    AND (s.`value` ->> '$.done' OR `catalog`.`id` <= s.`value` ->> '$.after'));
--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('facets_backfill', 'handle_profiles_folded');
--> statement-breakpoint
DROP INDEX `blob_thumbnails_local`;--> statement-breakpoint
-- The fold of profiles saved by handle is done: its pending lookups (not
-- records: no input) go with the columns only it used. Those it gave up on
-- stay as failed records of their links.
DELETE FROM `identity_requests` WHERE `collection_id` IS NOT NULL;
--> statement-breakpoint
DROP INDEX `identity_requests_collection`;--> statement-breakpoint
ALTER TABLE `identity_requests` DROP COLUMN `collection_id`;--> statement-breakpoint
ALTER TABLE `identity_requests` DROP COLUMN `attempts`;
