ALTER TABLE captures
    ADD COLUMN page_size integer NOT NULL DEFAULT 0;

ALTER TABLE captures
    ADD COLUMN page_cursor text NOT NULL DEFAULT '';

ALTER TABLE captures
    ADD COLUMN next_page_cursor text NOT NULL DEFAULT '';

ALTER TABLE captures
    ADD COLUMN is_collection boolean NOT NULL DEFAULT FALSE;

DROP INDEX one_active_capture;

CREATE UNIQUE INDEX one_active_capture ON captures (archive_id, adapter_id, provider_id, (coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid)), md5(page_cursor), page_size, automatic)
WHERE
    state IN ('queued', 'downloading');

ALTER TABLE captures
    ADD COLUMN max_batch_size integer NOT NULL DEFAULT 0;

ALTER TABLE submissions
    ADD COLUMN collection_limit integer NOT NULL DEFAULT 0;

ALTER TABLE submissions
    ADD COLUMN next_submission uuid;

ALTER TABLE submissions
    ADD CONSTRAINT submission_tenant_identity UNIQUE (tenant_id, id);

ALTER TABLE submissions
    ADD CONSTRAINT next_submission_owner FOREIGN KEY (tenant_id, next_submission) REFERENCES submissions (tenant_id, id);
