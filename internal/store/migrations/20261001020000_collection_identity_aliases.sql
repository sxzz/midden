CREATE TABLE collection_identity_aliases (
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN visibility = 'public' THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    platform text NOT NULL,
    scope text NOT NULL,
    kind text NOT NULL,
    object_scope text NOT NULL,
    external_id text NOT NULL,
    collection_id uuid NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
    PRIMARY KEY (data_scope, platform, scope, kind, object_scope, external_id)
);

ALTER TABLE collection_identity_aliases ENABLE ROW LEVEL SECURITY;

ALTER TABLE collection_identity_aliases FORCE ROW LEVEL SECURITY;

CREATE POLICY content_visibility ON collection_identity_aliases
    USING (visibility = 'public'
        OR tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid)
    WITH CHECK (visibility = 'public'
    OR tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid);
