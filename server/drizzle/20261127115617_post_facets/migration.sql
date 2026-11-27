-- Hashtags, mentioned handles and link domains of each catalogued item, and
-- the language of its text (`library/facets.ts`), for the query language and
-- aggregation. WITHOUT ROWID: the primary key (value first) is the table, so
-- a row is written to two b-trees (it and the catalog id index), not three.
-- Existing rows are filled by maintenance, a batch at a time while the worker
-- is idle; no trigger moves `library_version` for them (see facets.ts).
CREATE TABLE `post_domains` (
	`catalog_id` integer NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `post_domains_pk` PRIMARY KEY(`value`, `catalog_id`),
	CONSTRAINT `fk_post_domains_catalog_id_catalog_id_fk` FOREIGN KEY (`catalog_id`) REFERENCES `catalog`(`id`) ON DELETE CASCADE
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `post_hashtags` (
	`catalog_id` integer NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `post_hashtags_pk` PRIMARY KEY(`value`, `catalog_id`),
	CONSTRAINT `fk_post_hashtags_catalog_id_catalog_id_fk` FOREIGN KEY (`catalog_id`) REFERENCES `catalog`(`id`) ON DELETE CASCADE
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `post_mentions` (
	`catalog_id` integer NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `post_mentions_pk` PRIMARY KEY(`value`, `catalog_id`),
	CONSTRAINT `fk_post_mentions_catalog_id_catalog_id_fk` FOREIGN KEY (`catalog_id`) REFERENCES `catalog`(`id`) ON DELETE CASCADE
) WITHOUT ROWID;
--> statement-breakpoint
ALTER TABLE `catalog` ADD `lang` text;--> statement-breakpoint
CREATE INDEX `post_domains_catalog` ON `post_domains` (`catalog_id`);--> statement-breakpoint
CREATE INDEX `post_hashtags_catalog` ON `post_hashtags` (`catalog_id`);--> statement-breakpoint
CREATE INDEX `post_mentions_catalog` ON `post_mentions` (`catalog_id`);