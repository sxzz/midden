ALTER TABLE tenant_collections
    ADD COLUMN note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 10000);

CREATE TABLE tags (
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    id uuid NOT NULL DEFAULT gen_random_uuid (),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64 AND name = btrim(name)),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, name)
);

CREATE TABLE collection_tags (
    tenant_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    PRIMARY KEY (tenant_id, collection_id, tag_id),
    FOREIGN KEY (tenant_id, collection_id) REFERENCES tenant_collections (tenant_id, collection_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, tag_id) REFERENCES tags (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX collection_tags_filter ON collection_tags (tenant_id, tag_id, collection_id);

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

ALTER TABLE tags FORCE ROW LEVEL SECURITY;

ALTER TABLE collection_tags ENABLE ROW LEVEL SECURITY;

ALTER TABLE collection_tags FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tags
    USING (tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid)
    WITH CHECK (tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid);

CREATE POLICY tenant_isolation ON collection_tags
    USING (tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid)
    WITH CHECK (tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid);
