CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`type` text NOT NULL,
	`ref` text NOT NULL,
	`queue` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'available' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`run_at` integer NOT NULL,
	`lease_until` integer,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_claim` ON `jobs` (`queue`,`state`,`priority`,`run_at`);