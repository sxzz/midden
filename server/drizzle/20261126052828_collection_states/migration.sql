CREATE TABLE `collection_states` (
	`id` text PRIMARY KEY,
	`collection_id` text NOT NULL,
	`state` text NOT NULL,
	`since` integer NOT NULL,
	`confirmed_at` integer,
	`seen_at` integer NOT NULL,
	`ended_at` integer,
	CONSTRAINT `fk_collection_states_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `collection_states_collection` ON `collection_states` (`collection_id`,`since`);--> statement-breakpoint
CREATE INDEX `collections_source_state` ON `collections` (`source_state`) WHERE "collections"."source_state" IS NOT NULL;--> statement-breakpoint
-- States marked before they needed a second answer stand as confirmed, under
-- the collection's own id (one each); the next normal capture ends them.
UPDATE `collections` SET `source_state_at` = `observed_at`
WHERE `source_state` IS NOT NULL AND `source_state_at` IS NULL;--> statement-breakpoint
INSERT INTO `collection_states` (`id`, `collection_id`, `state`, `since`, `confirmed_at`, `seen_at`)
SELECT `id`, `id`, `source_state`, `source_state_at`, `source_state_at`, `source_state_at`
FROM `collections` WHERE `source_state` IS NOT NULL;