ALTER TABLE `catalog` ADD `followers_count` integer;--> statement-breakpoint
ALTER TABLE `catalog` ADD `following_count` integer;--> statement-breakpoint
ALTER TABLE `catalog` ADD `followers_desc` integer GENERATED ALWAYS AS (coalesce(followers_count, -1)) VIRTUAL;--> statement-breakpoint
ALTER TABLE `catalog` ADD `followers_asc` integer GENERATED ALWAYS AS (coalesce(followers_count, 9007199254740991)) VIRTUAL;--> statement-breakpoint
ALTER TABLE `catalog` ADD `following_desc` integer GENERATED ALWAYS AS (coalesce(following_count, -1)) VIRTUAL;--> statement-breakpoint
ALTER TABLE `catalog` ADD `following_asc` integer GENERATED ALWAYS AS (coalesce(following_count, 9007199254740991)) VIRTUAL;--> statement-breakpoint
CREATE INDEX `catalog_followers_desc` ON `catalog` (`followers_desc`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_followers_asc` ON `catalog` (`followers_asc`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_following_desc` ON `catalog` (`following_desc`,`collection_id`);--> statement-breakpoint
CREATE INDEX `catalog_following_asc` ON `catalog` (`following_asc`,`collection_id`);