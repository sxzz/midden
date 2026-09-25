CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT
        FROM
            pg_roles
        WHERE
            rolname = 'monitor_app') THEN
    CREATE ROLE monitor_app LOGIN;
END IF;
END
$$;

CREATE TABLE IF NOT EXISTS schema_versions (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

-- Global operating settings, including service credentials; administrator writes only.
CREATE TABLE IF NOT EXISTS config (
    key text PRIMARY KEY,
    value text NOT NULL,
    value_type text GENERATED ALWAYS AS ( CASE WHEN key IN ('telegram_bot_token', 'telegram_channel_id') THEN
        'text'
    ELSE
        'integer'
    END) STORED,
    sensitive boolean GENERATED ALWAYS AS (key IN ('telegram_bot_token')) STORED,
    updated_at timestamptz NOT NULL DEFAULT now(), CHECK (CASE WHEN key = 'telegram_bot_token' THEN
        length(value) <= 4096 AND (value = '' OR value ~ '^[0-9]+:[A-Za-z0-9_-]+$')
    WHEN key = 'telegram_channel_id' THEN
        value = '' OR value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ELSE
        value ~ '^[0-9]{1,16}$' AND value::numeric BETWEEN 1 AND CASE WHEN key IN ('archive_retention_days', 'object_gc_grace_hours') THEN
            36500
        WHEN key IN ('tenant_quota_bytes', 'max_image_bytes') THEN
            1125899906842624
        WHEN key IN ('capture_rate', 'tenant_concurrency', 'capture_workers', 'download_workers', 'control_workers', 'delivery_workers', 'max_images') THEN
            1000
        ELSE
            0
        END
    END)
);

INSERT INTO config (key, value)
VALUES
    ('archive_retention_days', '7'),
    ('object_gc_grace_hours', '24'),
    ('tenant_quota_bytes', '1073741824'),
    ('capture_rate', '10'),
    ('tenant_concurrency', '2'),
    ('capture_workers', '4'),
    ('download_workers', '8'),
    ('control_workers', '4'),
    ('delivery_workers', '2'),
    ('max_image_bytes', '20971520'),
    ('max_images', '20'),
    ('telegram_bot_token', ''),('telegram_channel_id','')
ON CONFLICT (key)
    DO NOTHING;

CREATE OR REPLACE FUNCTION default_tenant_quota ()
    RETURNS bigint
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
    AS $$
    SELECT
        value::bigint
    FROM
        public.config
    WHERE
        key = 'tenant_quota_bytes'
$$;

CREATE TABLE IF NOT EXISTS tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid () CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid),
    reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    quota_bytes bigint NOT NULL DEFAULT default_tenant_quota (),
    rate_start timestamptz NOT NULL DEFAULT now(),
    rate_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channels (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    external_id text NOT NULL,
    next_offset bigint NOT NULL DEFAULT 0,
    UNIQUE (kind, external_id)
);

CREATE TABLE IF NOT EXISTS identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    channel_id uuid NOT NULL REFERENCES channels,
    external_id text NOT NULL,
    UNIQUE (channel_id, external_id),
    UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    digest text UNIQUE NOT NULL,
    revoked boolean NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS connections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    adapter_id text NOT NULL,
    provider_id text NOT NULL,
    name text NOT NULL,
    account_id text,
    state text NOT NULL CHECK (state IN ('pending', 'ready', 'reauth_required', 'revoked')),
    credential_ref text,
    UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS archives (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN visibility = 'public' THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    platform text NOT NULL DEFAULT 'x',
    scope text NOT NULL DEFAULT 'public',
    kind text NOT NULL DEFAULT 'post',
    object_scope text NOT NULL DEFAULT '',
    external_id text NOT NULL,
    url text NOT NULL,
    provider_id text NOT NULL,
    connection_id uuid,
    current_revision uuid,
    unreferenced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    observed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (data_scope, platform, scope, kind, object_scope, external_id),
    UNIQUE (data_scope, id),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS captures (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN visibility = 'public' THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    archive_id uuid NOT NULL,
    provider_id text NOT NULL,
    connection_id uuid,
    scope text NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'downloading', 'complete', 'partial', 'failed')),
    error text NOT NULL DEFAULT '',payload jsonb,content_reserved bigint NOT NULL DEFAULT 0,adapter_version text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    revision_id uuid,
    UNIQUE (archive_id, id),
    UNIQUE (data_scope, id),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (data_scope, archive_id) REFERENCES archives (data_scope, id),
    FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_capture ON captures (archive_id)
WHERE
    state IN ('queued', 'downloading');

CREATE INDEX IF NOT EXISTS archive_recent ON archives (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN visibility = 'public' THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    archive_id uuid NOT NULL,
    capture_id uuid NOT NULL,
    content_hash text NOT NULL,
    payload jsonb NOT NULL,
    content_bytes bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (data_scope, id),
    UNIQUE (tenant_id, id),
    UNIQUE (archive_id, id),
    UNIQUE (tenant_id, capture_id),
    FOREIGN KEY (data_scope, archive_id) REFERENCES archives (data_scope, id),
    FOREIGN KEY (data_scope, capture_id) REFERENCES captures (data_scope, id),
    FOREIGN KEY (archive_id, capture_id) REFERENCES captures (archive_id, id),
    FOREIGN KEY (tenant_id, capture_id) REFERENCES captures (tenant_id, id)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT
            1
        FROM
            pg_constraint
        WHERE
            conname = 'archive_revision_fk') THEN
    ALTER TABLE archives
        ADD CONSTRAINT archive_revision_fk FOREIGN KEY (id, current_revision) REFERENCES revisions (archive_id, id);
END IF;
END
$$;

CREATE TABLE IF NOT EXISTS blobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN visibility = 'public' THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    hash text NOT NULL,
    object_key text NOT NULL UNIQUE,
    size bigint NOT NULL,
    mime text NOT NULL,
    UNIQUE (data_scope, hash),
    UNIQUE (data_scope, id),
    UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    object_key text NOT NULL UNIQUE,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'attached', 'garbage', 'deleting')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN visibility = 'public' THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    capture_id uuid NOT NULL,
    position integer NOT NULL,
    source_url text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'failed')),
    error text NOT NULL DEFAULT '',
    blob_id uuid,
    object_id uuid,
    reserved_bytes bigint NOT NULL DEFAULT 0,
    UNIQUE (data_scope, id),
    UNIQUE (tenant_id, id),
    UNIQUE (capture_id, position),
    FOREIGN KEY (data_scope, capture_id) REFERENCES captures (data_scope, id),
    FOREIGN KEY (tenant_id, capture_id) REFERENCES captures (tenant_id, id),
    FOREIGN KEY (data_scope, blob_id) REFERENCES blobs (data_scope, id),
    FOREIGN KEY (tenant_id, object_id) REFERENCES objects (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    capture_id uuid NOT NULL,
    identity_id uuid,
    channel_id uuid,
    chat_id text,
    idem_key text NOT NULL,
    fingerprint text NOT NULL,
    state text NOT NULL DEFAULT 'pending',
    message_id bigint NOT NULL DEFAULT 0,
    progress integer NOT NULL DEFAULT 0,
    status_text text NOT NULL DEFAULT '',
    error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, idem_key),
    FOREIGN KEY (capture_id) REFERENCES captures (id),
    FOREIGN KEY (tenant_id, identity_id) REFERENCES identities (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS inbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    channel_id uuid NOT NULL REFERENCES channels,
    update_id bigint NOT NULL,
    payload jsonb NOT NULL,
    state text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (channel_id, update_id),
    UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS replies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    inbox_id uuid NOT NULL UNIQUE,
    chat_id text NOT NULL,
    text text NOT NULL,
    buttons jsonb NOT NULL DEFAULT '[]',
    state text NOT NULL DEFAULT 'pending',
    message_id bigint NOT NULL DEFAULT 0,
    FOREIGN KEY (tenant_id, inbox_id) REFERENCES inbox (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS tenant_archives (
    tenant_id uuid NOT NULL REFERENCES tenants,
    archive_id uuid NOT NULL REFERENCES archives,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, archive_id)
);

CREATE INDEX IF NOT EXISTS collection_recent ON tenant_archives (tenant_id, created_at DESC, archive_id DESC);

-- Content has a separate sharing boundary from the tenant that paid for its creation.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['archives', 'captures', 'revisions', 'assets', 'blobs'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS content_read ON %I', t);
        EXECUTE format('DROP POLICY IF EXISTS content_insert ON %I', t);
        EXECUTE format('DROP POLICY IF EXISTS content_update ON %I', t);
        EXECUTE format('CREATE POLICY content_read ON %I FOR SELECT USING (nullif(current_setting(''app.tenant_id'',true),'''') IS NOT NULL AND (visibility=''public'' OR tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid))', t);
        EXECUTE format('CREATE POLICY content_insert ON %I FOR INSERT WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
        IF t = 'archives' THEN
            EXECUTE format('CREATE POLICY content_update ON %I FOR UPDATE USING (visibility=''public'' OR tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (visibility=''public'' OR tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
        ELSE
            EXECUTE format('CREATE POLICY content_update ON %I FOR UPDATE USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
        END IF;
    END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION immutable_content_owner ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.visibility <> OLD.visibility THEN
        RAISE EXCEPTION 'content owner and visibility are immutable';
    END IF;
    RETURN NEW;
END
$$;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['archives', 'captures', 'revisions', 'assets', 'blobs'] LOOP
        EXECUTE format('CREATE OR REPLACE TRIGGER immutable_content_owner BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_content_owner()', t);
    END LOOP;
END
$$;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tenants', 'identities', 'tokens', 'connections', 'objects', 'submissions', 'tenant_archives', 'inbox', 'replies'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (
            SELECT
            FROM
                pg_policies
            WHERE
                tablename = t
                AND policyname = 'tenant_isolation') THEN
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%I = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (%I = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t, CASE WHEN t = 'tenants' THEN
                'id'
            ELSE
                'tenant_id'
            END, CASE WHEN t = 'tenants' THEN
                'id'
            ELSE
                'tenant_id'
            END);
    END IF;
END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO monitor_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, identities, connections, archives, captures, revisions, blobs, objects, assets, submissions, inbox, replies TO monitor_app;

GRANT SELECT, UPDATE ON channels TO monitor_app;

-- Only these exact authentication entrypoints may operate without a tenant context.
CREATE OR REPLACE FUNCTION resolve_identity (cid uuid, external_user text, quota bigint)
    RETURNS TABLE (
        identity_id uuid,
        tenant_id uuid)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
DECLARE
    tid uuid;
    iid uuid;
BEGIN
    PERFORM
        pg_advisory_xact_lock(hashtextextended(cid::text || ':' || external_user, 0));
    SELECT
        i.id,
        i.tenant_id
    INTO
        iid,
        tid
    FROM
        public.identities i
    WHERE
        i.channel_id = cid
        AND i.external_id = external_user;
    IF iid IS NULL THEN
        INSERT INTO public.tenants (quota_bytes)
            VALUES (quota)
        RETURNING
            id
        INTO
            tid;
        INSERT INTO public.identities (tenant_id, channel_id, external_id)
            VALUES (tid, cid, external_user)
        RETURNING
            id
        INTO
            iid;
    END IF;
    RETURN QUERY
    SELECT
        iid,
        tid;
END
$$;

CREATE OR REPLACE FUNCTION authenticate_token (d text)
    RETURNS uuid
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    SELECT
        tenant_id
    FROM
        public.tokens
    WHERE
        digest = d
        AND NOT revoked
$$;

REVOKE ALL ON FUNCTION resolve_identity (uuid, text, bigint), authenticate_token (text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_identity (uuid, text, bigint), authenticate_token (text) TO monitor_app;

INSERT INTO schema_versions (version)
    VALUES (1)
ON CONFLICT
    DO NOTHING;

CREATE OR REPLACE FUNCTION garbage_tenants ()
    RETURNS TABLE (
        tenant_id uuid)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    SELECT DISTINCT
        o.tenant_id
    FROM
        public.objects o
    WHERE
        o.state IN ('garbage', 'deleting')
        AND o.created_at < now() - (
            SELECT
                value::bigint
            FROM
                public.config
            WHERE
                key = 'object_gc_grace_hours') * interval '1 hour'
    LIMIT 100
$$;

REVOKE ALL ON FUNCTION garbage_tenants () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION garbage_tenants () TO monitor_app;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT
            1
        FROM
            pg_constraint
        WHERE
            conname = 'capture_revision_fk') THEN
    ALTER TABLE captures
        ADD CONSTRAINT capture_revision_fk FOREIGN KEY (archive_id, revision_id) REFERENCES revisions (archive_id, id);
END IF;
END
$$;

-- Linking a private object requires access to that object as well as ownership of the link.
DROP POLICY IF EXISTS submission_target ON submissions;

CREATE POLICY submission_target ON submissions AS RESTRICTIVE
    FOR ALL
    USING (TRUE)
    WITH CHECK (EXISTS (
        SELECT
        FROM
            captures c
        WHERE
            c.id = capture_id));

DROP POLICY IF EXISTS collection_target ON tenant_archives;

CREATE POLICY collection_target ON tenant_archives AS RESTRICTIVE
    FOR ALL
    USING (TRUE)
    WITH CHECK (EXISTS (
        SELECT
        FROM
            archives a
        WHERE
            a.id = archive_id));

-- Only the capture's executing tenant may schedule its subscribers' deliveries.
CREATE OR REPLACE FUNCTION capture_deliveries (cid uuid)
    RETURNS TABLE (
        tenant_id uuid,
        id uuid)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    SELECT
        s.tenant_id,
        s.id
    FROM
        public.submissions s
        JOIN public.captures c ON c.id = s.capture_id
    WHERE
        c.id = cid
        AND c.tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid
        AND s.chat_id IS NOT NULL
        AND s.state = 'pending'
$$;

REVOKE ALL ON FUNCTION capture_deliveries (uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION capture_deliveries (uuid) TO monitor_app;

-- Bill the authenticated tenant's collection, independently of physical ownership.
CREATE OR REPLACE FUNCTION tenant_usage ()
    RETURNS bigint
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
    AS $$
    WITH owned_revisions AS MATERIALIZED (
        SELECT
            r.id,
            r.capture_id,
            r.content_bytes
        FROM
            public.tenant_archives ta
            JOIN public.revisions r ON r.archive_id = ta.archive_id
        WHERE
            ta.tenant_id = nullif (
                current_setting(
                    'app.tenant_id', TRUE
), ''
)::uuid
),
    image_content AS (
        SELECT DISTINCT
            b.hash,
            b.size
        FROM
            owned_revisions r
            JOIN public.assets a ON a.capture_id = r.capture_id
            JOIN public.blobs b ON b.id = a.blob_id
)
    SELECT
        (coalesce((
                SELECT
                    sum(content_bytes)
                FROM owned_revisions), 0) + coalesce((
                SELECT
                    sum(size)
                FROM image_content), 0))::bigint
$$;

REVOKE ALL ON FUNCTION tenant_usage () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tenant_usage () TO monitor_app;

CREATE INDEX IF NOT EXISTS revisions_archive ON revisions (archive_id);

CREATE INDEX IF NOT EXISTS collection_archive ON tenant_archives (archive_id);

CREATE INDEX IF NOT EXISTS assets_blob ON assets (blob_id);

CREATE OR REPLACE FUNCTION mark_unreferenced (aid uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    UPDATE
        public.archives a
    SET
        unreferenced_at = coalesce(unreferenced_at, now())
    WHERE
        a.id = aid
        AND (a.visibility = 'public'
            OR a.tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid)
        AND NOT EXISTS (
            SELECT
            FROM
                public.tenant_archives ta
            WHERE
                ta.archive_id = a.id)
$$;

REVOKE ALL ON FUNCTION mark_unreferenced (uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION mark_unreferenced (uuid) TO monitor_app;

-- Bound each maintenance batch. Archive locks serialize deletion against collection creation.
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

REVOKE ALL ON FUNCTION collect_unreferenced_archives (interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION collect_unreferenced_archives (interval) TO monitor_app;
