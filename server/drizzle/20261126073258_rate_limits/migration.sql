-- When an API rate-limits us, the jobs that ask it wait for the limit's end
-- (`rate_limits`) without using an attempt; `jobs.rate_scope` names the
-- limit a waiting job waits for.
CREATE TABLE `rate_limits` (
	`scope` text PRIMARY KEY,
	`until` integer NOT NULL,
	`reason` text NOT NULL,
	`hits` integer NOT NULL,
	`since` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `rate_scope` text;--> statement-breakpoint
CREATE INDEX `jobs_rate_scope` ON `jobs` (`rate_scope`) WHERE "jobs"."rate_scope" IS NOT NULL;