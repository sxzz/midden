CREATE TABLE `folders` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`filter` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
