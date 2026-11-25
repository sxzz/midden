-- Fill the search columns in place, the way `library/catalog.ts` derives
-- them from the newest revision (which `revision_id` already names), rather
-- than emptying the catalog. The search_* functions are registered on the
-- connection before migrations run (`db/client.ts`).
UPDATE `catalog` SET
  `search_name` = src.`name`,
  `search_text` = src.`text`,
  `search_extra` = src.`extra`
FROM (
  SELECT k.`collection_id`,
    search_names(coalesce(nullif(r.`payload` ->> 'author_name', ''),
        coalesce(av.`data`, rv.`data`) ->> 'name'),
      coalesce(av.`data`, rv.`data`) ->> 'username') AS `name`,
    CASE WHEN k.`root_kind` LIKE '%.profile' THEN ''
      ELSE search_fold(r.`payload` ->> 'text') END AS `text`,
    search_fold(concat_ws(' ',
      CASE WHEN k.`root_kind` LIKE '%.profile' THEN coalesce(
        rv.`data` -> 'metadata' ->> 'description', r.`payload` ->> 'text') END,
      (SELECT group_concat(m.`alt_text`, ' ') FROM `assets` m
        WHERE m.`capture_id` = r.`capture_id` AND m.`purpose` = ''
          AND m.`alt_text` <> ''))) AS `extra`
  FROM `catalog` k
  JOIN `revisions` r ON r.`id` = k.`revision_id`
  LEFT JOIN `revision_entities` root ON root.`revision_id` = r.`id` AND root.`is_root` = 1
  LEFT JOIN `entity_versions` rv ON rv.`id` = root.`entity_version_id`
  LEFT JOIN `revision_entities` author ON author.`revision_id` = r.`id`
    AND author.`entity_key` = (
      SELECT min(edge.`target_key`) FROM `entity_relations` edge
      WHERE edge.`revision_id` = r.`id` AND edge.`source_key` = root.`entity_key`
        AND edge.`kind` = 'authored_by')
  LEFT JOIN `entity_versions` av ON av.`id` = author.`entity_version_id`
) src
WHERE `catalog`.`collection_id` = src.`collection_id`;
--> statement-breakpoint
-- Then what the quoted and reposted posts say, which reads their names and
-- text filled above.
UPDATE `catalog` SET `search_quoted` = src.`quoted`
FROM (
  SELECT k.`collection_id`, search_fold(group_concat(coalesce(
      (SELECT quoted.`search_name` || ' ' || quoted.`search_text` FROM `catalog` quoted
        WHERE quoted.`root_entity_id` = tv.`entity_id`
        ORDER BY quoted.`revision_at` DESC, quoted.`collection_id` LIMIT 1),
      tv.`data` ->> 'text'), ' ')) AS `quoted`
  FROM `catalog` k
  JOIN `revision_entities` root ON root.`revision_id` = k.`revision_id` AND root.`is_root` = 1
  JOIN `entity_relations` edge ON edge.`revision_id` = k.`revision_id`
    AND edge.`source_key` = root.`entity_key` AND edge.`kind` IN ('quoted', 'reposted')
  JOIN `revision_entities` target ON target.`revision_id` = edge.`revision_id`
    AND target.`entity_key` = edge.`target_key`
  JOIN `entity_versions` tv ON tv.`id` = target.`entity_version_id`
  WHERE k.`root_kind` NOT LIKE '%.profile'
  GROUP BY k.`collection_id`
) src
WHERE `catalog`.`collection_id` = src.`collection_id` AND src.`quoted` <> '';
--> statement-breakpoint
-- The search indexes, by the catalog's rowid: trigrams of the folded columns,
-- and the CJK characters and pairs of adjacent ones in them as words
-- (`library/search-text.ts`). Contentless, so the text lives only in the
-- catalog; `contentless_delete` lets a row go by its rowid alone. Most
-- entries are the text's, and an entry in the first column is two bytes
-- shorter, so the text comes first.
CREATE VIRTUAL TABLE `catalog_fts` USING fts5(
  `text`, `name`, `quoted`, `extra`,
  tokenize = 'trigram', content = '', contentless_delete = 1
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `catalog_cjk` USING fts5(
  `text`, `name`, `quoted`, `extra`,
  tokenize = 'unicode61 remove_diacritics 0', detail = 'column',
  content = '', contentless_delete = 1
);
--> statement-breakpoint
-- How many rows hold each term: a fuzzy search starts from the rarest.
CREATE VIRTUAL TABLE `catalog_fts_terms` USING fts5vocab(`catalog_fts`, 'row');
--> statement-breakpoint
CREATE VIRTUAL TABLE `catalog_cjk_terms` USING fts5vocab(`catalog_cjk`, 'row');
--> statement-breakpoint
INSERT INTO `catalog_fts` (`rowid`, `text`, `name`, `quoted`, `extra`)
SELECT `rowid`, `search_text`, `search_name`, `search_quoted`, `search_extra`
FROM `catalog`;
--> statement-breakpoint
INSERT INTO `catalog_cjk` (`rowid`, `text`, `name`, `quoted`, `extra`)
SELECT `rowid`, search_words(`search_text`), search_words(`search_name`),
  search_words(`search_quoted`), search_words(`search_extra`)
FROM `catalog`;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_insert` AFTER INSERT ON `catalog` BEGIN
  INSERT INTO `catalog_fts` (`rowid`, `text`, `name`, `quoted`, `extra`)
  VALUES (new.`rowid`, new.`search_text`, new.`search_name`,
    new.`search_quoted`, new.`search_extra`);
  INSERT INTO `catalog_cjk` (`rowid`, `text`, `name`, `quoted`, `extra`)
  VALUES (new.`rowid`, search_words(new.`search_text`),
    search_words(new.`search_name`), search_words(new.`search_quoted`),
    search_words(new.`search_extra`));
END;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_update`
AFTER UPDATE OF `search_name`, `search_text`, `search_quoted`, `search_extra` ON `catalog`
WHEN old.`search_name` IS NOT new.`search_name`
  OR old.`search_text` IS NOT new.`search_text`
  OR old.`search_quoted` IS NOT new.`search_quoted`
  OR old.`search_extra` IS NOT new.`search_extra`
BEGIN
  DELETE FROM `catalog_fts` WHERE `rowid` = old.`rowid`;
  DELETE FROM `catalog_cjk` WHERE `rowid` = old.`rowid`;
  INSERT INTO `catalog_fts` (`rowid`, `text`, `name`, `quoted`, `extra`)
  VALUES (new.`rowid`, new.`search_text`, new.`search_name`,
    new.`search_quoted`, new.`search_extra`);
  INSERT INTO `catalog_cjk` (`rowid`, `text`, `name`, `quoted`, `extra`)
  VALUES (new.`rowid`, search_words(new.`search_text`),
    search_words(new.`search_name`), search_words(new.`search_quoted`),
    search_words(new.`search_extra`));
END;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_delete` AFTER DELETE ON `catalog` BEGIN
  DELETE FROM `catalog_fts` WHERE `rowid` = old.`rowid`;
  DELETE FROM `catalog_cjk` WHERE `rowid` = old.`rowid`;
END;
