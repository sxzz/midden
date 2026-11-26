-- Bodies get their own table: storing one in the bucket deletes its row
-- there, and the metadata row, with its indexes, stays where it is. Before,
-- the body was cleared in place and the row moved to the end of the table
-- (a new rowid, so every index entry was rewritten) to free the page it
-- began on.
CREATE TABLE `source_response_bodies` (
	`response_id` text PRIMARY KEY,
	`body` blob NOT NULL,
	CONSTRAINT `fk_source_response_bodies_response_id_source_responses_id_fk` FOREIGN KEY (`response_id`) REFERENCES `source_responses`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- Only bodies still here: one in the bucket (`remote_at` set) was cleared.
INSERT INTO `source_response_bodies` (`response_id`, `body`)
SELECT `id`, `body` FROM `source_responses` WHERE `remote_at` IS NULL;
--> statement-breakpoint
-- Small rows now: the size index saved reading past the bodies. The body
-- table is the backlog the partial index listed.
DROP INDEX `source_responses_size`;--> statement-breakpoint
DROP INDEX `source_responses_local`;--> statement-breakpoint
DROP INDEX `source_responses_sha256`;--> statement-breakpoint
CREATE INDEX `source_responses_sha256` ON `source_responses` (`sha256`);--> statement-breakpoint
ALTER TABLE `source_responses` DROP COLUMN `body`;--> statement-breakpoint
ALTER TABLE `source_responses` DROP COLUMN `remote_at`;
