CREATE TABLE `member_events` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`ref` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `update_members` (
	`update_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`capture_id` text NOT NULL,
	`state` text NOT NULL,
	`added` integer,
	CONSTRAINT `update_members_pk` PRIMARY KEY(`update_id`, `collection_id`)
);
--> statement-breakpoint
CREATE TABLE `update_pages` (
	`page_id` text PRIMARY KEY,
	`update_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `update_progress` (
	`update_id` text PRIMARY KEY,
	`total` integer NOT NULL,
	`complete` integer NOT NULL,
	`complete_added` integer NOT NULL,
	`complete_updated` integer NOT NULL,
	`partial` integer NOT NULL,
	`partial_added` integer NOT NULL,
	`partial_updated` integer NOT NULL,
	`failed` integer NOT NULL,
	`pending` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_events_ref` ON `member_events` (`kind`,`ref`);--> statement-breakpoint
CREATE INDEX `update_members_state` ON `update_members` (`update_id`,`state`,`added`);--> statement-breakpoint
CREATE INDEX `update_members_capture` ON `update_members` (`capture_id`);--> statement-breakpoint
CREATE INDEX `update_pages_update` ON `update_pages` (`update_id`);
--> statement-breakpoint
-- What an update's members depend on, logged for the worker to settle
-- (`capture/progress.ts`): a submission added or changed, a capture's state
-- or creation, a submission removed. Only the ids are written, once each
-- until taken up, so the cost on the write path is one small insert.
CREATE TRIGGER `member_events_submission_insert` AFTER INSERT ON `submissions` BEGIN
  INSERT OR IGNORE INTO `member_events` (`kind`, `ref`) VALUES ('s', NEW.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `member_events_submission_update` AFTER UPDATE OF `update_id`, `parent_submission`, `capture_id`, `idem_key`, `library_added`, `next_submission`, `related_state` ON `submissions` BEGIN
  INSERT OR IGNORE INTO `member_events` (`kind`, `ref`) VALUES ('s', NEW.`id`);
  INSERT OR IGNORE INTO `member_events` (`kind`, `ref`) VALUES ('c', NEW.`capture_id`);
  INSERT OR IGNORE INTO `member_events` (`kind`, `ref`) SELECT 'c', OLD.`capture_id` WHERE OLD.`capture_id` <> NEW.`capture_id`;
  INSERT OR IGNORE INTO `member_events` (`kind`, `ref`) SELECT 'u', OLD.`update_id` WHERE OLD.`update_id` IS NOT NULL AND OLD.`update_id` IS NOT NEW.`update_id`;
  INSERT OR IGNORE INTO `member_events` (`kind`, `ref`) SELECT 'p', OLD.`parent_submission` WHERE OLD.`parent_submission` IS NOT NULL AND OLD.`parent_submission` IS NOT NEW.`parent_submission`;
END;--> statement-breakpoint
CREATE TRIGGER `member_events_submission_delete` AFTER DELETE ON `submissions` BEGIN
  INSERT OR IGNORE INTO `member_events` (`kind`, `ref`) VALUES ('c', OLD.`capture_id`);
  INSERT OR IGNORE INTO `member_events` (`kind`, `ref`) SELECT 'u', OLD.`update_id` WHERE OLD.`update_id` IS NOT NULL;
  INSERT OR IGNORE INTO `member_events` (`kind`, `ref`) SELECT 'p', OLD.`parent_submission` WHERE OLD.`parent_submission` IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `member_events_capture_update` AFTER UPDATE OF `state`, `created_at` ON `captures` BEGIN
  INSERT OR IGNORE INTO `member_events` (`kind`, `ref`) VALUES ('c', NEW.`id`);
END;--> statement-breakpoint
-- An update that is deleted takes what was kept of its members with it.
CREATE TRIGGER `update_progress_update_delete` AFTER DELETE ON `updates` BEGIN
  DELETE FROM `update_members` WHERE `update_id` = OLD.`id`;
  DELETE FROM `update_pages` WHERE `update_id` = OLD.`id`;
  DELETE FROM `update_progress` WHERE `update_id` = OLD.`id`;
END;