CREATE TABLE `raw_garbage` (
	`key` text PRIMARY KEY,
	`since` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer
);
--> statement-breakpoint
ALTER TABLE `source_responses` ADD `remote_at` integer;--> statement-breakpoint
CREATE INDEX `source_responses_sha256` ON `source_responses` (`sha256`,`remote_at`);