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

CREATE TABLE IF NOT EXISTS tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    quota_bytes bigint NOT NULL DEFAULT 1073741824,
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
    platform text NOT NULL DEFAULT 'x',
    scope text NOT NULL DEFAULT 'public',
    kind text NOT NULL DEFAULT 'post',
    object_scope text NOT NULL DEFAULT '',
    external_id text NOT NULL,
    url text NOT NULL,
    provider_id text NOT NULL,
    connection_id uuid,
    current_revision uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    observed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, platform, scope, kind, object_scope, external_id),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS captures (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    archive_id uuid NOT NULL,
    provider_id text NOT NULL,
    connection_id uuid,
    scope text NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'downloading', 'complete', 'partial', 'failed')),
    error text NOT NULL DEFAULT '',payload jsonb,content_reserved bigint NOT NULL DEFAULT 0,adapter_version text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, archive_id) REFERENCES archives (tenant_id, id),
    FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id)
);

ALTER TABLE captures
    ADD COLUMN IF NOT EXISTS revision_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_capture ON captures (tenant_id, archive_id)
WHERE
    state IN ('queued', 'downloading');

CREATE INDEX IF NOT EXISTS archive_recent ON archives (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    archive_id uuid NOT NULL,
    capture_id uuid NOT NULL,
    content_hash text NOT NULL,
    payload jsonb NOT NULL,
    content_bytes bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, capture_id),
    FOREIGN KEY (tenant_id, archive_id) REFERENCES archives (tenant_id, id),
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
        ADD CONSTRAINT archive_revision_fk FOREIGN KEY (tenant_id, current_revision) REFERENCES revisions (tenant_id, id);
END IF;
END
$$;

CREATE TABLE IF NOT EXISTS blobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    tenant_id uuid NOT NULL REFERENCES tenants,
    hash text NOT NULL,
    object_key text NOT NULL UNIQUE,
    size bigint NOT NULL,
    mime text NOT NULL,
    UNIQUE (tenant_id, hash),
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
    capture_id uuid NOT NULL,
    position integer NOT NULL,
    source_url text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'failed')),
    error text NOT NULL DEFAULT '',
    blob_id uuid,
    object_id uuid,
    reserved_bytes bigint NOT NULL DEFAULT 0,
    UNIQUE (tenant_id, id),
    UNIQUE (capture_id, position),
    FOREIGN KEY (tenant_id, capture_id) REFERENCES captures (tenant_id, id),
    FOREIGN KEY (tenant_id, blob_id) REFERENCES blobs (tenant_id, id),
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
    error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, idem_key),
    FOREIGN KEY (tenant_id, capture_id) REFERENCES captures (tenant_id, id),
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
    state text NOT NULL DEFAULT 'pending',
    message_id bigint NOT NULL DEFAULT 0,
    FOREIGN KEY (tenant_id, inbox_id) REFERENCES inbox (tenant_id, id)
);

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tenants', 'identities', 'tokens', 'connections', 'archives', 'captures', 'revisions', 'blobs', 'objects', 'assets', 'submissions', 'inbox', 'replies'] LOOP
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
        AND o.created_at < now() - interval '24 hours'
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
        ADD CONSTRAINT capture_revision_fk FOREIGN KEY (tenant_id, revision_id) REFERENCES revisions (tenant_id, id);
END IF;
END
$$;
