CREATE TABLE `folder_counts` (
	`folder_id` text PRIMARY KEY,
	`key` text NOT NULL,
	`version` integer NOT NULL,
	`count` integer NOT NULL,
	`types` text NOT NULL,
	`counted_at` integer NOT NULL,
	CONSTRAINT `fk_folder_counts_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE CASCADE
);
