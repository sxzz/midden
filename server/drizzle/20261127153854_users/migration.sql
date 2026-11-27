-- Users (docs/design/multi-user.md). The owner becomes user 1, the one
-- admin, and every session, passkey and API token so far is theirs, so
-- they all keep working: session digests stay, the admin keeps the WebAuthn
-- user handle every passkey was made with (`midden-owner`), token digests
-- stay. The migrator runs this in a transaction, where PRAGMA foreign_keys
-- is a no-op: foreign keys stay on, so the three tables are rebuilt in an
-- order that never deletes a parent with children (see api_tokens).
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`webauthn_id` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_admin` ON `users` (`role`) WHERE "users"."role" = 'admin';--> statement-breakpoint
-- A random UUIDv7 for the admin, as `newId` makes them; joined since the
-- earliest credential, or now.
INSERT INTO `users` (`id`, `name`, `role`, `webauthn_id`, `created_at`)
SELECT substr(t, 1, 8) || '-' || substr(t, 9, 4) || '-7' || substr(r, 1, 3)
    || '-' || substr('89ab', 1 + abs(random() % 4), 1) || substr(r, 4, 3)
    || '-' || substr(r, 7, 12),
  '管理员', 'admin', 'bWlkZGVuLW93bmVy',
  coalesce(
    (SELECT min(at) FROM (
      SELECT min(`created_at`) AS at FROM `passkeys`
      UNION ALL SELECT min(`created_at`) FROM `web_sessions`
      UNION ALL SELECT min(`created_at`) FROM `api_tokens`)),
    CAST(unixepoch('subsec') * 1000 AS INTEGER))
FROM (SELECT printf('%012x', CAST(unixepoch('subsec') * 1000 AS INTEGER)) AS t,
  lower(hex(randomblob(9))) AS r);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY,
	`digest` text NOT NULL UNIQUE,
	`webauthn_id` text NOT NULL UNIQUE,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by` text,
	`revoked_at` integer,
	CONSTRAINT `fk_invites_used_by_users_id_fk` FOREIGN KEY (`used_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `invites_expires` ON `invites` (`expires_at`);--> statement-breakpoint
CREATE TABLE `__new_web_sessions` (
	`digest` text PRIMARY KEY,
	`id` text NOT NULL UNIQUE,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`method` text,
	`origin` text,
	`device` text,
	CONSTRAINT `fk_web_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_web_sessions` (`digest`, `id`, `user_id`, `expires_at`, `created_at`, `last_used_at`, `method`, `origin`, `device`)
SELECT `digest`, `id`, (SELECT `id` FROM `users` WHERE `role` = 'admin'), `expires_at`, `created_at`, `last_used_at`, `method`, `origin`, `device`
FROM `web_sessions`;--> statement-breakpoint
DROP TABLE `web_sessions`;--> statement-breakpoint
ALTER TABLE `__new_web_sessions` RENAME TO `web_sessions`;--> statement-breakpoint
CREATE INDEX `web_sessions_expires` ON `web_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `web_sessions_user` ON `web_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_passkeys` (
	`id` text PRIMARY KEY,
	`credential_id` text NOT NULL UNIQUE,
	`user_id` text NOT NULL,
	`rp_id` text NOT NULL,
	`name` text NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	CONSTRAINT `fk_passkeys_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_passkeys` (`id`, `credential_id`, `user_id`, `rp_id`, `name`, `public_key`, `counter`, `transports`, `created_at`, `last_used_at`)
SELECT `id`, `credential_id`, (SELECT `id` FROM `users` WHERE `role` = 'admin'), `rp_id`, `name`, `public_key`, `counter`, `transports`, `created_at`, `last_used_at`
FROM `passkeys`;--> statement-breakpoint
DROP TABLE `passkeys`;--> statement-breakpoint
ALTER TABLE `__new_passkeys` RENAME TO `passkeys`;--> statement-breakpoint
CREATE INDEX `passkeys_rp` ON `passkeys` (`rp_id`);--> statement-breakpoint
CREATE INDEX `passkeys_user` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_api_tokens` (
	`id` text PRIMARY KEY,
	`digest` text NOT NULL UNIQUE,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`permission` text DEFAULT 'rw' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	CONSTRAINT `fk_api_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_api_tokens` (`id`, `digest`, `user_id`, `label`, `permission`, `created_at`, `expires_at`, `last_used_at`)
SELECT `id`, `digest`, (SELECT `id` FROM `users` WHERE `role` = 'admin'), `label`, `permission`, `created_at`, `expires_at`, `last_used_at`
FROM `api_tokens`;--> statement-breakpoint
-- Dropping api_tokens with foreign keys on deletes its usage by cascade
-- first, so the usage moves aside, and api_token_usage is made again over
-- the new table.
CREATE TABLE `__api_token_usage` AS SELECT * FROM `api_token_usage`;--> statement-breakpoint
DROP TABLE `api_token_usage`;--> statement-breakpoint
DROP TABLE `api_tokens`;--> statement-breakpoint
ALTER TABLE `__new_api_tokens` RENAME TO `api_tokens`;--> statement-breakpoint
CREATE INDEX `api_tokens_user` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `api_token_usage` (
	`token_id` text NOT NULL,
	`day` text NOT NULL,
	`endpoint` text NOT NULL,
	`count` integer NOT NULL,
	CONSTRAINT `api_token_usage_pk` PRIMARY KEY(`token_id`, `day`, `endpoint`),
	CONSTRAINT `fk_api_token_usage_token_id_api_tokens_id_fk` FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `api_token_usage` (`token_id`, `day`, `endpoint`, `count`)
SELECT `token_id`, `day`, `endpoint`, `count` FROM `__api_token_usage`;--> statement-breakpoint
DROP TABLE `__api_token_usage`;
