DROP INDEX `submissions_next`;--> statement-breakpoint
DROP INDEX `submissions_parent`;--> statement-breakpoint
CREATE INDEX `blob_thumbnails_key` ON `blob_thumbnails` (`key`) WHERE "blob_thumbnails"."key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `captures_finished` ON `captures` (`finished_at`) WHERE "captures"."state" IN ('complete', 'partial');--> statement-breakpoint
CREATE INDEX `jobs_running` ON `jobs` (`lease_until`) WHERE "jobs"."state" = 'running';--> statement-breakpoint
CREATE INDEX `telegram_deliveries_message` ON `telegram_deliveries` (`chat_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `submissions_parent` ON `submissions` (`parent_submission`) WHERE "submissions"."parent_submission" IS NOT NULL;