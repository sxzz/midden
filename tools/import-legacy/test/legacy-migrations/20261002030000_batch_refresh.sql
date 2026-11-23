-- `append` refreshes reuse members that are complete and unchanged since they were
-- last observed, instead of capturing every member of a collection again.
ALTER TABLE submissions
    ADD COLUMN update_mode text NOT NULL DEFAULT 'full' CHECK (update_mode IN ('full', 'append'));

-- One web request refreshing many saved collections. A background task submits each
-- in order so the per-minute capture rate delays the batch instead of failing it.
CREATE TABLE refresh_batches (
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    id uuid NOT NULL DEFAULT gen_random_uuid (),
    collection_ids uuid[] NOT NULL CHECK (cardinality(collection_ids) BETWEEN 1 AND 500),
    update_mode text NOT NULL CHECK (update_mode IN ('full', 'append')),
    -- Index of the next collection to submit.
    position integer NOT NULL DEFAULT 0,
    -- Submissions answered by existing content without a new capture.
    reused integer NOT NULL DEFAULT 0,
    -- Collections that could not be submitted, such as ones deleted meanwhile.
    rejected integer NOT NULL DEFAULT 0,
    capture_ids uuid[] NOT NULL DEFAULT '{}',
    state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'complete', 'failed')),
    error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    UNIQUE (tenant_id, id)
);

ALTER TABLE refresh_batches ENABLE ROW LEVEL SECURITY;

ALTER TABLE refresh_batches FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON refresh_batches
    USING (tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid)
    WITH CHECK (tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid);
