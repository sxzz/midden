CREATE TABLE `shares` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `shares_target` ON `shares` (`target_kind`,`target_id`);