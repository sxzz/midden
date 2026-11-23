CREATE TABLE `account_credentials` (
	`id` text PRIMARY KEY,
	`ciphertext` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `account_selections` (
	`adapter_id` text PRIMARY KEY,
	`connection_id` text
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY,
	`capture_id` text NOT NULL,
	`position` integer NOT NULL,
	`source_url` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`alt_text` text DEFAULT '' NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`cache_key` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`blob_id` text,
	CONSTRAINT `fk_assets_capture_id_captures_id_fk` FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_assets_blob_id_blobs_id_fk` FOREIGN KEY (`blob_id`) REFERENCES `blobs`(`id`)
);
--> statement-breakpoint
CREATE TABLE `blob_thumbnails` (
	`blob_id` text PRIMARY KEY,
	`state` text NOT NULL,
	`key` text,
	`size` integer,
	`mime` text,
	`error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_blob_thumbnails_blob_id_blobs_id_fk` FOREIGN KEY (`blob_id`) REFERENCES `blobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `blobs` (
	`id` text PRIMARY KEY,
	`hash` text NOT NULL UNIQUE,
	`size` integer NOT NULL,
	`mime` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `captures` (
	`id` text PRIMARY KEY,
	`collection_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`adapter_id` text NOT NULL,
	`connection_id` text,
	`credential_revision` integer,
	`refresh_from` text,
	`scope` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`payload` text,
	`adapter_version` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`revision_id` text,
	`automatic` integer DEFAULT false NOT NULL,
	`related_targets` text DEFAULT '[]' NOT NULL,
	`page_size` integer DEFAULT 0 NOT NULL,
	`page_cursor` text DEFAULT '' NOT NULL,
	`next_page_cursor` text DEFAULT '' NOT NULL,
	`is_collection` integer DEFAULT false NOT NULL,
	`max_batch_size` integer DEFAULT 0 NOT NULL,
	`prefetch` blob,
	`metrics` text,
	CONSTRAINT `fk_captures_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`)
);
--> statement-breakpoint
CREATE TABLE `collection_identity_aliases` (
	`platform` text NOT NULL,
	`kind` text NOT NULL,
	`object_scope` text NOT NULL,
	`external_id` text NOT NULL,
	`collection_id` text NOT NULL,
	CONSTRAINT `collection_identity_aliases_pk` PRIMARY KEY(`platform`, `kind`, `object_scope`, `external_id`),
	CONSTRAINT `fk_collection_identity_aliases_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `collection_tags` (
	`collection_id` text NOT NULL,
	`tag_id` text NOT NULL,
	CONSTRAINT `collection_tags_pk` PRIMARY KEY(`collection_id`, `tag_id`),
	CONSTRAINT `fk_collection_tags_collection_id_library_collection_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `library`(`collection_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_collection_tags_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY,
	`platform` text NOT NULL,
	`kind` text NOT NULL,
	`object_scope` text DEFAULT '' NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`provider_id` text NOT NULL,
	`current_revision` text,
	`unreferenced_at` integer,
	`created_at` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`source_state` text,
	`source_state_at` integer
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY,
	`adapter_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`name` text NOT NULL,
	`account_id` text,
	`username` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`credential_ref` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY,
	`platform` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`observed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entity_relations` (
	`revision_id` text NOT NULL,
	`source_key` text NOT NULL,
	`target_key` text NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `entity_relations_pk` PRIMARY KEY(`revision_id`, `source_key`, `kind`, `target_key`),
	CONSTRAINT `fk_entity_relations_revision_id_revisions_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `revisions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `entity_versions` (
	`id` text PRIMARY KEY,
	`entity_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`data` text NOT NULL,
	`schema` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_entity_versions_entity_id_entities_id_fk` FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`type` text NOT NULL,
	`ref` text NOT NULL,
	`queue` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'available' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`run_at` integer NOT NULL,
	`lease_until` integer,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `library` (
	`collection_id` text PRIMARY KEY,
	`provider_id` text NOT NULL,
	`connection_id` text,
	`adapter_id` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_library_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `media_garbage` (
	`key` text PRIMARY KEY,
	`since` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer
);
--> statement-breakpoint
CREATE TABLE `refresh_batches` (
	`id` text PRIMARY KEY,
	`collection_ids` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`reused` integer DEFAULT 0 NOT NULL,
	`rejected` integer DEFAULT 0 NOT NULL,
	`capture_ids` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `revision_entities` (
	`revision_id` text NOT NULL,
	`entity_key` text NOT NULL,
	`entity_version_id` text NOT NULL,
	`is_root` integer NOT NULL,
	CONSTRAINT `revision_entities_pk` PRIMARY KEY(`revision_id`, `entity_key`),
	CONSTRAINT `fk_revision_entities_revision_id_revisions_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `revisions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_revision_entities_entity_version_id_entity_versions_id_fk` FOREIGN KEY (`entity_version_id`) REFERENCES `entity_versions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY,
	`collection_id` text NOT NULL,
	`capture_id` text NOT NULL UNIQUE,
	`content_hash` text NOT NULL,
	`payload` text NOT NULL,
	`content_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_revisions_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`),
	CONSTRAINT `fk_revisions_capture_id_captures_id_fk` FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`)
);
--> statement-breakpoint
CREATE TABLE `source_responses` (
	`id` text PRIMARY KEY,
	`capture_id` text NOT NULL,
	`position` integer NOT NULL,
	`body` blob NOT NULL,
	`content_type` text NOT NULL,
	`source_url` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_source_responses_capture_id_captures_id_fk` FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` text PRIMARY KEY,
	`capture_id` text NOT NULL,
	`idem_key` text NOT NULL UNIQUE,
	`fingerprint` text NOT NULL,
	`input` text NOT NULL,
	`created_at` integer NOT NULL,
	`related_provider` text DEFAULT '' NOT NULL,
	`related_connection` text,
	`related_adapter` text DEFAULT '' NOT NULL,
	`related_source_collection` text,
	`related_state` text DEFAULT 'none' NOT NULL,
	`related_error` text DEFAULT '' NOT NULL,
	`collection_limit` integer DEFAULT 0 NOT NULL,
	`next_submission` text,
	`collection_stopped` integer DEFAULT false NOT NULL,
	`parent_submission` text,
	`capture_options` text,
	CONSTRAINT `fk_submissions_capture_id_captures_id_fk` FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_position` ON `assets` (`capture_id`,`position`);--> statement-breakpoint
CREATE INDEX `assets_cache` ON `assets` (`cache_key`) WHERE "assets"."state" = 'ready' AND "assets"."cache_key" <> '';--> statement-breakpoint
CREATE INDEX `assets_blob` ON `assets` (`blob_id`);--> statement-breakpoint
CREATE INDEX `captures_collection` ON `captures` (`collection_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `captures_one_active` ON `captures` (`collection_id`,`adapter_id`,`provider_id`,coalesce("connection_id", ''),`page_cursor`,`page_size`,`automatic`) WHERE "captures"."state" IN ('queued', 'downloading');--> statement-breakpoint
CREATE INDEX `captures_active` ON `captures` (`state`,`created_at`) WHERE "captures"."state" IN ('queued', 'downloading');--> statement-breakpoint
CREATE INDEX `collection_identity_aliases_collection` ON `collection_identity_aliases` (`collection_id`);--> statement-breakpoint
CREATE INDEX `collection_tags_tag` ON `collection_tags` (`tag_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `collections_identity` ON `collections` (`platform`,`kind`,`object_scope`,`external_id`);--> statement-breakpoint
CREATE INDEX `collections_unreferenced` ON `collections` (`unreferenced_at`) WHERE "collections"."unreferenced_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `connections_account` ON `connections` (`adapter_id`,`provider_id`,`account_id`) WHERE "connections"."state" <> 'revoked' AND "connections"."account_id" IS NOT NULL AND "connections"."account_id" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX `entities_identity` ON `entities` (`platform`,`kind`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `entity_versions_content` ON `entity_versions` (`entity_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `jobs_claim` ON `jobs` (`queue`,`state`,`priority`,`run_at`);--> statement-breakpoint
CREATE INDEX `jobs_ref` ON `jobs` (`ref`);--> statement-breakpoint
CREATE INDEX `library_created` ON `library` (`created_at`,`collection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `revision_entities_root` ON `revision_entities` (`revision_id`) WHERE "revision_entities"."is_root" = 1;--> statement-breakpoint
CREATE INDEX `revision_entities_version` ON `revision_entities` (`entity_version_id`);--> statement-breakpoint
CREATE INDEX `revisions_head` ON `revisions` (`collection_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_responses_position` ON `source_responses` (`capture_id`,`position`);--> statement-breakpoint
CREATE INDEX `submissions_records` ON `submissions` (`created_at`,`id`) WHERE "submissions"."parent_submission" IS NULL AND "submissions"."input" <> '';--> statement-breakpoint
CREATE INDEX `submissions_capture` ON `submissions` (`capture_id`);--> statement-breakpoint
CREATE INDEX `submissions_parent` ON `submissions` (`parent_submission`);--> statement-breakpoint
CREATE INDEX `submissions_next` ON `submissions` (`next_submission`);