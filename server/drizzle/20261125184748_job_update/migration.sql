ALTER TABLE `jobs` ADD `update_id` text;--> statement-breakpoint
CREATE INDEX `jobs_update` ON `jobs` (`update_id`) WHERE "jobs"."update_id" IS NOT NULL;