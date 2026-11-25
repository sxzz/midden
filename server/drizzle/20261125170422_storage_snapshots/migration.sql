CREATE TABLE `storage_snapshots` (
	`day` text PRIMARY KEY,
	`r2` text,
	`db_bytes` integer,
	`thumbnail_bytes` integer,
	`free_bytes` integer,
	`updated_at` integer NOT NULL
);
