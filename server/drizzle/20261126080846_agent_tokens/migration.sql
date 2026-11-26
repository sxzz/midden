CREATE TABLE `api_token_usage` (
	`token_id` text NOT NULL,
	`day` text NOT NULL,
	`endpoint` text NOT NULL,
	`count` integer NOT NULL,
	CONSTRAINT `api_token_usage_pk` PRIMARY KEY(`token_id`, `day`, `endpoint`),
	CONSTRAINT `fk_api_token_usage_token_id_api_tokens_id_fk` FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- Tokens made before permissions and expiry read and write (the default
-- below) and never expire; each keeps its name as its label.
ALTER TABLE `api_tokens` RENAME COLUMN `name` TO `label`;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `permission` text DEFAULT 'rw' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `last_used_at` integer;