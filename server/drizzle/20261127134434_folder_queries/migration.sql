-- Folders keep a query of the query language instead of a list filter.
-- `folder_query` (registered on every connection by `db/client.ts`, from
-- `query/convert.ts`) writes each filter as the query that says exactly
-- what it said, with its order and the zone of its relative dates; tags
-- stay named by id. The counts kept by filter are counted again: their key
-- is the query now. A connection without the function (the sqlite3 shell)
-- cannot run this.
ALTER TABLE `folders` ADD `query` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `folders` ADD `sort` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `folders` ADD `order` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `folders` ADD `tz` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `folders` SET (`query`, `sort`, `order`, `tz`) = (
  SELECT q ->> 'query', q ->> 'sort', q ->> 'order', q ->> 'tz'
  FROM (SELECT folder_query(`filter`) AS q)
);--> statement-breakpoint
ALTER TABLE `folders` DROP COLUMN `filter`;
