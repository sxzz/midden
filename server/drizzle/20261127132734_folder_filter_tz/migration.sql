-- The list's `time_zone` parameter is now `tz`, and folders store a list's
-- canonical query string: rename the key where it is one (values are
-- encoded, so `&` only ever starts a key). The keys stay in their sorted
-- order: no filter key falls between the two names.
UPDATE `folders` SET `filter` = substr(replace('&' || `filter`, '&time_zone=', '&tz='), 2)
WHERE instr('&' || `filter`, '&time_zone=') > 0;
