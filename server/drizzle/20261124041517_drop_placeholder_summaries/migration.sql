-- Summaries no longer stand in an author or text a post lacks ("未知作者",
-- "Instagram", "图片或视频"); drop the ones already stored, then refresh the
-- search text built from them.
UPDATE `revisions` SET `payload` = json_set(`payload`, '$.summary', substr(`revisions`.`payload` ->> '$.summary', 6))
  WHERE `revisions`.`payload` ->> '$.summary' LIKE '未知作者：%' AND coalesce(`revisions`.`payload` ->> '$.author_name', '') = '';
--> statement-breakpoint
UPDATE `revisions` SET `payload` = json_set(`payload`, '$.summary', substr(`revisions`.`payload` ->> '$.summary', 11))
  WHERE `revisions`.`payload` ->> '$.summary' LIKE 'Instagram：%' AND coalesce(`revisions`.`payload` ->> '$.author_name', '') = '';
--> statement-breakpoint
UPDATE `revisions` SET `payload` = json_set(`payload`, '$.summary',
    CASE WHEN `revisions`.`payload` ->> '$.summary' = '图片或视频' THEN ''
      ELSE substr(`revisions`.`payload` ->> '$.summary', 1, length(`revisions`.`payload` ->> '$.summary') - 6) END)
  WHERE (`revisions`.`payload` ->> '$.summary' = '图片或视频' OR `revisions`.`payload` ->> '$.summary' LIKE '%：图片或视频') AND coalesce(`revisions`.`payload` ->> '$.text', '') = '';
--> statement-breakpoint
UPDATE `captures` SET `payload` = json_set(`payload`, '$.summary', substr(`captures`.`payload` ->> '$.summary', 6))
  WHERE `captures`.`payload` ->> '$.summary' LIKE '未知作者：%' AND coalesce(`captures`.`payload` ->> '$.author_name', '') = '';
--> statement-breakpoint
UPDATE `captures` SET `payload` = json_set(`payload`, '$.summary', substr(`captures`.`payload` ->> '$.summary', 11))
  WHERE `captures`.`payload` ->> '$.summary' LIKE 'Instagram：%' AND coalesce(`captures`.`payload` ->> '$.author_name', '') = '';
--> statement-breakpoint
UPDATE `captures` SET `payload` = json_set(`payload`, '$.summary',
    CASE WHEN `captures`.`payload` ->> '$.summary' = '图片或视频' THEN ''
      ELSE substr(`captures`.`payload` ->> '$.summary', 1, length(`captures`.`payload` ->> '$.summary') - 6) END)
  WHERE (`captures`.`payload` ->> '$.summary' = '图片或视频' OR `captures`.`payload` ->> '$.summary' LIKE '%：图片或视频') AND coalesce(`captures`.`payload` ->> '$.text', '') = '';
--> statement-breakpoint
UPDATE `catalog` SET `search` = (
    SELECT concat_ws(' ', r.`payload` ->> 'text', r.`payload` ->> 'summary', r.`payload` ->> 'author_name')
    FROM `revisions` r WHERE r.`id` = `catalog`.`revision_id`)
  WHERE `search` LIKE '%图片或视频%' OR `search` LIKE '%未知作者%' OR `search` LIKE '%Instagram：%';
