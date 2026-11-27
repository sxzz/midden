CREATE TABLE `record_summaries` (
	`id` text PRIMARY KEY,
	`stamp` text NOT NULL,
	`summary` text NOT NULL,
	`computed_at` integer NOT NULL
);
