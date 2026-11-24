CREATE TABLE `passkey_challenges` (
	`digest` text PRIMARY KEY,
	`kind` text NOT NULL,
	`origin` text NOT NULL,
	`token_digest` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `passkey_tokens` (
	`digest` text PRIMARY KEY,
	`origin` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY,
	`credential_id` text NOT NULL UNIQUE,
	`rp_id` text NOT NULL,
	`name` text NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `passkey_challenges_expires` ON `passkey_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `passkey_tokens_expires` ON `passkey_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `passkeys_rp` ON `passkeys` (`rp_id`);