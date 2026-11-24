-- `sort=captured` was the old name of `sort=updated` and is no longer
-- accepted. Folder filters are canonical query strings, so the parameter
-- sits between `&` or at either end.
UPDATE `folders`
SET `filter` = trim(replace('&' || `filter` || '&', '&sort=captured&', '&sort=updated&'), '&')
WHERE '&' || `filter` || '&' LIKE '%&sort=captured&%';
