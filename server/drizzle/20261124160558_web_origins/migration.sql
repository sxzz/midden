CREATE TABLE `web_origins` (
	`id` text PRIMARY KEY,
	`origin` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL
);
