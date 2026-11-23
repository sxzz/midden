-- Image and video now count the media a post listed, saved or not, as
-- has_media always did; recompute them for the rows already there.
UPDATE `catalog` SET
  `has_image` = EXISTS (
    SELECT 1 FROM `revisions` r JOIN `assets` m ON m.`capture_id` = r.`capture_id`
    WHERE r.`id` = `catalog`.`revision_id` AND m.`purpose` = '' AND m.`kind` = 'image'),
  `has_video` = EXISTS (
    SELECT 1 FROM `revisions` r JOIN `assets` m ON m.`capture_id` = r.`capture_id`
    WHERE r.`id` = `catalog`.`revision_id` AND m.`purpose` = '' AND m.`kind` = 'video');
