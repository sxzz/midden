-- Store each adapter object once. Revisions keep the visibility of the observation
-- that produced them; tenants read restricted revisions through access grants
-- proven with one of their own accounts. Content has no owning tenant.
--
-- 1. Remove per-tenant scoping that blocks merging.
DROP TRIGGER immutable_content_owner ON public.collections;

DROP TRIGGER immutable_content_owner ON public.captures;

DROP TRIGGER immutable_content_owner ON public.revisions;

DROP TRIGGER immutable_content_owner ON public.assets;

DROP TRIGGER immutable_content_owner ON public.blobs;

DROP FUNCTION public.immutable_content_owner ();

DROP POLICY content_insert ON public.collections;

DROP POLICY content_read ON public.collections;

DROP POLICY content_update ON public.collections;

DROP POLICY content_insert ON public.captures;

DROP POLICY content_read ON public.captures;

DROP POLICY content_update ON public.captures;

DROP POLICY content_insert ON public.revisions;

DROP POLICY content_read ON public.revisions;

DROP POLICY content_update ON public.revisions;

DROP POLICY content_insert ON public.assets;

DROP POLICY content_read ON public.assets;

DROP POLICY content_update ON public.assets;

DROP POLICY content_insert ON public.blobs;

DROP POLICY content_read ON public.blobs;

DROP POLICY content_update ON public.blobs;

DROP POLICY content_visibility ON public.entities;

DROP POLICY content_visibility ON public.entity_versions;

DROP POLICY content_visibility ON public.revision_entities;

DROP POLICY content_visibility ON public.entity_relations;

DROP POLICY content_visibility ON public.source_responses;

DROP POLICY content_visibility ON public.collection_identity_aliases;

DROP POLICY tenant_isolation ON public.objects;

ALTER TABLE public.assets
    DROP CONSTRAINT assets_data_scope_blob_id_fkey,
    DROP CONSTRAINT assets_data_scope_capture_id_fkey,
    DROP CONSTRAINT assets_tenant_id_capture_id_fkey,
    DROP CONSTRAINT assets_tenant_id_object_id_fkey,
    DROP CONSTRAINT assets_tenant_id_fkey;

ALTER TABLE public.blobs
    DROP CONSTRAINT blobs_tenant_id_fkey;

ALTER TABLE public.captures
    DROP CONSTRAINT capture_revision_fk,
    DROP CONSTRAINT captures_data_scope_collection_id_fkey;

ALTER TABLE public.collections
    DROP CONSTRAINT collection_revision_fk,
    DROP CONSTRAINT collections_tenant_id_fkey;

ALTER TABLE public.entities
    DROP CONSTRAINT entities_tenant_id_fkey;

ALTER TABLE public.entity_versions
    DROP CONSTRAINT entity_versions_data_scope_entity_id_fkey,
    DROP CONSTRAINT entity_versions_tenant_id_fkey;

ALTER TABLE public.entity_relations
    DROP CONSTRAINT entity_relations_data_scope_revision_id_source_key_fkey,
    DROP CONSTRAINT entity_relations_data_scope_revision_id_target_key_fkey,
    DROP CONSTRAINT entity_relations_tenant_id_fkey;

ALTER TABLE public.revision_entities
    DROP CONSTRAINT revision_entities_data_scope_entity_version_id_fkey,
    DROP CONSTRAINT revision_entities_data_scope_revision_id_fkey,
    DROP CONSTRAINT revision_entities_tenant_id_fkey;

ALTER TABLE public.revisions
    DROP CONSTRAINT revisions_collection_id_capture_id_fkey,
    DROP CONSTRAINT revisions_data_scope_capture_id_fkey,
    DROP CONSTRAINT revisions_data_scope_collection_id_fkey,
    DROP CONSTRAINT revisions_tenant_id_capture_id_fkey,
    DROP CONSTRAINT revisions_tenant_id_fkey;

ALTER TABLE public.source_responses
    DROP CONSTRAINT source_responses_tenant_id_capture_id_fkey;

ALTER TABLE public.collection_identity_aliases
    DROP CONSTRAINT collection_identity_aliases_tenant_id_fkey;

ALTER TABLE public.objects
    DROP CONSTRAINT objects_tenant_id_fkey;

-- Unique keys go only after every foreign key that referenced them.
ALTER TABLE public.assets
    DROP CONSTRAINT assets_data_scope_id_key,
    DROP CONSTRAINT assets_tenant_id_id_key;

ALTER TABLE public.blobs
    DROP CONSTRAINT blobs_data_scope_access_scope_hash_key,
    DROP CONSTRAINT blobs_data_scope_id_key,
    DROP CONSTRAINT blobs_tenant_id_id_key;

ALTER TABLE public.captures
    DROP CONSTRAINT captures_data_scope_id_key;

ALTER TABLE public.collections
    DROP CONSTRAINT collections_data_scope_id_key,
    DROP CONSTRAINT collections_data_scope_platform_scope_kind_object_scope_extern_,
    DROP CONSTRAINT collections_tenant_id_id_key;

ALTER TABLE public.entities
    DROP CONSTRAINT entities_data_scope_id_key,
    DROP CONSTRAINT entities_data_scope_platform_scope_kind_external_id_key;

ALTER TABLE public.entity_versions
    DROP CONSTRAINT entity_versions_data_scope_id_key;

ALTER TABLE public.revision_entities
    DROP CONSTRAINT revision_entities_data_scope_revision_id_entity_key_key;

ALTER TABLE public.revisions
    DROP CONSTRAINT revisions_data_scope_id_key,
    DROP CONSTRAINT revisions_tenant_id_capture_id_key,
    DROP CONSTRAINT revisions_tenant_id_id_key;

ALTER TABLE public.collection_identity_aliases
    DROP CONSTRAINT collection_identity_aliases_pkey;

ALTER TABLE public.objects
    DROP CONSTRAINT objects_tenant_id_id_key;

DROP INDEX public.one_active_capture;

DROP INDEX public.assets_cache;

DROP INDEX public.collections_recent;

-- 2. Tenants that held private copies keep access to what they already stored.
CREATE TABLE public.access_grants (
    tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    platform text NOT NULL,
    kind text NOT NULL,
    object_scope text NOT NULL,
    external_id text NOT NULL,
    connection_id uuid,
    method text NOT NULL CHECK (method IN ('fetch', 'check', 'migration')),
    granted_at timestamp with time zone NOT NULL DEFAULT now(),
    verified_at timestamp with time zone NOT NULL DEFAULT now(),
    revoked_at timestamp with time zone,
    PRIMARY KEY (tenant_id, platform, kind, object_scope, external_id)
);

INSERT INTO public.access_grants (tenant_id, platform, kind, object_scope, external_id, connection_id, method, granted_at, verified_at)
SELECT
    OWNER,
    platform,
    kind,
    object_scope,
    external_id,
    (array_agg(connection ORDER BY at) FILTER (WHERE connection IS NOT NULL))[1],
    'migration',
    min(at),
    max(at)
FROM (
    SELECT
        a.tenant_id AS owner,
        a.platform,
        a.kind,
        a.object_scope,
        a.external_id,
        (
            SELECT
                c.id
            FROM
                public.connections c
            WHERE
                a.scope = 'connection:' || c.id::text) AS connection,
            a.created_at AS at
        FROM
            public.collections a
        WHERE
            a.visibility = 'private'
        UNION ALL
        SELECT
            c.tenant_id,
            a.platform,
            a.kind,
            a.object_scope,
            a.external_id,
            c.connection_id,
            coalesce(c.finished_at, c.created_at)
        FROM
            public.captures c
            JOIN public.collections a ON a.id = c.collection_id
        WHERE
            c.visibility = 'private'
            AND c.state IN ('complete', 'partial')) observed
GROUP BY
    OWNER,
    platform,
    kind,
    object_scope,
    external_id;

-- 3. One collection per adapter object; prefer the public copy, then the oldest.
CREATE TEMPORARY TABLE collection_merge ON COMMIT DROP AS
SELECT
    id AS old, first_value(id) OVER IDENTITY AS keep
    FROM
        public.collections
WINDOW IDENTITY AS (PARTITION BY platform, kind, object_scope, external_id
ORDER BY
    (visibility = 'public') DESC, created_at, id);

DELETE FROM collection_merge
WHERE old = keep;

UPDATE
    public.captures c
SET
    collection_id = m.keep
FROM
    collection_merge m
WHERE
    c.collection_id = m.old;

UPDATE
    public.captures c
SET
    refresh_from = m.keep
FROM
    collection_merge m
WHERE
    c.refresh_from = m.old;

UPDATE
    public.revisions r
SET
    collection_id = m.keep
FROM
    collection_merge m
WHERE
    r.collection_id = m.old;

UPDATE
    public.submissions s
SET
    related_source_collection = m.keep
FROM
    collection_merge m
WHERE
    s.related_source_collection = m.old;

UPDATE
    public.collection_identity_aliases x
SET
    collection_id = m.keep
FROM
    collection_merge m
WHERE
    x.collection_id = m.old;

-- A tenant that saved several copies keeps one save: earliest time, any account
-- choice, and every distinct note.
INSERT INTO public.tenant_collections (tenant_id, collection_id, provider_id, connection_id, created_at, adapter_id, note)
SELECT DISTINCT ON (t.tenant_id, m.keep)
    t.tenant_id,
    m.keep,
    t.provider_id,
    t.connection_id,
    t.created_at,
    t.adapter_id,
    t.note
FROM
    public.tenant_collections t
    JOIN collection_merge m ON m.old = t.collection_id
ORDER BY
    t.tenant_id,
    m.keep,
    t.created_at
ON CONFLICT (tenant_id,
    collection_id)
    DO UPDATE SET
        created_at = least (tenant_collections.created_at, excluded.created_at),
        connection_id = coalesce(tenant_collections.connection_id, excluded.connection_id),
        provider_id = CASE WHEN tenant_collections.connection_id IS NULL
            AND excluded.connection_id IS NOT NULL THEN
            excluded.provider_id
        ELSE
            tenant_collections.provider_id
        END;

UPDATE
    public.tenant_collections kept
SET
    note = merged.note
FROM (
    SELECT
        t.tenant_id,
        m.keep,
        string_agg(DISTINCT t.note, E'\n\n') AS note
    FROM
        public.tenant_collections t
        JOIN (
            SELECT
                old,
                keep
            FROM
                collection_merge
        UNION ALL SELECT DISTINCT
            keep,
            keep
        FROM
            collection_merge) m ON m.old = t.collection_id
    WHERE
        t.note <> ''
    GROUP BY
        t.tenant_id,
        m.keep) merged
WHERE
    kept.tenant_id = merged.tenant_id
    AND kept.collection_id = merged.keep
    AND kept.note IS DISTINCT FROM merged.note;

INSERT INTO public.collection_tags (tenant_id, collection_id, tag_id)
SELECT
    ct.tenant_id,
    m.keep,
    ct.tag_id
FROM
    public.collection_tags ct
    JOIN collection_merge m ON m.old = ct.collection_id
ON CONFLICT
    DO NOTHING;

DELETE FROM public.tenant_collections t USING collection_merge m
WHERE t.collection_id = m.old;

UPDATE
    public.collections a
SET
    created_at = merged.created_at,
    observed_at = merged.observed_at
FROM (
    SELECT
        m.keep,
        min(a.created_at) AS created_at,
        max(a.observed_at) AS observed_at
    FROM
        collection_merge m
        JOIN public.collections a ON a.id IN (m.old, m.keep)
    GROUP BY
        m.keep) merged
WHERE
    a.id = merged.keep;

DELETE FROM public.collections a USING collection_merge m
WHERE a.id = m.old;

-- The global head is the newest observation; each tenant reads its newest visible one.
UPDATE
    public.collections a
SET
    current_revision = (
        SELECT
            r.id
        FROM
            public.revisions r
        WHERE
            r.collection_id = a.id
        ORDER BY
            r.created_at DESC,
            r.id DESC
        LIMIT 1),
unreferenced_at = CASE WHEN EXISTS (
    SELECT
    FROM
        public.tenant_collections t
    WHERE
        t.collection_id = a.id) THEN
    NULL
ELSE
    coalesce(a.unreferenced_at, now())
END;

-- Merged copies can each have had one in-flight capture for the same source.
UPDATE
    public.captures c
SET
    state = 'failed',
    error = 'superseded while merging stored copies',
    finished_at = now()
FROM (
    SELECT
        id,
        row_number() OVER (PARTITION BY collection_id, adapter_id, provider_id, coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid),
            md5(page_cursor),
            page_size,
            automatic ORDER BY created_at,
            id) AS n
    FROM
        public.captures
    WHERE
        state IN ('queued', 'downloading')) duplicate
WHERE
    c.id = duplicate.id
    AND duplicate.n > 1;

-- 4. Restricted objects embedded in a private revision must also be accessible.
CREATE TABLE public.revision_access_requirements (
    revision_id uuid NOT NULL REFERENCES public.revisions (id) ON DELETE CASCADE,
    platform text NOT NULL,
    kind text NOT NULL,
    object_scope text NOT NULL,
    external_id text NOT NULL,
    PRIMARY KEY (revision_id, platform, kind, object_scope, external_id)
);

INSERT INTO public.revision_access_requirements (revision_id, platform, kind, object_scope, external_id)
SELECT DISTINCT
    r.id,
    a.platform,
    a.kind,
    '',
    embedded ->> 'external_id'
FROM
    public.revisions r
    JOIN public.collections a ON a.id = r.collection_id
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.payload -> 'graph' -> 'entities', '[]'::jsonb)) embedded
    JOIN LATERAL jsonb_array_elements(r.payload -> 'graph' -> 'entities') root ON root ->> 'key' = r.payload -> 'graph' ->> 'root'
WHERE
    r.visibility = 'private'
    AND embedded ->> 'key' <> r.payload -> 'graph' ->> 'root'
    AND embedded ->> 'type' = root ->> 'type'
    AND NOT coalesce((embedded ->> 'context_only')::boolean, FALSE);

-- 5. One entity per adapter identity; equal versions collapse.
CREATE TEMPORARY TABLE entity_merge ON COMMIT DROP AS
SELECT
    id AS old, first_value(id) OVER IDENTITY AS keep
    FROM
        public.entities
WINDOW IDENTITY AS (PARTITION BY platform, kind, external_id
ORDER BY
    (visibility = 'public') DESC, observed_at, id);

DELETE FROM entity_merge
WHERE old = keep;

CREATE TEMPORARY TABLE version_merge ON COMMIT DROP AS
SELECT
    v.id AS old, first_value(v.id) OVER same AS keep
FROM
    public.entity_versions v
    LEFT JOIN entity_merge m ON m.old = v.entity_id
WINDOW same AS (PARTITION BY coalesce(m.keep, v.entity_id), v.content_hash
ORDER BY
    (m.old IS NULL) DESC, (v.visibility = 'public') DESC, v.created_at, v.id);

DELETE FROM version_merge
WHERE old = keep;

UPDATE
    public.revision_entities re
SET
    entity_version_id = m.keep
FROM
    version_merge m
WHERE
    re.entity_version_id = m.old;

DELETE FROM public.entity_versions v USING version_merge m
WHERE v.id = m.old;

UPDATE
    public.entity_versions v
SET
    entity_id = m.keep
FROM
    entity_merge m
WHERE
    v.entity_id = m.old;

UPDATE
    public.entities e
SET
    observed_at = merged.observed_at
FROM (
    SELECT
        m.keep,
        max(e.observed_at) AS observed_at
    FROM
        entity_merge m
        JOIN public.entities e ON e.id IN (m.old, m.keep)
    GROUP BY
        m.keep) merged
WHERE
    e.id = merged.keep;

DELETE FROM public.entities e USING entity_merge m
WHERE e.id = m.old;

-- Stored snapshots reference entity and version IDs; keep them resolvable.
UPDATE
    public.revisions r
SET
    payload = jsonb_set(r.payload, '{graph,entities}', rewritten.entities)
FROM (
    SELECT
        r.id,
        jsonb_agg(
            CASE WHEN em.keep IS NULL
                AND vm.keep IS NULL THEN
                entity
            ELSE
                entity || jsonb_strip_nulls (jsonb_build_object('id', em.keep, 'version_id', vm.keep))
            END ORDER BY position) AS entities
    FROM
        public.revisions r
    CROSS JOIN LATERAL jsonb_array_elements(r.payload -> 'graph' -> 'entities')
    WITH ORDINALITY AS item (entity, position)
    LEFT JOIN entity_merge em ON em.old::text = entity ->> 'id'
    LEFT JOIN version_merge vm ON vm.old::text = entity ->> 'version_id'
WHERE
    jsonb_typeof(r.payload -> 'graph' -> 'entities') = 'array'
GROUP BY
    r.id
HAVING
    bool_or(em.keep IS NOT NULL
        OR vm.keep IS NOT NULL)) rewritten
WHERE
    r.id = rewritten.id;

-- 6. One blob per content hash. Superseded uploads go through object GC.
CREATE TEMPORARY TABLE blob_merge ON COMMIT DROP AS
SELECT
    b.id AS old, b.object_key, first_value(b.id) OVER same AS keep
FROM
    public.blobs b
    LEFT JOIN public.objects o ON o.object_key = b.object_key
WINDOW same AS (PARTITION BY b.hash ORDER BY (o.state = 'attached') DESC NULLS LAST, o.created_at NULLS LAST, b.id);

DELETE FROM blob_merge
WHERE old = keep;

UPDATE
    public.assets a
SET
    blob_id = m.keep
FROM
    blob_merge m
WHERE
    a.blob_id = m.old;

DELETE FROM public.blobs b USING blob_merge m
WHERE b.id = m.old;

UPDATE
    public.objects o
SET
    state = 'garbage'
FROM
    blob_merge m
WHERE
    o.object_key = m.object_key
    AND o.state IN ('pending', 'attached');

-- 7. Remove ownership and per-tenant scopes.
ALTER TABLE public.collections
    DROP COLUMN data_scope,
    DROP COLUMN tenant_id,
    DROP COLUMN visibility,
    DROP COLUMN scope,
    ADD CONSTRAINT collections_identity_key UNIQUE (platform, kind, object_scope, external_id),
    ADD CONSTRAINT collection_revision_fk FOREIGN KEY (id, current_revision) REFERENCES public.revisions (collection_id, id);

ALTER TABLE public.captures
    DROP COLUMN data_scope,
    ALTER COLUMN tenant_id DROP NOT NULL,
    ADD COLUMN mode text NOT NULL DEFAULT 'fetch' CHECK (mode IN ('fetch', 'check')),
    ADD COLUMN restricted_targets jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD CONSTRAINT captures_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.collections (id),
    ADD CONSTRAINT capture_revision_fk FOREIGN KEY (collection_id, revision_id) REFERENCES public.revisions (collection_id, id);

ALTER TABLE public.revisions
    DROP COLUMN data_scope,
    DROP COLUMN tenant_id,
    ADD CONSTRAINT revisions_capture_id_key UNIQUE (capture_id),
    ADD CONSTRAINT revisions_collection_id_capture_id_fkey FOREIGN KEY (collection_id, capture_id) REFERENCES public.captures (collection_id, id);

ALTER TABLE public.assets
    DROP COLUMN data_scope,
    DROP COLUMN tenant_id,
    DROP COLUMN visibility,
    ADD CONSTRAINT assets_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures (id),
    ADD CONSTRAINT assets_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES public.blobs (id),
    ADD CONSTRAINT assets_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects (id);

ALTER TABLE public.blobs
    DROP COLUMN data_scope,
    DROP COLUMN tenant_id,
    DROP COLUMN visibility,
    DROP COLUMN access_scope,
    ADD CONSTRAINT blobs_hash_key UNIQUE (hash);

ALTER TABLE public.objects RENAME COLUMN tenant_id TO uploaded_by;

ALTER TABLE public.objects
    ALTER COLUMN uploaded_by DROP NOT NULL,
    ADD CONSTRAINT objects_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.tenants (id) ON DELETE SET NULL;

ALTER TABLE public.entities
    DROP COLUMN data_scope,
    DROP COLUMN tenant_id,
    DROP COLUMN visibility,
    DROP COLUMN scope,
    ADD CONSTRAINT entities_identity_key UNIQUE (platform, kind, external_id);

ALTER TABLE public.entity_versions
    DROP COLUMN data_scope,
    DROP COLUMN tenant_id,
    DROP COLUMN visibility;

ALTER TABLE public.revision_entities
    DROP COLUMN data_scope,
    DROP COLUMN tenant_id,
    DROP COLUMN visibility;

ALTER TABLE public.entity_relations
    DROP COLUMN data_scope,
    DROP COLUMN tenant_id,
    DROP COLUMN visibility,
    ADD CONSTRAINT entity_relations_source_fkey FOREIGN KEY (revision_id, source_key) REFERENCES public.revision_entities (revision_id, entity_key) ON DELETE CASCADE,
    ADD CONSTRAINT entity_relations_target_fkey FOREIGN KEY (revision_id, target_key) REFERENCES public.revision_entities (revision_id, entity_key) ON DELETE CASCADE;

ALTER TABLE public.source_responses
    ALTER COLUMN tenant_id DROP NOT NULL,
    ADD CONSTRAINT source_responses_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures (id) ON DELETE CASCADE;

DELETE FROM public.collection_identity_aliases x USING public.collection_identity_aliases y
WHERE (x.platform, x.kind, x.object_scope, x.external_id) = (y.platform, y.kind, y.object_scope, y.external_id)
    AND (x.visibility = 'private',
        x.collection_id) > (y.visibility = 'private',
        y.collection_id);

ALTER TABLE public.collection_identity_aliases
    DROP COLUMN data_scope,
    DROP COLUMN tenant_id,
    DROP COLUMN visibility,
    DROP COLUMN scope,
    ADD PRIMARY KEY (platform, kind, object_scope, external_id);

-- Public captures are joined by every tenant; private ones belong to one account or tenant.
CREATE UNIQUE INDEX one_active_capture ON public.captures (collection_id, adapter_id, provider_id, coalesce(connection_id, CASE WHEN visibility = 'public' THEN
    '00000000-0000-0000-0000-000000000000'::uuid
ELSE
    tenant_id
END), md5(page_cursor), page_size, automatic, mode)
WHERE
    state IN ('queued', 'downloading');

CREATE INDEX assets_cache ON public.assets (cache_key)
WHERE
    state = 'ready' AND cache_key <> '';

CREATE INDEX revisions_head ON public.revisions (collection_id, created_at DESC, id DESC);

CREATE INDEX captures_revision ON public.captures (revision_id);

-- 8. Access functions. Definer functions read across tenants but only answer for
-- the tenant set in app.tenant_id.
CREATE FUNCTION public.current_tenant ()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    AS $$
    SELECT
        nullif (current_setting('app.tenant_id', TRUE), '')::uuid
$$;

-- Access held at a point in time. Revocation hides only versions observed after it.
CREATE FUNCTION public.tenant_has_access (p text, k text, s text, x text, observed timestamp with time zone)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT
        EXISTS (
            SELECT
            FROM
                public.access_grants g
            WHERE
                g.tenant_id = public.current_tenant ()
                AND (g.platform,
                    g.kind,
                    g.object_scope,
                    g.external_id) = (p,
                    k,
                    s,
                    x)
                AND (g.revoked_at IS NULL
                    OR observed <= g.revoked_at))
$$;

CREATE FUNCTION public.tenant_can_read_revision (rid uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT
        EXISTS (
            SELECT
            FROM
                public.revisions r
                JOIN public.collections a ON a.id = r.collection_id
            WHERE
                r.id = rid
                AND public.current_tenant () IS NOT NULL
                AND (r.visibility = 'public'
                    OR EXISTS (
                        SELECT
                        FROM
                            public.captures c
                        WHERE
                            c.id = r.capture_id
                            AND c.tenant_id = public.current_tenant ())
                        OR (public.tenant_has_access (a.platform, a.kind, a.object_scope, a.external_id, r.created_at)
                            AND NOT EXISTS (
                                SELECT
                                FROM
                                    public.revision_access_requirements q
                                WHERE
                                    q.revision_id = r.id
                                    AND NOT public.tenant_has_access (q.platform, q.kind, q.object_scope, q.external_id, r.created_at)
                                    AND NOT EXISTS (
                                        SELECT
                                        FROM
                                            public.collections qa
                                            JOIN public.revisions qr ON qr.collection_id = qa.id
                                        WHERE (qa.platform, qa.kind, qa.object_scope, qa.external_id) = (q.platform, q.kind, q.object_scope, q.external_id)
                                        AND qr.visibility = 'public')))))
$$;

CREATE FUNCTION public.tenant_can_read_capture (cid uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT
        EXISTS (
            SELECT
            FROM
                public.captures c
            WHERE
                c.id = cid
                AND public.current_tenant () IS NOT NULL
                AND (c.tenant_id = public.current_tenant ()
                    OR c.visibility = 'public'
                    OR EXISTS (
                        SELECT
                        FROM
                            public.revisions r
                        WHERE
                            r.capture_id = c.id
                            AND public.tenant_can_read_revision (r.id))))
$$;

CREATE FUNCTION public.capture_executor (cid uuid)
    RETURNS uuid
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT
        tenant_id
    FROM
        public.captures
    WHERE
        id = cid
$$;

-- Newest revision this tenant may read; RLS on revisions does the filtering.
CREATE FUNCTION public.visible_head (cid uuid)
    RETURNS uuid
    LANGUAGE sql
    STABLE
    AS $$
    SELECT
        id
    FROM
        public.revisions
    WHERE
        collection_id = cid
    ORDER BY
        created_at DESC,
        id DESC
    LIMIT 1
$$;

-- Hash comparison across tenants reveals no content.
CREATE FUNCTION public.ensure_entity_version (eid uuid, body jsonb, entity_data jsonb, entity_schema jsonb)
    RETURNS uuid
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    INSERT INTO public.entity_versions (entity_id, content_hash, data, schema)
        VALUES (eid, encode(digest(body::text, 'sha256'), 'hex'), entity_data, entity_schema)
    ON CONFLICT (entity_id, content_hash)
        DO UPDATE SET
            content_hash = excluded.content_hash
        RETURNING
            id
$$;

-- An identical observation by another source proves the stored content public.
CREATE FUNCTION public.publish_revision (rid uuid, cid uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    UPDATE
        public.revisions r
    SET
        visibility = 'public'
    WHERE
        r.id = rid
        AND EXISTS (
            SELECT
            FROM
                public.captures c
            WHERE
                c.id = cid
                AND c.collection_id = r.collection_id
                AND c.visibility = 'public'
                AND c.tenant_id = public.current_tenant ());
        DELETE FROM public.revision_access_requirements
        WHERE revision_id = rid
            AND EXISTS (
                SELECT
                FROM
                    public.revisions
                WHERE
                    id = rid
                    AND visibility = 'public');
$$;

-- Restricted objects an access check must cover to unlock a collection's
-- private history. Only identifiers are returned, never content.
CREATE FUNCTION public.access_requirements (aid uuid)
    RETURNS TABLE (
        platform text,
        kind text,
        object_scope text,
        external_id text)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'pg_catalog',
    'public'
    AS $$
    SELECT DISTINCT
        q.platform,
        q.kind,
        q.object_scope,
        q.external_id
    FROM
        public.revisions r
        JOIN public.revision_access_requirements q ON q.revision_id = r.id
    WHERE
        r.collection_id = aid
        AND public.current_tenant () IS NOT NULL
$$;

-- Whether a stored revision exists that this tenant cannot read yet.
CREATE FUNCTION public.has_hidden_revision (aid uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT
        EXISTS (
            SELECT
            FROM
                public.revisions r
            WHERE
                r.collection_id = aid
                AND public.current_tenant () IS NOT NULL
                AND NOT public.tenant_can_read_revision (r.id))
$$;

-- Media the adapter listed for this capture may reuse any stored copy.
CREATE FUNCTION public.cached_blob (key text)
    RETURNS TABLE (
        id uuid,
        hash text,
        size bigint)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'pg_catalog',
    'public'
    AS $$
    SELECT
        b.id,
        b.hash,
        b.size
    FROM
        public.assets a
        JOIN public.blobs b ON b.id = a.blob_id
    WHERE
        a.cache_key = key
        AND a.state = 'ready'
    LIMIT 1
$$;

-- Usage counts what the tenant saved and may read. The access rule matches
-- tenant_can_read_revision, evaluated as one set-based query on this hot path.
CREATE OR REPLACE FUNCTION public.tenant_usage ()
    RETURNS bigint
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    WITH owned_revisions AS MATERIALIZED (
        SELECT
            r.id,
            r.capture_id,
            r.content_bytes
        FROM
            public.tenant_collections ta
            JOIN public.collections a ON a.id = ta.collection_id
            JOIN public.revisions r ON r.collection_id = a.id
            JOIN public.captures c ON c.id = r.capture_id
            LEFT JOIN public.access_grants g ON g.tenant_id = ta.tenant_id
                AND (
                    g.platform,
                    g.kind,
                    g.object_scope,
                    g.external_id
) = (
                    a.platform,
                    a.kind,
                    a.object_scope,
                    a.external_id
)
                AND (
                    g.revoked_at IS NULL
                    OR r.created_at <= g.revoked_at
)
        WHERE
            ta.tenant_id = public.current_tenant (
)
            AND (
                r.visibility = 'public'
                OR c.tenant_id = ta.tenant_id
                OR (
                    g.tenant_id IS NOT NULL
                    AND NOT EXISTS (
                        SELECT
                        FROM
                            public.revision_access_requirements q
                        WHERE
                            q.revision_id = r.id
                            AND NOT public.tenant_has_access (q.platform, q.kind, q.object_scope, q.external_id, r.created_at)
                            AND NOT EXISTS (
                                SELECT
                                FROM
                                    public.collections qa
                                    JOIN public.revisions qr ON qr.collection_id = qa.id
                                WHERE (qa.platform,
                                    qa.kind,
                                    qa.object_scope,
                                    qa.external_id) = (q.platform,
                                    q.kind,
                                    q.object_scope,
                                    q.external_id)
                                AND qr.visibility = 'public'))))
),
image_content AS (
    SELECT DISTINCT
        b.hash,
        b.size
    FROM
        owned_revisions r
        JOIN public.assets m ON m.capture_id = r.capture_id
        JOIN public.blobs b ON b.id = m.blob_id
)
SELECT
    (coalesce((
            SELECT
                sum(content_bytes)
            FROM owned_revisions), 0) + coalesce((
            SELECT
                sum(size)
            FROM image_content), 0) + coalesce((
            SELECT
                sum(sr.size)
            FROM public.source_responses sr
            JOIN public.captures c ON c.id = sr.capture_id
            JOIN public.tenant_collections ta ON ta.collection_id = c.collection_id
        WHERE
            ta.tenant_id = public.current_tenant ()
        AND c.state IN ('complete', 'partial')
        AND (sr.visibility = 'public'
            OR sr.tenant_id = ta.tenant_id)), 0))::bigint
$$;

CREATE OR REPLACE FUNCTION public.mark_unreferenced (aid uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    UPDATE
        public.collections a
    SET
        unreferenced_at = coalesce(unreferenced_at, now())
    WHERE
        a.id = aid
        AND NOT EXISTS (
            SELECT
            FROM
                public.tenant_collections ta
            WHERE
                ta.collection_id = a.id)
$$;

-- Object GC is global; uploads no longer live under a tenant prefix.
DROP FUNCTION public.garbage_tenants ();

CREATE FUNCTION public.claim_garbage_objects (grace interval, n integer)
    RETURNS TABLE (
        id uuid,
        object_key text)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog',
    'public'
    AS $$
    UPDATE
        public.objects o
    SET
        state = 'deleting'
    WHERE
        o.id IN (
            SELECT
                x.id
            FROM
                public.objects x
            WHERE
                x.state IN ('garbage', 'deleting')
                AND x.created_at < now() - grace
            ORDER BY
                x.created_at
            LIMIT n
            FOR UPDATE
                SKIP LOCKED)
    RETURNING
        o.id,
        o.object_key
$$;

CREATE FUNCTION public.finish_garbage_object (oid uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    UPDATE
        public.assets
    SET
        object_id = NULL
    WHERE
        object_id = oid;
        DELETE FROM public.objects
        WHERE id = oid
            AND state = 'deleting';
$$;

-- 9. Row security. Object identities are shared; content follows revision access.
ALTER TABLE public.access_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.access_grants FORCE ROW LEVEL SECURITY;

ALTER TABLE public.revision_access_requirements ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.revision_access_requirements FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.access_grants
    USING (tenant_id = public.current_tenant ())
    WITH CHECK (tenant_id = public.current_tenant ());

CREATE POLICY shared_identity ON public.collections
    USING (public.current_tenant () IS NOT NULL)
    WITH CHECK (public.current_tenant () IS NOT NULL);

CREATE POLICY shared_identity ON public.entities
    USING (public.current_tenant () IS NOT NULL)
    WITH CHECK (public.current_tenant () IS NOT NULL);

CREATE POLICY shared_identity ON public.collection_identity_aliases
    USING (public.current_tenant () IS NOT NULL)
    WITH CHECK (public.current_tenant () IS NOT NULL);

-- Blob rows only describe stored bytes; reading them requires a readable asset.
CREATE POLICY shared_identity ON public.blobs
    USING (public.current_tenant () IS NOT NULL)
    WITH CHECK (public.current_tenant () IS NOT NULL);

-- The direct executor check also covers rows returned by the inserting statement,
-- which definer functions cannot see yet.
CREATE POLICY content_read ON public.revisions
    FOR SELECT
    USING (public.capture_executor (capture_id) = public.current_tenant ()
        OR public.tenant_can_read_revision (id));

CREATE POLICY content_insert ON public.revisions
    FOR INSERT
    WITH CHECK (public.capture_executor (capture_id) = public.current_tenant ());

CREATE POLICY content_read ON public.revision_access_requirements
    FOR SELECT
    USING (public.tenant_can_read_revision (revision_id));

CREATE POLICY content_insert ON public.revision_access_requirements
    FOR INSERT
    WITH CHECK (EXISTS (
        SELECT
        FROM
            public.revisions r
        WHERE
            r.id = revision_id
            AND public.capture_executor (r.capture_id) = public.current_tenant ()));

CREATE POLICY content_read ON public.revision_entities
    FOR SELECT
    USING (public.tenant_can_read_revision (revision_id));

CREATE POLICY content_insert ON public.revision_entities
    FOR INSERT
    WITH CHECK (EXISTS (
        SELECT
        FROM
            public.revisions r
        WHERE
            r.id = revision_id
            AND public.capture_executor (r.capture_id) = public.current_tenant ()));

CREATE POLICY content_read ON public.entity_relations
    FOR SELECT
    USING (public.tenant_can_read_revision (revision_id));

CREATE POLICY content_insert ON public.entity_relations
    FOR INSERT
    WITH CHECK (EXISTS (
        SELECT
        FROM
            public.revisions r
        WHERE
            r.id = revision_id
            AND public.capture_executor (r.capture_id) = public.current_tenant ()));

CREATE POLICY content_read ON public.entity_versions
    FOR SELECT
    USING (EXISTS (
        SELECT
        FROM
            public.revision_entities re
        WHERE
            re.entity_version_id = entity_versions.id));

CREATE POLICY content_read ON public.captures
    FOR SELECT
    USING (tenant_id = public.current_tenant ()
        OR public.tenant_can_read_capture (id));

CREATE POLICY content_insert ON public.captures
    FOR INSERT
    WITH CHECK (tenant_id = public.current_tenant ());

CREATE POLICY content_update ON public.captures
    FOR UPDATE
    USING (tenant_id = public.current_tenant ())
    WITH CHECK (tenant_id = public.current_tenant ());

CREATE POLICY content_read ON public.assets
    FOR SELECT
    USING (public.tenant_can_read_capture (capture_id));

CREATE POLICY content_insert ON public.assets
    FOR INSERT
    WITH CHECK (public.capture_executor (capture_id) = public.current_tenant ());

CREATE POLICY content_update ON public.assets
    FOR UPDATE
    USING (public.capture_executor (capture_id) = public.current_tenant ())
    WITH CHECK (public.capture_executor (capture_id) = public.current_tenant ());

-- Account responses may contain viewer-specific fields; only the fetching tenant reads them.
CREATE POLICY content_visibility ON public.source_responses
    USING (tenant_id = public.current_tenant ()
        OR (visibility = 'public'
        AND public.current_tenant () IS NOT NULL))
    WITH CHECK (tenant_id = public.current_tenant ());

CREATE POLICY tenant_isolation ON public.objects
    USING (uploaded_by = public.current_tenant ())
    WITH CHECK (uploaded_by = public.current_tenant ());

-- 10. Verify the merge before committing.
DO $$
BEGIN
    IF EXISTS (
        SELECT
        FROM
            public.tenant_collections t
        WHERE
            NOT EXISTS (
                SELECT
                FROM
                    public.collections a
                WHERE
                    a.id = t.collection_id)) THEN
        RAISE EXCEPTION 'saved collection lost during merge';
END IF;
    IF EXISTS (
        SELECT
        FROM
            public.assets a
        WHERE
            a.blob_id IS NOT NULL
            AND NOT EXISTS (
                SELECT
                FROM
                    public.blobs b
                WHERE
                    b.id = a.blob_id)) THEN
        RAISE EXCEPTION 'asset lost its blob during merge';
END IF;
    IF EXISTS (
        SELECT
        FROM
            public.revisions r
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.payload -> 'graph' -> 'entities', '[]'::jsonb)) entity
    WHERE
        entity ? 'version_id'
        AND NOT EXISTS (
            SELECT
            FROM
                public.entity_versions v
            WHERE
                v.id::text = entity ->> 'version_id'
                AND v.entity_id::text = entity ->> 'id')) THEN
    RAISE EXCEPTION 'revision snapshot references a merged entity';
END IF;
END
$$;
