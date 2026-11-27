PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_web_sessions` (
	`digest` text PRIMARY KEY,
	`id` text NOT NULL UNIQUE,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`method` text,
	`origin` text,
	`device` text
);
--> statement-breakpoint
-- Sessions signed in before the device list: a random public id, used and
-- created now, how and where unknown. They keep their expiry, which is
-- under a day away, so their next request renews them.
INSERT INTO `__new_web_sessions`(`digest`, `id`, `expires_at`, `created_at`, `last_used_at`)
SELECT `digest`, lower(hex(randomblob(16))), `expires_at`,
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM `web_sessions`;--> statement-breakpoint
DROP TABLE `web_sessions`;--> statement-breakpoint
ALTER TABLE `__new_web_sessions` RENAME TO `web_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `web_sessions_expires` ON `web_sessions` (`expires_at`);