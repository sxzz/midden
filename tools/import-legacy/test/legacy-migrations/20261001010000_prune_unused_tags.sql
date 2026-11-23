-- Remove tags created by the former standalone creation endpoint.
DELETE FROM tags t
WHERE NOT EXISTS (
        SELECT
        FROM
            collection_tags ct
        WHERE
            ct.tenant_id = t.tenant_id
            AND ct.tag_id = t.id);
