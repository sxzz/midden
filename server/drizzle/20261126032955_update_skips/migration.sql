CREATE TABLE `update_skips` (
	`update_id` text NOT NULL,
	`position` integer NOT NULL,
	`collection_id` text NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `update_skips_pk` PRIMARY KEY(`update_id`, `position`),
	CONSTRAINT `fk_update_skips_update_id_updates_id_fk` FOREIGN KEY (`update_id`) REFERENCES `updates`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- Items skipped before they were recorded: the positions an update passed
-- without submitting them. One gone from the library since was removed;
-- why any other was skipped was not kept.
INSERT INTO `update_skips` (`update_id`, `position`, `collection_id`, `url`, `reason`, `created_at`)
SELECT u.`id`, CAST(j.`key` AS INTEGER), j.`value`, coalesce(c.`url`, ''),
  CASE WHEN l.`collection_id` IS NULL THEN 'removed' ELSE 'unknown' END,
  u.`created_at`
FROM `updates` u, json_each(u.`collection_ids`) j
LEFT JOIN `collections` c ON c.`id` = j.`value`
LEFT JOIN `library` l ON l.`collection_id` = j.`value`
WHERE u.`skipped` > 0 AND CAST(j.`key` AS INTEGER) < u.`position`
  AND NOT EXISTS (
    SELECT 1 FROM `submissions` s
    WHERE s.`idem_key` = 'update:' || u.`id` || ':' || j.`key`
  );
