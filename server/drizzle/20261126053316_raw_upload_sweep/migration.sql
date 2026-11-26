CREATE TABLE `raw_upload_failures` (
	`response_id` text PRIMARY KEY,
	`failures` integer NOT NULL,
	`retry_at` integer,
	`error` text NOT NULL,
	CONSTRAINT `fk_raw_upload_failures_response_id_source_responses_id_fk` FOREIGN KEY (`response_id`) REFERENCES `source_responses`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `source_responses_local` ON `source_responses` (`created_at`,`capture_id`,`id`) WHERE "source_responses"."remote_at" IS NULL;