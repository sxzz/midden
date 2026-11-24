CREATE TABLE `follow_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`follower_id` text NOT NULL,
	`followee_id` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`ended_at` integer,
	CONSTRAINT `fk_follow_edges_follower_id_entities_id_fk` FOREIGN KEY (`follower_id`) REFERENCES `entities`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_follow_edges_followee_id_entities_id_fk` FOREIGN KEY (`followee_id`) REFERENCES `entities`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `relation_fetches` (
	`id` text PRIMARY KEY,
	`submission_id` text,
	`list` text NOT NULL,
	`entity_id` text,
	`state` text DEFAULT 'waiting' NOT NULL,
	`expected` integer,
	`fetched` integer DEFAULT 0 NOT NULL,
	`pages` integer DEFAULT 0 NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`provider_id` text,
	`connection_id` text,
	`error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT `fk_relation_fetches_submission_id_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_relation_fetches_entity_id_entities_id_fk` FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `follow_edges_open` ON `follow_edges` (`follower_id`,`followee_id`) WHERE "follow_edges"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `follow_edges_follower` ON `follow_edges` (`follower_id`,`ended_at`,`followee_id`);--> statement-breakpoint
CREATE INDEX `follow_edges_followee` ON `follow_edges` (`followee_id`,`ended_at`,`follower_id`);--> statement-breakpoint
CREATE INDEX `relation_fetches_submission` ON `relation_fetches` (`submission_id`);--> statement-breakpoint
CREATE INDEX `relation_fetches_complete` ON `relation_fetches` (`entity_id`,`list`,`finished_at`) WHERE "relation_fetches"."state" = 'complete';