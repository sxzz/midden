CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY,
	`digest` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `web_sessions` (
	`digest` text PRIMARY KEY,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `web_sessions_expires` ON `web_sessions` (`expires_at`);