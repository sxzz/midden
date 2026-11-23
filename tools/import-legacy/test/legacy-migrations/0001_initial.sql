-- Initial schema after the web and Telegram channel split.
-- Existing deployments were migrated and rebased before adopting this baseline.
SET LOCAL check_function_bodies = FALSE;

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

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE FUNCTION public.authenticate_token (d text)
    RETURNS uuid
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT
        tenant_id
    FROM
        public.tokens
    WHERE
        digest = d
        AND NOT revoked
$$;

CREATE FUNCTION public.authenticate_web_session (d text)
    RETURNS uuid
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT
        tenant_id
    FROM
        public.web_sessions
    WHERE
        digest = d
        AND expires_at > now()
$$;

CREATE FUNCTION public.capture_deliveries (cid uuid)
    RETURNS TABLE (
        tenant_id uuid,
        id uuid)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog',
    'public'
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

CREATE FUNCTION public.channel_work_tenant (c uuid, w uuid, l uuid)
    RETURNS uuid
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT
        tenant_id
    FROM
        public.channel_work
    WHERE
        channel_id = c
        AND id = w
        AND lease = l
        AND (lease_until > now()
            OR state IN ('done', 'failed'))
$$;

CREATE TABLE public.channel_work (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    kind text NOT NULL,
    resource text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    state text DEFAULT 'pending'::text NOT NULL,
    lease uuid,
    lease_until timestamp with time zone,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    message_id bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_work_kind_check CHECK ((kind = ANY (ARRAY['event'::text, 'delivery'::text, 'reply'::text]))),
    CONSTRAINT channel_work_progress_check CHECK ((progress >= 0)),
    CONSTRAINT channel_work_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.channel_work FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.claim_channel_work (c uuid)
    RETURNS SETOF public.channel_work
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    UPDATE
        public.channel_work
    SET
        lease = gen_random_uuid (),
        lease_until = now() + interval '90 seconds'
    WHERE
        id = (
            SELECT
                id
            FROM
                public.channel_work
            WHERE
                channel_id = c
                AND state = 'pending'
                AND available_at <= now()
                AND (lease_until IS NULL
                    OR lease_until < now())
            ORDER BY
                created_at,
                id
            FOR UPDATE
                SKIP LOCKED
            LIMIT 1)
RETURNING
    *
$$;

CREATE FUNCTION public.cleanup_web_sessions ()
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    DELETE FROM public.web_sessions
    WHERE expires_at <= now()
$$;

CREATE FUNCTION public.collect_unreferenced_collections (grace interval)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
        public.collections a
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
                    public.tenant_collections ta
                WHERE
                    ta.collection_id = aid)
                OR EXISTS (
                    SELECT
                    FROM
                        public.captures c
                    WHERE
                        c.collection_id = aid
                        AND c.state IN ('queued', 'downloading'))
                OR EXISTS (
                    SELECT
                    FROM
                        public.submissions s
                        JOIN public.captures c ON c.id = s.capture_id
                    WHERE
                        c.collection_id = aid
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
        c.collection_id = aid;
    UPDATE
        public.collections
    SET
        current_revision = NULL
    WHERE
        id = aid;
    UPDATE
        public.captures
    SET
        revision_id = NULL
    WHERE
        collection_id = aid;
    DELETE FROM public.submissions
    WHERE capture_id IN (
            SELECT
                id
            FROM
                public.captures
            WHERE
                collection_id = aid);
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
                        collection_id = aid))
            AND state = 'pending';
    DELETE FROM public.assets
    WHERE capture_id IN (
            SELECT
                id
            FROM
                public.captures
            WHERE
                collection_id = aid);
    DELETE FROM public.revisions
    WHERE collection_id = aid;
    DELETE FROM public.captures
    WHERE collection_id = aid;
    DELETE FROM public.collections
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
            public.tenant_collections ta
        WHERE
            ta.tenant_id = sr.tenant_id
            AND ta.collection_id = c.collection_id);
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

CREATE FUNCTION public.default_tenant_quota ()
    RETURNS bigint
    LANGUAGE sql
    STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT
        value::bigint
    FROM
        public.config
    WHERE
        key = 'tenant_quota_bytes'
$$;

CREATE FUNCTION public.garbage_tenants ()
    RETURNS TABLE (
        tenant_id uuid)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog',
    'public'
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

CREATE FUNCTION public.immutable_content_owner ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.tenant_id <> OLD.tenant_id OR (NEW.visibility <> OLD.visibility AND NOT (TG_TABLE_NAME = 'captures' AND to_jsonb (OLD) ->> 'state' = 'queued' AND to_jsonb (OLD) ->> 'revision_id' IS NULL)) THEN
        RAISE EXCEPTION 'content owner and visibility are immutable';
    END IF;
    RETURN NEW;
END
$$;

CREATE FUNCTION public.mark_private_sources ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        UPDATE
            source_responses sr
        SET
            unreferenced_at = now()
        FROM
            captures c
        WHERE
            sr.capture_id = c.id
            AND c.collection_id = OLD.collection_id
            AND sr.tenant_id = OLD.tenant_id
            AND sr.visibility = 'private';
    ELSE
        UPDATE
            source_responses sr
        SET
            unreferenced_at = NULL
        FROM
            captures c
        WHERE
            sr.capture_id = c.id
            AND c.collection_id = NEW.collection_id
            AND sr.tenant_id = NEW.tenant_id
            AND sr.visibility = 'private';
    END IF;
    RETURN NULL;
END
$$;

CREATE FUNCTION public.mark_unreferenced (aid uuid)
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
        AND (a.visibility = 'public'
            OR a.tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid)
        AND NOT EXISTS (
            SELECT
            FROM
                public.tenant_collections ta
            WHERE
                ta.collection_id = a.id)
$$;

CREATE FUNCTION public.resolve_identity (cid uuid, external_user text, quota bigint)
    RETURNS TABLE (
        identity_id uuid,
        tenant_id uuid)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog',
    'public'
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

CREATE FUNCTION public.tenant_unlimited ()
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $$
    SELECT
        coalesce((
            SELECT
                unlimited
            FROM tenant_entitlements
            WHERE
                tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid), FALSE)
$$;

CREATE FUNCTION public.tenant_usage ()
    RETURNS bigint
    LANGUAGE sql
    STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    WITH owned_revisions AS MATERIALIZED (
        SELECT
            r.id,
            r.capture_id,
            r.content_bytes
        FROM
            public.tenant_collections ta
            JOIN public.revisions r ON r.collection_id = ta.collection_id
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
                FROM image_content), 0) + coalesce((
                SELECT
                    sum(sr.size)
                FROM source_responses sr
                JOIN captures c ON c.id = sr.capture_id
                JOIN tenant_collections ta ON ta.collection_id = c.collection_id
            WHERE
                ta.tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid
                AND c.state IN ('complete', 'partial')
                AND (sr.visibility = 'public'
                    OR sr.tenant_id = ta.tenant_id)), 0))::bigint
$$;

CREATE TABLE public.account_credentials (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    ciphertext bytea NOT NULL
);

ALTER TABLE ONLY public.account_credentials FORCE ROW LEVEL SECURITY;

CREATE TABLE public.account_dialogs (
    tenant_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    chat_id text NOT NULL,
    flow_id uuid NOT NULL,
    adapter_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

ALTER TABLE ONLY public.account_dialogs FORCE ROW LEVEL SECURITY;

CREATE TABLE public.assets (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN (visibility = 'public'::text) THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    capture_id uuid NOT NULL,
    "position" integer NOT NULL,
    source_url text NOT NULL,
    purpose text DEFAULT ''::text NOT NULL,
    alt_text text DEFAULT ''::text NOT NULL,
    sensitive boolean DEFAULT FALSE NOT NULL,
    cache_key text DEFAULT ''::text NOT NULL,
    kind text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    error text DEFAULT ''::text NOT NULL,
    blob_id uuid,
    object_id uuid,
    reserved_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT assets_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'video'::text]))),
    CONSTRAINT assets_purpose_length CHECK ((length(purpose) <= 128)),
    CONSTRAINT assets_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT assets_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);

ALTER TABLE ONLY public.assets FORCE ROW LEVEL SECURITY;

CREATE TABLE public.blobs (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN (visibility = 'public'::text) THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    access_scope text DEFAULT 'public'::text NOT NULL,
    hash text NOT NULL,
    object_key text NOT NULL,
    size bigint NOT NULL,
    mime text NOT NULL,
    CONSTRAINT blobs_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);

ALTER TABLE ONLY public.blobs FORCE ROW LEVEL SECURITY;

CREATE TABLE public.captures (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN (visibility = 'public'::text) THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    collection_id uuid NOT NULL,
    provider_id text NOT NULL,
    connection_id uuid,
    credential_revision bigint,
    refresh_from uuid,
    scope text NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    error text DEFAULT ''::text NOT NULL,
    payload jsonb,
    content_reserved bigint DEFAULT 0 NOT NULL,
    adapter_version text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    revision_id uuid,
    adapter_id text NOT NULL,
    automatic boolean DEFAULT FALSE NOT NULL,
    related_targets jsonb DEFAULT '[]'::jsonb NOT NULL,
    page_size integer DEFAULT 0 NOT NULL,
    page_cursor text DEFAULT ''::text NOT NULL,
    next_page_cursor text DEFAULT ''::text NOT NULL,
    is_collection boolean DEFAULT FALSE NOT NULL,
    max_batch_size integer DEFAULT 0 NOT NULL,
    paused boolean DEFAULT FALSE NOT NULL,
    CONSTRAINT captures_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'downloading'::text, 'complete'::text, 'partial'::text, 'failed'::text]))),
    CONSTRAINT captures_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);

ALTER TABLE ONLY public.captures FORCE ROW LEVEL SECURITY;

CREATE TABLE public.channel_media_cache (
    channel_kind text NOT NULL,
    account_id text NOT NULL,
    hash text NOT NULL,
    representation text NOT NULL,
    remote_id text NOT NULL
);

CREATE TABLE public.channels (
    id uuid NOT NULL,
    kind text NOT NULL,
    external_id text NOT NULL,
    next_offset bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.collections (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN (visibility = 'public'::text) THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    platform text NOT NULL,
    scope text DEFAULT 'public'::text NOT NULL,
    kind text NOT NULL,
    object_scope text DEFAULT ''::text NOT NULL,
    external_id text NOT NULL,
    url text NOT NULL,
    provider_id text NOT NULL,
    current_revision uuid,
    unreferenced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT collections_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);

ALTER TABLE ONLY public.collections FORCE ROW LEVEL SECURITY;

CREATE TABLE public.config (
    key text NOT NULL,
    value text NOT NULL,
    value_type text GENERATED ALWAYS AS ( CASE WHEN (key = ANY (ARRAY['telegram_bot_token'::text, 'telegram_channel_id'::text, 'additional_adapters'::text, 'web_app_url'::text])) THEN
        'text'::text
    ELSE
        'integer'::text
    END) STORED,
    sensitive boolean GENERATED ALWAYS AS ((key = ANY (ARRAY['telegram_bot_token'::text, 'additional_adapters'::text]))) STORED,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT config_check CHECK (CASE WHEN (key = 'web_app_url'::text) THEN
        ((value = ''::text) OR (value ~ '^https://[^/?#]+/app/$'::text))
    WHEN (key = 'additional_adapters'::text) THEN
        (jsonb_typeof((value)::jsonb) = 'array'::text)
    WHEN (key = 'telegram_bot_token'::text) THEN
        ((length(value) <= 4096) AND ((value = ''::text) OR (value ~ '^[0-9]+:[A-Za-z0-9_-]+$'::text)))
    WHEN (key = 'telegram_channel_id'::text) THEN
        ((value = ''::text) OR (value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text))
    ELSE
        ((value ~ '^[0-9]{1,16}$'::text) AND (((value)::numeric >= (1)::numeric) AND ((value)::numeric <= (
        CASE WHEN (key = ANY (ARRAY['collection_retention_days'::text, 'object_gc_grace_hours'::text])) THEN
            (36500)::bigint
        WHEN (key = ANY (ARRAY['tenant_quota_bytes'::text, 'max_image_bytes'::text, 'max_video_bytes'::text])) THEN
            '1125899906842624'::bigint
        WHEN (key = ANY (ARRAY['capture_rate'::text, 'tenant_concurrency'::text, 'connection_concurrency'::text, 'capture_workers'::text, 'download_workers'::text, 'control_workers'::text, 'delivery_workers'::text, 'max_media'::text])) THEN
            (1000)::bigint
        ELSE
            (0)::bigint
        END)::numeric)))
    END)
);

CREATE TABLE public.connection_imports (
    tenant_id uuid NOT NULL,
    request_id uuid NOT NULL,
    connection_id uuid NOT NULL
);

ALTER TABLE ONLY public.connection_imports FORCE ROW LEVEL SECURITY;

CREATE TABLE public.connections (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    adapter_id text NOT NULL,
    provider_id text NOT NULL,
    name text NOT NULL,
    account_id text,
    state text NOT NULL,
    credential_ref uuid,
    revision bigint DEFAULT 1 NOT NULL,
    username text,
    CONSTRAINT connections_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'ready'::text, 'reauth_required'::text, 'revoked'::text])))
);

ALTER TABLE ONLY public.connections FORCE ROW LEVEL SECURITY;

CREATE TABLE public.entities (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    visibility text NOT NULL,
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN (visibility = 'public'::text) THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    platform text NOT NULL,
    scope text NOT NULL,
    kind text NOT NULL,
    external_id text NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entities_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);

ALTER TABLE ONLY public.entities FORCE ROW LEVEL SECURITY;

CREATE TABLE public.entity_relations (
    revision_id uuid NOT NULL,
    source_key text NOT NULL,
    target_key text NOT NULL,
    kind text NOT NULL,
    tenant_id uuid NOT NULL,
    visibility text NOT NULL,
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN (visibility = 'public'::text) THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    CONSTRAINT entity_relations_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);

ALTER TABLE ONLY public.entity_relations FORCE ROW LEVEL SECURITY;

CREATE TABLE public.entity_versions (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    entity_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    visibility text NOT NULL,
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN (visibility = 'public'::text) THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    content_hash text NOT NULL,
    data jsonb NOT NULL,
    schema jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_versions_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);

ALTER TABLE ONLY public.entity_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE public.identities (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    external_id text NOT NULL
);

ALTER TABLE ONLY public.identities FORCE ROW LEVEL SECURITY;

CREATE TABLE public.inbox (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    update_id bigint NOT NULL,
    payload jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.inbox FORCE ROW LEVEL SECURITY;

CREATE TABLE public.objects (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    object_key text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT objects_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'attached'::text, 'garbage'::text, 'deleting'::text])))
);

ALTER TABLE ONLY public.objects FORCE ROW LEVEL SECURITY;

CREATE TABLE public.replies (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    inbox_id uuid NOT NULL,
    chat_id text NOT NULL,
    text text NOT NULL,
    buttons jsonb DEFAULT '[]'::jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    message_id bigint DEFAULT 0 NOT NULL,
    reply_to_message_id bigint DEFAULT 0 NOT NULL,
    entities jsonb DEFAULT '[]'::jsonb NOT NULL,
    progress integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.replies FORCE ROW LEVEL SECURITY;

CREATE TABLE public.revision_entities (
    revision_id uuid NOT NULL,
    entity_key text NOT NULL,
    entity_version_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    visibility text NOT NULL,
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN (visibility = 'public'::text) THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    is_root boolean NOT NULL,
    CONSTRAINT revision_entities_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);

ALTER TABLE ONLY public.revision_entities FORCE ROW LEVEL SECURITY;

CREATE TABLE public.revisions (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    data_scope uuid GENERATED ALWAYS AS ( CASE WHEN (visibility = 'public'::text) THEN
        '00000000-0000-0000-0000-000000000000'::uuid
    ELSE
        tenant_id
    END) STORED,
    collection_id uuid NOT NULL,
    capture_id uuid NOT NULL,
    content_hash text NOT NULL,
    payload jsonb NOT NULL,
    content_bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT revisions_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);

ALTER TABLE ONLY public.revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE public.schema_versions (
    version integer NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.source_responses (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    capture_id uuid NOT NULL,
    "position" integer NOT NULL,
    visibility text NOT NULL,
    body bytea NOT NULL,
    content_type text NOT NULL,
    source_url text NOT NULL,
    sha256 text NOT NULL,
    size bigint NOT NULL,
    unreferenced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_responses_check CHECK ((size = octet_length(body))),
    CONSTRAINT source_responses_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);

ALTER TABLE ONLY public.source_responses FORCE ROW LEVEL SECURITY;

CREATE TABLE public.submissions (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    capture_id uuid NOT NULL,
    identity_id uuid,
    channel_id uuid,
    chat_id text,
    idem_key text NOT NULL,
    fingerprint text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    message_id bigint DEFAULT 0 NOT NULL,
    reply_to_message_id bigint DEFAULT 0 NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    status_text text DEFAULT ''::text NOT NULL,
    error text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    input text DEFAULT ''::text NOT NULL,
    related_provider text DEFAULT ''::text NOT NULL,
    related_connection uuid,
    related_adapter text DEFAULT ''::text NOT NULL,
    related_state text DEFAULT 'none'::text NOT NULL,
    related_error text DEFAULT ''::text NOT NULL,
    related_source_collection uuid,
    collection_limit integer DEFAULT 0 NOT NULL,
    next_submission uuid,
    collection_stopped boolean DEFAULT FALSE NOT NULL,
    parent_submission uuid
);

ALTER TABLE ONLY public.submissions FORCE ROW LEVEL SECURITY;

CREATE TABLE public.tenant_collections (
    tenant_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    provider_id text NOT NULL,
    connection_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    adapter_id text NOT NULL
);

ALTER TABLE ONLY public.tenant_collections FORCE ROW LEVEL SECURITY;

CREATE TABLE public.tenant_entitlements (
    tenant_id uuid NOT NULL,
    unlimited boolean DEFAULT FALSE NOT NULL
);

ALTER TABLE ONLY public.tenant_entitlements FORCE ROW LEVEL SECURITY;

CREATE TABLE public.tenant_preferences (
    tenant_id uuid NOT NULL,
    default_connection_id uuid,
    adapter_id text NOT NULL
);

ALTER TABLE ONLY public.tenant_preferences FORCE ROW LEVEL SECURITY;

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    reserved_bytes bigint DEFAULT 0 NOT NULL,
    quota_bytes bigint DEFAULT public.default_tenant_quota () NOT NULL,
    rate_start timestamp with time zone DEFAULT now() NOT NULL,
    rate_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT tenants_id_check CHECK ((id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT tenants_reserved_bytes_check CHECK ((reserved_bytes >= 0))
);

ALTER TABLE ONLY public.tenants FORCE ROW LEVEL SECURITY;

CREATE TABLE public.tokens (
    id uuid DEFAULT gen_random_uuid () NOT NULL,
    tenant_id uuid NOT NULL,
    digest text NOT NULL,
    revoked boolean DEFAULT FALSE NOT NULL
);

ALTER TABLE ONLY public.tokens FORCE ROW LEVEL SECURITY;

CREATE TABLE public.web_sessions (
    digest text NOT NULL,
    tenant_id uuid NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '12:00:00'::interval) NOT NULL
);

ALTER TABLE ONLY public.web_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY public.account_credentials
    ADD CONSTRAINT account_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.account_credentials
    ADD CONSTRAINT account_credentials_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.account_dialogs
    ADD CONSTRAINT account_dialogs_pkey PRIMARY KEY (tenant_id, identity_id, chat_id);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_capture_id_position_key UNIQUE (capture_id, "position");

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_data_scope_id_key UNIQUE (data_scope, id);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_data_scope_access_scope_hash_key UNIQUE (data_scope, access_scope, hash);

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_data_scope_id_key UNIQUE (data_scope, id);

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.captures
    ADD CONSTRAINT captures_collection_id_id_key UNIQUE (collection_id, id);

ALTER TABLE ONLY public.captures
    ADD CONSTRAINT captures_data_scope_id_key UNIQUE (data_scope, id);

ALTER TABLE ONLY public.captures
    ADD CONSTRAINT captures_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.captures
    ADD CONSTRAINT captures_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.channel_media_cache
    ADD CONSTRAINT channel_media_cache_pkey PRIMARY KEY (channel_kind, account_id, hash, representation);

ALTER TABLE ONLY public.channel_work
    ADD CONSTRAINT channel_work_channel_id_kind_resource_key UNIQUE (channel_id, kind, resource);

ALTER TABLE ONLY public.channel_work
    ADD CONSTRAINT channel_work_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_kind_external_id_key UNIQUE (kind, external_id);

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_data_scope_id_key UNIQUE (data_scope, id);

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_data_scope_platform_scope_kind_object_scope_extern_ UNIQUE (data_scope, platform, scope, kind, object_scope, external_id);

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.config
    ADD CONSTRAINT config_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.connection_imports
    ADD CONSTRAINT connection_imports_pkey PRIMARY KEY (tenant_id, request_id);

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_tenant_id_adapter_id_id_key UNIQUE (tenant_id, adapter_id, id);

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_data_scope_id_key UNIQUE (data_scope, id);

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_data_scope_platform_scope_kind_external_id_key UNIQUE (data_scope, platform, scope, kind, external_id);

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.entity_relations
    ADD CONSTRAINT entity_relations_pkey PRIMARY KEY (revision_id, source_key, kind, target_key);

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_data_scope_id_key UNIQUE (data_scope, id);

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_entity_id_content_hash_key UNIQUE (entity_id, content_hash);

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_channel_id_external_id_key UNIQUE (channel_id, external_id);

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.inbox
    ADD CONSTRAINT inbox_channel_id_update_id_key UNIQUE (channel_id, update_id);

ALTER TABLE ONLY public.inbox
    ADD CONSTRAINT inbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.inbox
    ADD CONSTRAINT inbox_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_inbox_id_key UNIQUE (inbox_id);

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.revision_entities
    ADD CONSTRAINT revision_entities_data_scope_revision_id_entity_key_key UNIQUE (data_scope, revision_id, entity_key);

ALTER TABLE ONLY public.revision_entities
    ADD CONSTRAINT revision_entities_pkey PRIMARY KEY (revision_id, entity_key);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_collection_id_id_key UNIQUE (collection_id, id);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_data_scope_id_key UNIQUE (data_scope, id);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_tenant_id_capture_id_key UNIQUE (tenant_id, capture_id);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.schema_versions
    ADD CONSTRAINT schema_versions_pkey PRIMARY KEY (version);

ALTER TABLE ONLY public.source_responses
    ADD CONSTRAINT source_responses_capture_id_position_key UNIQUE (capture_id, "position");

ALTER TABLE ONLY public.source_responses
    ADD CONSTRAINT source_responses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submission_tenant_identity UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_tenant_id_idem_key_key UNIQUE (tenant_id, idem_key);

ALTER TABLE ONLY public.tenant_collections
    ADD CONSTRAINT tenant_collections_pkey PRIMARY KEY (tenant_id, collection_id);

ALTER TABLE ONLY public.tenant_entitlements
    ADD CONSTRAINT tenant_entitlements_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY public.tenant_preferences
    ADD CONSTRAINT tenant_preferences_pkey PRIMARY KEY (tenant_id, adapter_id);

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_digest_key UNIQUE (digest);

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.web_sessions
    ADD CONSTRAINT web_sessions_pkey PRIMARY KEY (digest);

CREATE INDEX assets_blob ON public.assets USING btree (blob_id);

CREATE INDEX assets_cache ON public.assets USING btree (data_scope, cache_key)
WHERE ((state = 'ready'::text) AND (cache_key <> ''::text));

CREATE INDEX channel_work_pending ON public.channel_work USING btree (channel_id, available_at, created_at)
WHERE (state = 'pending'::text);

CREATE INDEX collection_collection ON public.tenant_collections USING btree (collection_id);

CREATE INDEX collection_recent ON public.tenant_collections USING btree (tenant_id, created_at DESC, collection_id DESC);

CREATE INDEX collections_recent ON public.collections USING btree (tenant_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX one_active_capture ON public.captures USING btree (collection_id, adapter_id, provider_id, COALESCE(connection_id, '00000000-0000-0000-0000-000000000000'::uuid), md5(page_cursor), page_size, automatic)
WHERE (state = ANY (ARRAY['queued'::text, 'downloading'::text]));

CREATE UNIQUE INDEX one_revision_root ON public.revision_entities USING btree (revision_id)
WHERE
    is_root;

CREATE INDEX revision_entity_version ON public.revision_entities USING btree (entity_version_id);

CREATE INDEX revisions_collection ON public.revisions USING btree (collection_id);

CREATE INDEX submission_parent ON public.submissions USING btree (parent_submission)
WHERE (parent_submission IS NOT NULL);

CREATE UNIQUE INDEX unique_active_account ON public.connections USING btree (tenant_id, adapter_id, provider_id, account_id)
WHERE ((state <> 'revoked'::text) AND (account_id IS NOT NULL) AND (account_id <> ''::text));

CREATE INDEX web_sessions_expiry ON public.web_sessions USING btree (expires_at);

CREATE TRIGGER immutable_content_owner
    BEFORE UPDATE ON public.assets
    FOR EACH ROW
    EXECUTE FUNCTION public.immutable_content_owner ();

CREATE TRIGGER immutable_content_owner
    BEFORE UPDATE ON public.blobs
    FOR EACH ROW
    EXECUTE FUNCTION public.immutable_content_owner ();

CREATE TRIGGER immutable_content_owner
    BEFORE UPDATE ON public.captures
    FOR EACH ROW
    EXECUTE FUNCTION public.immutable_content_owner ();

CREATE TRIGGER immutable_content_owner
    BEFORE UPDATE ON public.collections
    FOR EACH ROW
    EXECUTE FUNCTION public.immutable_content_owner ();

CREATE TRIGGER immutable_content_owner
    BEFORE UPDATE ON public.revisions
    FOR EACH ROW
    EXECUTE FUNCTION public.immutable_content_owner ();

CREATE TRIGGER private_source_retention
    AFTER INSERT OR DELETE ON public.tenant_collections
    FOR EACH ROW
    EXECUTE FUNCTION public.mark_private_sources ();

ALTER TABLE ONLY public.account_credentials
    ADD CONSTRAINT account_credentials_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.account_dialogs
    ADD CONSTRAINT account_dialogs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.account_dialogs
    ADD CONSTRAINT account_dialogs_tenant_id_identity_id_fkey FOREIGN KEY (tenant_id, identity_id) REFERENCES public.identities (tenant_id, id);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_data_scope_blob_id_fkey FOREIGN KEY (data_scope, blob_id) REFERENCES public.blobs (data_scope, id);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_data_scope_capture_id_fkey FOREIGN KEY (data_scope, capture_id) REFERENCES public.captures (data_scope, id);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_tenant_id_capture_id_fkey FOREIGN KEY (tenant_id, capture_id) REFERENCES public.captures (tenant_id, id);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_tenant_id_object_id_fkey FOREIGN KEY (tenant_id, object_id) REFERENCES public.objects (tenant_id, id);

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.captures
    ADD CONSTRAINT capture_revision_fk FOREIGN KEY (collection_id, revision_id) REFERENCES public.revisions (collection_id, id);

ALTER TABLE ONLY public.captures
    ADD CONSTRAINT captures_data_scope_collection_id_fkey FOREIGN KEY (data_scope, collection_id) REFERENCES public.collections (data_scope, id);

ALTER TABLE ONLY public.captures
    ADD CONSTRAINT captures_tenant_id_connection_id_fkey FOREIGN KEY (tenant_id, connection_id) REFERENCES public.connections (tenant_id, id);

ALTER TABLE ONLY public.captures
    ADD CONSTRAINT captures_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.channel_work
    ADD CONSTRAINT channel_work_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels (id);

ALTER TABLE ONLY public.channel_work
    ADD CONSTRAINT channel_work_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collection_revision_fk FOREIGN KEY (id, current_revision) REFERENCES public.revisions (collection_id, id);

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.connection_imports
    ADD CONSTRAINT connection_imports_tenant_id_connection_id_fkey FOREIGN KEY (tenant_id, connection_id) REFERENCES public.connections (tenant_id, id);

ALTER TABLE ONLY public.connection_imports
    ADD CONSTRAINT connection_imports_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_tenant_id_credential_ref_fkey FOREIGN KEY (tenant_id, credential_ref) REFERENCES public.account_credentials (tenant_id, id);

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.entity_relations
    ADD CONSTRAINT entity_relations_data_scope_revision_id_source_key_fkey FOREIGN KEY (data_scope, revision_id, source_key) REFERENCES public.revision_entities (data_scope, revision_id, entity_key) ON DELETE CASCADE;

ALTER TABLE ONLY public.entity_relations
    ADD CONSTRAINT entity_relations_data_scope_revision_id_target_key_fkey FOREIGN KEY (data_scope, revision_id, target_key) REFERENCES public.revision_entities (data_scope, revision_id, entity_key) ON DELETE CASCADE;

ALTER TABLE ONLY public.entity_relations
    ADD CONSTRAINT entity_relations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_data_scope_entity_id_fkey FOREIGN KEY (data_scope, entity_id) REFERENCES public.entities (data_scope, id);

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities (id) ON DELETE CASCADE;

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels (id);

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.inbox
    ADD CONSTRAINT inbox_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels (id);

ALTER TABLE ONLY public.inbox
    ADD CONSTRAINT inbox_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT next_submission_owner FOREIGN KEY (tenant_id, next_submission) REFERENCES public.submissions (tenant_id, id);

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT related_connection_owner FOREIGN KEY (tenant_id, related_connection) REFERENCES public.connections (tenant_id, id);

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_tenant_id_inbox_id_fkey FOREIGN KEY (tenant_id, inbox_id) REFERENCES public.inbox (tenant_id, id);

ALTER TABLE ONLY public.revision_entities
    ADD CONSTRAINT revision_entities_data_scope_entity_version_id_fkey FOREIGN KEY (data_scope, entity_version_id) REFERENCES public.entity_versions (data_scope, id);

ALTER TABLE ONLY public.revision_entities
    ADD CONSTRAINT revision_entities_data_scope_revision_id_fkey FOREIGN KEY (data_scope, revision_id) REFERENCES public.revisions (data_scope, id);

ALTER TABLE ONLY public.revision_entities
    ADD CONSTRAINT revision_entities_entity_version_id_fkey FOREIGN KEY (entity_version_id) REFERENCES public.entity_versions (id);

ALTER TABLE ONLY public.revision_entities
    ADD CONSTRAINT revision_entities_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.revisions (id) ON DELETE CASCADE;

ALTER TABLE ONLY public.revision_entities
    ADD CONSTRAINT revision_entities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_collection_id_capture_id_fkey FOREIGN KEY (collection_id, capture_id) REFERENCES public.captures (collection_id, id);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_data_scope_capture_id_fkey FOREIGN KEY (data_scope, capture_id) REFERENCES public.captures (data_scope, id);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_data_scope_collection_id_fkey FOREIGN KEY (data_scope, collection_id) REFERENCES public.collections (data_scope, id);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_tenant_id_capture_id_fkey FOREIGN KEY (tenant_id, capture_id) REFERENCES public.captures (tenant_id, id);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.source_responses
    ADD CONSTRAINT source_responses_tenant_id_capture_id_fkey FOREIGN KEY (tenant_id, capture_id) REFERENCES public.captures (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.source_responses
    ADD CONSTRAINT source_responses_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submission_parent_owner FOREIGN KEY (tenant_id, parent_submission) REFERENCES public.submissions (tenant_id, id) ON DELETE SET NULL (parent_submission);

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures (id);

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_tenant_id_identity_id_fkey FOREIGN KEY (tenant_id, identity_id) REFERENCES public.identities (tenant_id, id);

ALTER TABLE ONLY public.tenant_collections
    ADD CONSTRAINT tenant_collections_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.collections (id);

ALTER TABLE ONLY public.tenant_collections
    ADD CONSTRAINT tenant_collections_tenant_id_connection_id_fkey FOREIGN KEY (tenant_id, connection_id) REFERENCES public.connections (tenant_id, id);

ALTER TABLE ONLY public.tenant_collections
    ADD CONSTRAINT tenant_collections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.tenant_entitlements
    ADD CONSTRAINT tenant_entitlements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_preferences
    ADD CONSTRAINT tenant_preferences_tenant_id_adapter_id_default_connection_fkey FOREIGN KEY (tenant_id, adapter_id, default_connection_id) REFERENCES public.connections (tenant_id, adapter_id, id);

ALTER TABLE ONLY public.tenant_preferences
    ADD CONSTRAINT tenant_preferences_tenant_id_default_connection_id_fkey FOREIGN KEY (tenant_id, default_connection_id) REFERENCES public.connections (tenant_id, id);

ALTER TABLE ONLY public.tenant_preferences
    ADD CONSTRAINT tenant_preferences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id);

ALTER TABLE ONLY public.web_sessions
    ADD CONSTRAINT web_sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id) ON DELETE CASCADE;

ALTER TABLE public.account_credentials ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.account_dialogs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.blobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.captures ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.channel_work ENABLE ROW LEVEL SECURITY;

CREATE POLICY collection_target ON public.tenant_collections AS RESTRICTIVE
    USING (TRUE)
    WITH CHECK ((EXISTS (
        SELECT
        FROM
            public.collections a
        WHERE (a.id = tenant_collections.collection_id))));

ALTER TABLE public.collections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.connection_imports ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY content_insert ON public.assets
    FOR INSERT
    WITH CHECK ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid));

CREATE POLICY content_insert ON public.blobs
    FOR INSERT
    WITH CHECK ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid));

CREATE POLICY content_insert ON public.captures
    FOR INSERT
    WITH CHECK ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid));

CREATE POLICY content_insert ON public.collections
    FOR INSERT
    WITH CHECK ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid));

CREATE POLICY content_insert ON public.revisions
    FOR INSERT
    WITH CHECK ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid));

CREATE POLICY content_read ON public.assets
    FOR SELECT
    USING (((NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text) IS NOT NULL) AND ((visibility = 'public'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))));

CREATE POLICY content_read ON public.blobs
    FOR SELECT
    USING (((NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text) IS NOT NULL) AND ((visibility = 'public'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))));

CREATE POLICY content_read ON public.captures
    FOR SELECT
    USING (((NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text) IS NOT NULL) AND ((visibility = 'public'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))));

CREATE POLICY content_read ON public.collections
    FOR SELECT
    USING (((NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text) IS NOT NULL) AND ((visibility = 'public'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))));

CREATE POLICY content_read ON public.revisions
    FOR SELECT
    USING (((NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text) IS NOT NULL) AND ((visibility = 'public'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))));

CREATE POLICY content_update ON public.assets
    FOR UPDATE
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY content_update ON public.blobs
    FOR UPDATE
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY content_update ON public.captures
    FOR UPDATE
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY content_update ON public.collections
    FOR UPDATE
    USING (((visibility = 'public'::text)
        OR (tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid))) WITH CHECK (((visibility = 'public'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)));

CREATE POLICY content_update ON public.revisions
    FOR UPDATE
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY content_visibility ON public.entities
    USING (((visibility = 'public'::text)
        OR (tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid))) WITH CHECK (((visibility = 'public'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)));

CREATE POLICY content_visibility ON public.entity_relations
    USING (((visibility = 'public'::text)
        OR (tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid))) WITH CHECK (((visibility = 'public'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)));

CREATE POLICY content_visibility ON public.entity_versions
    USING (((visibility = 'public'::text)
        OR (tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid))) WITH CHECK (((visibility = 'public'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)));

CREATE POLICY content_visibility ON public.revision_entities
    USING (((visibility = 'public'::text)
        OR (tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid))) WITH CHECK (((visibility = 'public'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)));

CREATE POLICY content_visibility ON public.source_responses
    USING (((visibility = 'public'::text)
        OR (tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid))) WITH CHECK (((visibility = 'public'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)));

ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.entity_relations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.entity_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.identities ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.inbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.objects ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.replies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.revision_entities ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.source_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY submission_target ON public.submissions AS RESTRICTIVE
    USING (TRUE)
    WITH CHECK ((EXISTS (
        SELECT
        FROM
            public.captures c
        WHERE (c.id = submissions.capture_id))));

ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.tenant_collections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.tenant_entitlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.account_credentials
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.account_dialogs
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.channel_work
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.connection_imports
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.connections
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.identities
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.inbox
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.objects
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.replies
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.submissions
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.tenant_collections
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.tenant_entitlements
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.tenant_preferences
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.tenants
    USING ((id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.tokens
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));

CREATE POLICY tenant_isolation ON public.web_sessions
    USING ((tenant_id = (NULLIF (current_setting('app.tenant_id'::text, TRUE), ''::text))::uuid));

ALTER TABLE public.tenant_preferences ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.web_sessions ENABLE ROW LEVEL SECURITY;

REVOKE USAGE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO monitor_app;

REVOKE ALL ON FUNCTION public.authenticate_token (d text) FROM PUBLIC;

GRANT ALL ON FUNCTION public.authenticate_token (d text) TO monitor_app;

REVOKE ALL ON FUNCTION public.authenticate_web_session (d text) FROM PUBLIC;

GRANT ALL ON FUNCTION public.authenticate_web_session (d text) TO monitor_app;

REVOKE ALL ON FUNCTION public.capture_deliveries (cid uuid) FROM PUBLIC;

GRANT ALL ON FUNCTION public.capture_deliveries (cid uuid) TO monitor_app;

REVOKE ALL ON FUNCTION public.channel_work_tenant (c uuid, w uuid, l uuid) FROM PUBLIC;

GRANT ALL ON FUNCTION public.channel_work_tenant (c uuid, w uuid, l uuid) TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.channel_work TO monitor_app;

REVOKE ALL ON FUNCTION public.claim_channel_work (c uuid) FROM PUBLIC;

GRANT ALL ON FUNCTION public.claim_channel_work (c uuid) TO monitor_app;

REVOKE ALL ON FUNCTION public.cleanup_web_sessions () FROM PUBLIC;

GRANT ALL ON FUNCTION public.cleanup_web_sessions () TO monitor_app;

REVOKE ALL ON FUNCTION public.collect_unreferenced_collections (grace interval) FROM PUBLIC;

GRANT ALL ON FUNCTION public.collect_unreferenced_collections (grace interval) TO monitor_app;

REVOKE ALL ON FUNCTION public.garbage_tenants () FROM PUBLIC;

GRANT ALL ON FUNCTION public.garbage_tenants () TO monitor_app;

REVOKE ALL ON FUNCTION public.mark_unreferenced (aid uuid) FROM PUBLIC;

GRANT ALL ON FUNCTION public.mark_unreferenced (aid uuid) TO monitor_app;

REVOKE ALL ON FUNCTION public.resolve_identity (cid uuid, external_user text, quota bigint) FROM PUBLIC;

GRANT ALL ON FUNCTION public.resolve_identity (cid uuid, external_user text, quota bigint) TO monitor_app;

REVOKE ALL ON FUNCTION public.tenant_unlimited () FROM PUBLIC;

GRANT ALL ON FUNCTION public.tenant_unlimited () TO monitor_app;

REVOKE ALL ON FUNCTION public.tenant_usage () FROM PUBLIC;

GRANT ALL ON FUNCTION public.tenant_usage () TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.assets TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.blobs TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.captures TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.channel_media_cache TO monitor_app;

GRANT SELECT, UPDATE ON TABLE public.channels TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.collections TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.connections TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.identities TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.inbox TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.objects TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.replies TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.revisions TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.submissions TO monitor_app;

GRANT SELECT ON TABLE public.tenant_entitlements TO monitor_app;

GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.tenants TO monitor_app;

GRANT SELECT, INSERT, DELETE ON TABLE public.web_sessions TO monitor_app;

INSERT INTO public.config (key, value)
VALUES
    ('additional_adapters', '[]'),
    ('capture_rate', '10'),
    ('capture_workers', '4'),
    ('collection_retention_days', '7'),
    ('connection_concurrency', '1'),
    ('control_workers', '4'),
    ('delivery_workers', '2'),
    ('download_workers', '8'),
    ('max_image_bytes', '20971520'),
    ('max_media', '20'),
    ('max_video_bytes', '536870912'),
    ('object_gc_grace_hours', '24'),
    ('telegram_bot_token', ''),
    ('telegram_channel_id', ''),
    ('tenant_concurrency', '2'),
    ('tenant_quota_bytes', '1073741824'),
    ('web_app_url', '');

INSERT INTO public.schema_versions (version)
    VALUES (1);
