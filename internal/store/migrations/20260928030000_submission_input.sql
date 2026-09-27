ALTER TABLE submissions
    ADD COLUMN input text NOT NULL DEFAULT '';

-- Recover original Telegram input where its inbox still exists.
UPDATE
    submissions s
SET
    input = coalesce(nullif (i.payload #>> '{message,text}', ''), nullif(i.payload #>> '{message,caption}', ''), i.payload #>> '{callback_query,data}', '')
FROM
    inbox i
WHERE
    i.tenant_id = s.tenant_id
    AND (i.id::text = split_part(s.idem_key, ':', 1)
        OR (s.idem_key LIKE 'refresh:%'
            AND i.id::text = split_part(s.idem_key, ':', 2)));

UPDATE
    submissions s
SET
    input = a.url
FROM
    captures c
    JOIN archives a ON a.id = c.archive_id
WHERE
    s.capture_id = c.id
    AND s.input = '';

ALTER TABLE replies
    ADD COLUMN progress integer NOT NULL DEFAULT 0;
