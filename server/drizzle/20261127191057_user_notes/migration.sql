-- Invites keep their token sealed so the admin can show the link again
-- (`#users/invites.ts`); those made before have none and show no link
-- until made again. Users' names become their own nicknames, and the
-- admin's note on a viewer is the label of the invite they used, where it
-- is still kept.
ALTER TABLE `invites` ADD `sealed_token` blob;--> statement-breakpoint
ALTER TABLE `users` ADD `note` text;--> statement-breakpoint
UPDATE `users` SET `note` = (
  SELECT `label` FROM `invites` WHERE `invites`.`used_by` = `users`.`id`
  ORDER BY `used_at` DESC LIMIT 1)
WHERE `role` = 'viewer';
