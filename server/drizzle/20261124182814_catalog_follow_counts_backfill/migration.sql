-- Fill the new count columns in place rather than emptying the catalog: only
-- accounts can have them, and they are a small part of the rows. The same
-- derivation as `library/catalog.ts`: the root's own counts in the newest
-- capture with any, whole numbers >= 0 only.
UPDATE `catalog` SET (`followers_count`, `following_count`) = (
    SELECT CASE WHEN typeof(f) = 'integer' AND f >= 0 THEN f END,
      CASE WHEN typeof(g) = 'integer' AND g >= 0 THEN g END
    FROM (
      SELECT own ->> '/metadata/followers' AS f, own ->> '/metadata/following' AS g
      FROM (
        SELECT (SELECT cp.`metrics` FROM `captures` cp
            WHERE cp.`collection_id` = `catalog`.`collection_id` AND cp.`metrics` IS NOT NULL
              AND cp.`state` IN ('complete', 'partial')
            ORDER BY cp.`finished_at` DESC, cp.`id` DESC LIMIT 1)
          -> (e.`kind` || '/' || e.`external_id`) AS own
        FROM `entities` e WHERE e.`id` = `catalog`.`root_entity_id`)))
  WHERE `root_kind` LIKE '%.profile';
