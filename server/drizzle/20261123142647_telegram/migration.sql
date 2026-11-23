CREATE TABLE `telegram_deliveries` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`chat_id` text NOT NULL,
	`group` integer DEFAULT false NOT NULL,
	`reply_to` integer,
	`message_id` integer,
	`progress` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`next_at` integer NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telegram_media` (
	`bot_id` text NOT NULL,
	`hash` text NOT NULL,
	`representation` text NOT NULL,
	`file_id` text NOT NULL,
	CONSTRAINT `telegram_media_pk` PRIMARY KEY(`bot_id`, `hash`, `representation`)
);
--> statement-breakpoint
CREATE INDEX `telegram_deliveries_due` ON `telegram_deliveries` (`state`,`next_at`);--> statement-breakpoint
CREATE INDEX `telegram_deliveries_ref` ON `telegram_deliveries` (`ref`);