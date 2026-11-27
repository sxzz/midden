CREATE TABLE `identity_requests` (
	`id` text PRIMARY KEY,
	`idem_key` text NOT NULL UNIQUE,
	`adapter_id` text NOT NULL,
	`url` text NOT NULL,
	`handle` text NOT NULL,
	`input` text NOT NULL,
	`request` text NOT NULL,
	`parent_submission` text,
	`update_id` text,
	`collection_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `identity_requests_records` ON `identity_requests` (`created_at`,`id`) WHERE "identity_requests"."parent_submission" IS NULL AND "identity_requests"."input" <> '';--> statement-breakpoint
CREATE INDEX `identity_requests_collection` ON `identity_requests` (`collection_id`) WHERE "identity_requests"."collection_id" IS NOT NULL;