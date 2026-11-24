ALTER TABLE `updates` ADD `options` text NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE `updates` ADD `older` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `updates` SET
	`older` = (`posts` = 'older'),
	`options` = json_patch(
		json_object(
			'posts', CASE `posts` WHEN 'none' THEN 'none' WHEN 'until_existing' THEN 'until_existing' ELSE 'latest' END,
			'mediaOnly', json('false'),
			'includeShared', json('true'),
			'captureReferences', json('true'),
			'relations', json(iif(`relations`, 'true', 'false'))
		),
		json_object('count', CASE WHEN `posts` IN ('latest', 'older') THEN 100 END)
	);--> statement-breakpoint
ALTER TABLE `updates` DROP COLUMN `posts`;--> statement-breakpoint
ALTER TABLE `updates` DROP COLUMN `relations`;--> statement-breakpoint
UPDATE `submissions` SET `capture_options` = json_patch(
	json_object(
		'posts', CASE
			WHEN `capture_options` ->> '$.skipPosts' THEN 'none'
			WHEN `capture_options` ->> '$.untilExisting' OR `capture_options` ->> '$.finalPage' THEN 'until_existing'
			ELSE 'max'
		END,
		'mediaOnly', json(iif(coalesce(`capture_options` ->> '$.mediaOnly', 0), 'true', 'false')),
		'includeShared', json(iif(coalesce(`capture_options` ->> '$.omitShared', 0), 'false', 'true')),
		'captureReferences', json(iif(coalesce(`capture_options` ->> '$.skipReferences', 0), 'false', 'true')),
		'relations', json(iif(EXISTS (SELECT 1 FROM `relation_fetches` `f` WHERE `f`.`submission_id` = `submissions`.`id`), 'true', 'false'))
	),
	json_object(
		'count', CASE
			WHEN coalesce(`capture_options` ->> '$.skipPosts', 0) = 0
				AND coalesce(`capture_options` ->> '$.untilExisting', 0) = 0
				AND coalesce(`capture_options` ->> '$.finalPage', 0) = 0
				AND `capture_options` ->> '$.maxPosts' > 0
			THEN `capture_options` ->> '$.maxPosts'
		END,
		'since', `capture_options` ->> '$.since',
		'finalPage', CASE WHEN `capture_options` ->> '$.finalPage' THEN json('true') END
	)
)
WHERE `capture_options` IS NOT NULL AND `capture_options` ->> '$.posts' IS NULL;
