ALTER TABLE `assets` ADD `width` integer;--> statement-breakpoint
ALTER TABLE `assets` ADD `height` integer;--> statement-breakpoint
ALTER TABLE `assets` ADD `thumbnail_url` text;--> statement-breakpoint
-- Thumbnails come from the platforms with each download now, not from ffmpeg
-- renders queued per blob: drop the renders still waiting, and the pause of
-- their type.
DELETE FROM `jobs` WHERE `type` = 'thumbnail';--> statement-breakpoint
UPDATE `settings`
SET `value` = json_set(`value`, '$.types', json((
  SELECT json_group_array(t.value) FROM json_each(`settings`.`value`, '$.types') t
  WHERE t.value <> 'thumbnail'
)))
WHERE `key` = 'jobs_control' AND json_valid(`value`)
  AND json_type(`value`, '$.types') = 'array';
