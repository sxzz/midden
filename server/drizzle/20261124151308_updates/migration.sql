CREATE TABLE `updates` (
	`id` text PRIMARY KEY,
	`target` text NOT NULL,
	`target_id` text DEFAULT '' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`collection_ids` text NOT NULL,
	`posts` text DEFAULT 'latest' NOT NULL,
	`relations` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`idem_key` text UNIQUE,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `submissions` ADD `update_id` text;--> statement-breakpoint
CREATE INDEX `submissions_update` ON `submissions` (`update_id`) WHERE "submissions"."update_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `updates_created` ON `updates` (`created_at`,`id`);--> statement-breakpoint
DROP TABLE `refresh_batches`;--> statement-breakpoint
-- Batches gave way to updates; their pending jobs have no handler left.
DELETE FROM `jobs` WHERE `type` = 'refresh_batch';
