CREATE TABLE `catalog` (
	`collection_id` text PRIMARY KEY,
	`revision_id` text NOT NULL,
	`revision_at` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`published_at` integer NOT NULL,
	`storage_bytes` integer NOT NULL,
	`root_entity_id` text,
	`root_kind` text,
	`author_entity_id` text,
	`author_name` text NOT NULL,
	`subject_entity_id` text,
	`subject_protected` integer,
	`has_media` integer NOT NULL,
	`has_image` integer NOT NULL,
	`has_video` integer NOT NULL,
	`has_sensitive` integer NOT NULL,
	`quotes` integer NOT NULL,
	`search` text NOT NULL,
	CONSTRAINT `fk_catalog_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `catalog_observed` ON `catalog` (`observed_at`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_published` ON `catalog` (`published_at`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_storage` ON `catalog` (`storage_bytes`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_root` ON `catalog` (`root_entity_id`);--> statement-breakpoint
CREATE INDEX `catalog_author` ON `catalog` (`author_entity_id`,`author_name`,`revision_at`,`revision_id`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_subject` ON `catalog` (`subject_entity_id`,`revision_at`,`revision_id`);--> statement-breakpoint
CREATE INDEX `entity_relations_kind` ON `entity_relations` (`kind`,`revision_id`);