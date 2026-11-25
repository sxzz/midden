CREATE TABLE `capture_metrics` (
	`capture_id` text PRIMARY KEY,
	`metrics` text NOT NULL,
	CONSTRAINT `fk_capture_metrics_capture_id_captures_id_fk` FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `capture_staging` (
	`capture_id` text PRIMARY KEY,
	`prefetch` blob,
	`payload` text,
	`target_prefetch` text,
	CONSTRAINT `fk_capture_staging_capture_id_captures_id_fk` FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `capture_targets` (
	`capture_id` text PRIMARY KEY,
	`targets` text NOT NULL,
	CONSTRAINT `fk_capture_targets_capture_id_captures_id_fk` FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- What a capture listed, without the prefetches: those only serve until the
-- targets are submitted.
INSERT INTO `capture_targets` (`capture_id`, `targets`)
SELECT `c`.`id`, (SELECT json_group_array(json_remove(`t`.`value`, '$.prefetch') ORDER BY `t`.`key`)
	FROM json_each(`c`.`related_targets`) `t`)
FROM `captures` `c` WHERE json_array_length(`c`.`related_targets`) > 0;--> statement-breakpoint
INSERT INTO `capture_metrics` (`capture_id`, `metrics`)
SELECT `id`, `metrics` FROM `captures` WHERE `metrics` IS NOT NULL;--> statement-breakpoint
-- Captures still running keep what they staged, and listings whose targets
-- are yet to be submitted their prefetches.
INSERT INTO `capture_staging` (`capture_id`, `prefetch`, `payload`, `target_prefetch`)
SELECT `id`, `prefetch`, `payload`, `target_prefetch` FROM (
	SELECT `c`.`id`, `c`.`prefetch`, `c`.`payload`,
		CASE WHEN `c`.`related_targets` LIKE '%"prefetch"%' AND EXISTS (
			SELECT 1 FROM `submissions` `s`
			WHERE `s`.`capture_id` = `c`.`id` AND `s`.`related_state` = 'pending'
		) THEN (SELECT json_group_array(`t`.`value` ->> '$.prefetch' ORDER BY `t`.`key`)
			FROM json_each(`c`.`related_targets`) `t`) END AS `target_prefetch`
	FROM `captures` `c`
	WHERE `c`.`prefetch` IS NOT NULL OR `c`.`payload` IS NOT NULL
		OR `c`.`related_targets` LIKE '%"prefetch"%'
) WHERE `prefetch` IS NOT NULL OR `payload` IS NOT NULL OR `target_prefetch` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `captures` DROP COLUMN `payload`;--> statement-breakpoint
ALTER TABLE `captures` DROP COLUMN `related_targets`;--> statement-breakpoint
ALTER TABLE `captures` DROP COLUMN `prefetch`;--> statement-breakpoint
ALTER TABLE `captures` DROP COLUMN `metrics`;--> statement-breakpoint
-- Dropping the columns rewrote each row in place, leaving pages mostly
-- empty. Moving every row past the last one (a new rowid; nothing refers
-- to it) packs them at the end and frees the old pages, which maintenance
-- hands back with incremental_vacuum. No VACUUM: Litestream (see db/client.ts).
UPDATE `captures` SET `rowid` = `rowid` + (SELECT max(`rowid`) FROM `captures`);
