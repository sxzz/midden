CREATE INDEX `entity_versions_username` ON `entity_versions` (lower("data" ->> '$.username')) WHERE "entity_versions"."data" ->> '$.username' IS NOT NULL;
--> statement-breakpoint
-- X profiles saved by their handle (`handle:<lower case>`) whose account id
-- is known take that id, as a capture now does (`capture/scope.ts`): the id
-- their current version shows, or, without one (a version rooted at an
-- account known by handle only shows none), that of the one account whose
-- newest stored version (a follow list, a post's author) goes by the
-- handle. FxTwitter's lookups by handle fail for some existing accounts;
-- by id they do not. Skipped: an id another collection already has (the
-- next capture by id moves there, and an empty handle collection leaves the
-- library), and all but the oldest of several handles of one account.
CREATE TEMP TABLE `handle_profile_ids` AS
WITH `handles` AS (
  SELECT c.`id`, c.`external_id` AS `handle`, c.`created_at`,
    coalesce(
      (SELECT e.`external_id` FROM `revision_entities` re
        JOIN `entity_versions` v ON v.`id` = re.`entity_version_id`
        JOIN `entities` e ON e.`id` = v.`entity_id`
        WHERE re.`revision_id` = c.`current_revision` AND re.`is_root` = 1
          AND e.`external_id` NOT LIKE 'handle:%'),
      (
        SELECT CASE WHEN count(DISTINCT e.`external_id`) = 1
          THEN min(e.`external_id`) END
        FROM `entity_versions` v
        JOIN `entities` e ON e.`id` = v.`entity_id`
        WHERE lower(v.`data` ->> '$.username') = substr(c.`external_id`, 8)
          AND v.`data` ->> '$.username' IS NOT NULL
          AND e.`platform` = 'x' AND e.`kind` = 'x.profile'
          AND e.`external_id` NOT LIKE 'handle:%'
          AND NOT EXISTS (
            SELECT 1 FROM `entity_versions` n WHERE n.`entity_id` = v.`entity_id`
              AND (n.`created_at` > v.`created_at`
                OR (n.`created_at` = v.`created_at` AND n.`id` > v.`id`))))
      ) AS `account`
  FROM `collections` c
  WHERE c.`platform` = 'x' AND c.`kind` = 'profile' AND c.`object_scope` = ''
    AND c.`external_id` LIKE 'handle:%'
),
`ranked` AS (
  SELECT *, row_number() OVER (
    PARTITION BY `account` ORDER BY `created_at`, `id`) AS `n`
  FROM `handles`
  WHERE `account` GLOB '[0-9]*' AND `account` NOT GLOB '*[^0-9]*'
)
SELECT `id`, `handle`, `account` FROM `ranked`
WHERE `n` = 1 AND NOT EXISTS (
  SELECT 1 FROM `collections` t
  WHERE t.`platform` = 'x' AND t.`kind` = 'profile' AND t.`object_scope` = ''
    AND t.`external_id` = `ranked`.`account`);
--> statement-breakpoint
UPDATE `collections` SET
  `external_id` = (SELECT h.`account` FROM `handle_profile_ids` h WHERE h.`id` = `collections`.`id`),
  `url` = 'https://x.com/i/user/' || (SELECT h.`account` FROM `handle_profile_ids` h WHERE h.`id` = `collections`.`id`)
WHERE `id` IN (SELECT `id` FROM `handle_profile_ids`);
--> statement-breakpoint
INSERT INTO `collection_identity_aliases` (`platform`, `kind`, `object_scope`, `external_id`, `collection_id`)
SELECT 'x', 'profile', '', `handle`, `id` FROM `handle_profile_ids` WHERE true
ON CONFLICT DO UPDATE SET `collection_id` = excluded.`collection_id`;
--> statement-breakpoint
DROP TABLE `handle_profile_ids`;
