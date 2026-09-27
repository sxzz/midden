-- Adapter-owned entity data; schema/protocol version markers remain unchanged.
CREATE TABLE entities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN visibility = 'public' THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    platform text NOT NULL,
    scope text NOT NULL,
    kind text NOT NULL,
    external_id text NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (data_scope, platform, scope, kind, external_id),
    UNIQUE (data_scope, id)
);

CREATE TABLE entity_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    entity_id uuid NOT NULL REFERENCES entities ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants,
    visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN visibility = 'public' THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    content_hash text NOT NULL,
    data jsonb NOT NULL,
    schema jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (entity_id, content_hash),
    UNIQUE (data_scope, id),
    FOREIGN KEY (data_scope, entity_id) REFERENCES entities (data_scope, id)
);

CREATE TABLE revision_entities (
    revision_id uuid NOT NULL REFERENCES revisions ON DELETE CASCADE,
    entity_key text NOT NULL,
    entity_version_id uuid NOT NULL REFERENCES entity_versions,
    tenant_id uuid NOT NULL REFERENCES tenants,
    visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN visibility = 'public' THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    is_root boolean NOT NULL,
    PRIMARY KEY (revision_id, entity_key),
    UNIQUE (data_scope, revision_id, entity_key),
    FOREIGN KEY (data_scope, revision_id) REFERENCES revisions (data_scope, id),
    FOREIGN KEY (data_scope, entity_version_id) REFERENCES entity_versions (data_scope, id)
);

CREATE UNIQUE INDEX one_revision_root ON revision_entities (revision_id)
WHERE
    is_root;

CREATE INDEX revision_entity_version ON revision_entities (entity_version_id);

CREATE TABLE entity_relations (
    revision_id uuid NOT NULL,
    source_key text NOT NULL,
    target_key text NOT NULL,
    kind text NOT NULL,
    tenant_id uuid NOT NULL REFERENCES tenants,
    visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN visibility = 'public' THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    PRIMARY KEY (revision_id, source_key, kind, target_key),
    FOREIGN KEY (data_scope, revision_id, source_key) REFERENCES revision_entities (data_scope, revision_id, entity_key) ON DELETE CASCADE,
    FOREIGN KEY (data_scope, revision_id, target_key) REFERENCES revision_entities (data_scope, revision_id, entity_key) ON DELETE CASCADE
);

DO $$
DECLARE
    tab text;
BEGIN
    FOREACH tab IN ARRAY ARRAY['entities', 'entity_versions', 'revision_entities', 'entity_relations'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
        EXECUTE format($policy$CREATE POLICY content_visibility ON %I USING(visibility='public' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(visibility='public' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$, tab);
    END LOOP;
END
$$;

ALTER TABLE assets
    DROP CONSTRAINT assets_purpose_check;

ALTER TABLE assets
    ADD CONSTRAINT assets_purpose_length CHECK (length(purpose) <= 128);

INSERT INTO entities (id, tenant_id, visibility, platform, scope, kind, external_id, observed_at)
SELECT
    id,
    tenant_id,
    visibility,
    platform,
    scope,
    'x.profile',
    external_id,
    observed_at
FROM
    profiles;

INSERT INTO entities (id, tenant_id, visibility, platform, scope, kind, external_id, observed_at)
SELECT
    id,
    tenant_id,
    visibility,
    platform,
    scope,
    'x.post',
    external_id,
    observed_at
FROM
    archives;

-- These transaction-local conversion functions are removed with the session.
CREATE FUNCTION pg_temp.entity_schema (kind text)
    RETURNS jsonb
    LANGUAGE sql
    AS $fn$
    SELECT
        CASE kind
        WHEN 'x.post' THEN
            $post$ {"$schema" :"https://json-schema.org/draft/2020-12/schema",
            "type" :"object",
            "required" :["text"],
            "properties" : {"text" : {"type" :"string" },
            "published_at" : {"type" :"string",
            "format" :"date-time" },
            "edited_at" : {"type" :"string",
            "format" :"date-time" },
            "edited_at_source" : {"type" :"string" },
            "edit_ids" : {"type" :"array",
            "items" : {"type" :"string" }}},
            "additionalProperties" :false }$post$::jsonb
        ELSE
            $profile$ {"$schema" :"https://json-schema.org/draft/2020-12/schema",
            "type" :"object",
            "required" :["username", "name", "metadata"],
            "properties" : {"username" : {"type" :"string" },
            "name" : {"type" :"string" },
            "avatar_url" : {"type" :"string" },
            "metadata" : {"type" :"object" }},
            "additionalProperties" :false }$profile$::jsonb
        END
$fn$;

CREATE FUNCTION pg_temp.resource_signature (cid uuid, positions jsonb)
    RETURNS jsonb
    LANGUAGE sql
    AS $fn$
    SELECT
        coalesce(jsonb_agg(jsonb_build_array(a.purpose, coalesce(b.hash, ''), a.state, a.alt_text, a.sensitive, a.error)
            ORDER BY p.ordinality), '[]'::jsonb)
    FROM
        jsonb_array_elements_text(coalesce(positions, '[]'))
    WITH ORDINALITY p (value, ORDINALITY)
    JOIN assets a ON a.capture_id = cid
        AND a.position = p.value::integer
    LEFT JOIN blobs b ON b.id = a.blob_id
$fn$;

CREATE FUNCTION pg_temp.entity_graph (p jsonb, external_id text, cid uuid)
    RETURNS jsonb
    LANGUAGE plpgsql
    AS $fn$
DECLARE
    nodes jsonb := '[]';
    relations jsonb := '[]';
    d jsonb;
    node jsonb;
    positions jsonb;
    author jsonb := p #> '{metadata,author}';
BEGIN
    IF author IS NOT NULL AND author ->> 'external_id' IS NOT NULL THEN
        d := jsonb_build_object('username', coalesce(author ->> 'username', ''),'name',coalesce(author->>'name',''), 'avatar_url', coalesce(author ->> 'avatar_url', ''), 'metadata', coalesce(author -> 'metadata', '{}'));
        node := jsonb_build_object('key', 'author', 'type', 'x.profile', 'external_id', author ->> 'external_id', 'data', d, 'schema', pg_temp.entity_schema ('x.profile'));
        SELECT
            jsonb_agg(position ORDER BY position)
        INTO
            positions
        FROM
            assets
        WHERE
            capture_id = cid
            AND purpose = 'avatar';
        IF positions IS NOT NULL THEN
            node := node || jsonb_build_object('resource_indices', positions);
        END IF;
        nodes := nodes || jsonb_build_array(node);
        relations := jsonb_build_array(jsonb_build_object('source', 'post', 'target', 'author', 'type', 'authored_by'));
    END IF;
    d := coalesce(p -> 'metadata', '{}') - 'author';
    SELECT
        coalesce(jsonb_object_agg(key, value), '{}')
    INTO
        d
    FROM
        jsonb_each(d)
    WHERE
        value NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb);
    d := d || jsonb_build_object('text', coalesce(p ->> 'text', ''));
    node := jsonb_build_object('key', 'post', 'type', 'x.post', 'external_id', external_id, 'data', d, 'schema', pg_temp.entity_schema ('x.post'));
    SELECT
        jsonb_agg(position ORDER BY position)
    INTO
        positions
    FROM
        assets
    WHERE
        capture_id = cid
        AND purpose = '';
    IF positions IS NOT NULL THEN
        node := node || jsonb_build_object('resource_indices', positions);
    END IF;
    RETURN jsonb_build_object('root', 'post', 'entities', nodes || jsonb_build_array(node), 'relations', relations);
END
$fn$;

UPDATE
    revisions r
SET
    payload = (r.payload - 'metadata') || jsonb_build_object('graph', pg_temp.entity_graph (r.payload, a.external_id, r.capture_id))
FROM
    archives a
WHERE
    a.id = r.archive_id;

UPDATE
    captures c
SET
    payload = (c.payload - 'metadata') || jsonb_build_object('graph', pg_temp.entity_graph (c.payload, a.external_id, c.id))
FROM
    archives a
WHERE
    a.id = c.archive_id
    AND c.payload IS NOT NULL;

DO $fn$
DECLARE
    r record;
    node jsonb;
    nodes jsonb;
    eid uuid;
    vid uuid;
    h text;
BEGIN
    FOR r IN
    SELECT
        rr.*,
        a.platform,
        a.scope
    FROM
        revisions rr
        JOIN archives a ON a.id = rr.archive_id
    ORDER BY
        rr.created_at,
        rr.id LOOP
            nodes := '[]';
            FOR node IN
            SELECT
                value
            FROM
                jsonb_array_elements(r.payload #> '{graph,entities}')
                LOOP
                    SELECT
                        id
                    INTO
                        STRICT eid
                    FROM
                        entities
                    WHERE
                        data_scope = r.data_scope
                        AND platform = r.platform
                        AND scope = r.scope
                        AND kind = node ->> 'type'
                        AND external_id = node ->> 'external_id';
                    h := encode(digest(jsonb_build_array(node -> 'data', node -> 'schema', pg_temp.resource_signature (r.capture_id, node -> 'resource_indices'))::text, 'sha256'), 'hex');
                    INSERT INTO entity_versions (entity_id, tenant_id, visibility, content_hash, data, schema, created_at)
                        VALUES (eid, r.tenant_id, r.visibility, h, node -> 'data', node -> 'schema', r.created_at)
                    ON CONFLICT (entity_id, content_hash)
                        DO UPDATE SET
                            content_hash = excluded.content_hash
                        RETURNING
                            id
                        INTO
                            vid;
                    nodes := nodes || jsonb_build_array(node || jsonb_build_object('id', eid, 'version_id', vid));
                    INSERT INTO revision_entities (revision_id, entity_key, entity_version_id, tenant_id, visibility, is_root)
                        VALUES (r.id, node ->> 'key', vid, r.tenant_id, r.visibility, node ->> 'key' = 'post');
                END LOOP;
            UPDATE
                revisions
            SET
                payload = jsonb_set(payload, '{graph,entities}', nodes)
            WHERE
                id = r.id;
            INSERT INTO entity_relations (revision_id, source_key, target_key, kind, tenant_id, visibility)
            SELECT
                r.id,
                v ->> 'source',
                v ->> 'target',
                v ->> 'type',
                r.tenant_id,
                r.visibility
            FROM
                jsonb_array_elements(r.payload #> '{graph,relations}') v;
        END LOOP;
END
$fn$;

UPDATE
    revisions r
SET
    content_bytes = octet_length(r.payload::text),
    content_hash = encode(digest(jsonb_build_object('Text', r.payload -> 'text', 'Kind', r.payload -> 'text_kind', 'Graph', r.payload -> 'graph', 'Warnings', r.payload -> 'warnings', 'Assets', (
                    SELECT
                        coalesce(jsonb_agg(jsonb_build_object('Purpose', a.purpose, 'Hash', coalesce(b.hash, ''), 'AltText', a.alt_text, 'Sensitive', a.sensitive, 'State', a.state, 'Error', a.error)
                        ORDER BY a.position), '[]')
                    FROM assets a
                LEFT JOIN blobs b ON b.id = a.blob_id
                WHERE
                    a.capture_id = r.capture_id))::text, 'sha256'), 'hex');

-- Pending captures retain their reservations; account for the expanded snapshot.
WITH sizes AS (
    SELECT
        id,
        tenant_id,
        octet_length(payload::text) + 160 * jsonb_array_length(payload #> '{graph,entities}') + coalesce((
            SELECT
                sum(size)
            FROM source_responses
            WHERE
                capture_id = c.id), 0) AS bytes
    FROM
        captures c
    WHERE
        state = 'downloading'
),
changed AS (
    UPDATE
        captures c
    SET
        content_reserved = s.bytes
    FROM
        sizes s
    WHERE
        c.id = s.id
    RETURNING
        c.tenant_id)
UPDATE
    tenants t
SET
    reserved_bytes = (
        SELECT
            coalesce(sum(content_reserved), 0)
        FROM
            captures
        WHERE
            tenant_id = t.id) + (
        SELECT
            coalesce(sum(reserved_bytes), 0)
        FROM
            assets
        WHERE
            tenant_id = t.id)
WHERE
    t.id IN (
        SELECT
            tenant_id
        FROM
            changed);

CREATE OR REPLACE FUNCTION collect_unreferenced_archives (grace interval)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
DECLARE
    aid uuid;
    removed integer := 0;
    candidates uuid[] := ARRAY[]::uuid[];
BEGIN
    FOR aid IN
    SELECT
        a.id
    FROM
        public.archives a
    WHERE
        a.unreferenced_at < now() - grace
    ORDER BY
        a.unreferenced_at
    LIMIT 100
    FOR UPDATE
        SKIP LOCKED LOOP
            IF EXISTS (
                SELECT
                FROM
                    public.tenant_archives ta
                WHERE
                    ta.archive_id = aid)
                OR EXISTS (
                    SELECT
                    FROM
                        public.captures c
                    WHERE
                        c.archive_id = aid
                        AND c.state IN ('queued', 'downloading'))
                OR EXISTS (
                    SELECT
                    FROM
                        public.submissions s
                        JOIN public.captures c ON c.id = s.capture_id
                    WHERE
                        c.archive_id = aid
                        AND s.chat_id IS NOT NULL
                        AND s.state = 'pending') THEN
                CONTINUE;
        END IF;
    SELECT
        candidates || coalesce(array_agg(DISTINCT a.blob_id) FILTER (WHERE a.blob_id IS NOT NULL), ARRAY[]::uuid[])
    INTO
        candidates
    FROM
        public.assets a
        JOIN public.captures c ON c.id = a.capture_id
    WHERE
        c.archive_id = aid;
    UPDATE
        public.archives
    SET
        current_revision = NULL
    WHERE
        id = aid;
    UPDATE
        public.captures
    SET
        revision_id = NULL
    WHERE
        archive_id = aid;
    DELETE FROM public.submissions
    WHERE capture_id IN (
            SELECT
                id
            FROM
                public.captures
            WHERE
                archive_id = aid);
    UPDATE
        public.objects
    SET
        state = 'garbage'
    WHERE
        id IN (
            SELECT
                object_id
            FROM
                public.assets
            WHERE
                capture_id IN (
                    SELECT
                        id
                    FROM
                        public.captures
                    WHERE
                        archive_id = aid))
            AND state = 'pending';
    DELETE FROM public.assets
    WHERE capture_id IN (
            SELECT
                id
            FROM
                public.captures
            WHERE
                archive_id = aid);
    DELETE FROM public.revisions
    WHERE archive_id = aid;
    DELETE FROM public.captures
    WHERE archive_id = aid;
    DELETE FROM public.archives
    WHERE id = aid;
    removed := removed + 1;
END LOOP;
    DELETE FROM public.source_responses sr USING public.captures c
WHERE sr.capture_id = c.id
    AND sr.visibility = 'private'
    AND sr.unreferenced_at < now() - grace
    AND c.state IN ('complete', 'partial', 'failed')
    AND NOT EXISTS (
        SELECT
        FROM
            public.tenant_archives ta
        WHERE
            ta.tenant_id = sr.tenant_id
            AND ta.archive_id = c.archive_id);
    DELETE FROM public.entity_versions pv
    WHERE NOT EXISTS (
            SELECT
            FROM
                public.revision_entities rp
            WHERE
                rp.entity_version_id = pv.id);
    DELETE FROM public.entities p
    WHERE NOT EXISTS (
            SELECT
            FROM
                public.entity_versions pv
            WHERE
                pv.entity_id = p.id);
    -- Blob foreign keys also serialize this deletion against concurrent asset attachment.
    WITH unused AS (
        DELETE FROM public.blobs b
        WHERE b.id = ANY (candidates)
            AND NOT EXISTS (
                SELECT
                FROM
                    public.assets a
                WHERE
                    a.blob_id = b.id)
            RETURNING
                object_key)
    UPDATE
        public.objects o
    SET
        state = 'garbage'
    FROM
        unused u
    WHERE
        o.object_key = u.object_key;
    RETURN removed;
END
$$;

DROP TABLE revision_profiles;

DROP TABLE profile_versions;

DROP TABLE profiles;
