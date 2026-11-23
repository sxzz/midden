CREATE INDEX `blobs_size` ON `blobs` (`size`);--> statement-breakpoint
CREATE INDEX `revisions_bytes` ON `revisions` (`collection_id`,`content_bytes`);--> statement-breakpoint
CREATE INDEX `source_responses_size` ON `source_responses` (`capture_id`,`size`);