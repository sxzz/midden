PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_shares` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_shares`(`id`, `slug`, `target_kind`, `target_id`, `created_at`, `revoked_at`) SELECT `id`, `slug`, `target_kind`, `target_id`, `created_at`, `revoked_at` FROM `shares`;--> statement-breakpoint
DROP TABLE `shares`;--> statement-breakpoint
ALTER TABLE `__new_shares` RENAME TO `shares`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `shares_target` ON `shares` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shares_slug_live` ON `shares` (`slug`) WHERE "shares"."revoked_at" IS NULL;