-- Maintenance ran as one chain: the first failing step hid every later one, a
-- batch could consist entirely of rows that had to be skipped, and nothing
-- noticed a capture whose queue job was gone.
CREATE OR REPLACE FUNCTION public.collect_unreferenced_collections (grace interval)
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
        -- Skipped rows must not fill the batch: a hundred collections that
        -- cannot be removed yet would otherwise hide every one that can.
        AND NOT EXISTS (
            SELECT
            FROM
                public.tenant_collections ta
            WHERE
                ta.collection_id = a.id)
        AND NOT EXISTS (
            SELECT
            FROM
                public.captures c
            WHERE
                c.collection_id = a.id
                AND c.state IN ('queued', 'downloading'))
        AND NOT EXISTS (
            SELECT
            FROM
                public.submissions s
                JOIN public.captures c ON c.id = s.capture_id
            WHERE
                c.collection_id = a.id
                AND s.chat_id IS NOT NULL
                AND s.state = 'pending')
    ORDER BY
        a.unreferenced_at
    LIMIT 100
    FOR UPDATE
        SKIP LOCKED LOOP
            -- Checked again now that the row is locked: a save or capture may
            -- have committed after the batch was chosen.
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

-- An object that cannot be deleted waits before the next attempt instead of
-- heading every batch.
ALTER TABLE public.objects
    ADD COLUMN gc_attempts integer DEFAULT 0 NOT NULL,
    ADD COLUMN gc_after timestamp with time zone;

CREATE OR REPLACE FUNCTION public.claim_garbage_objects (grace interval, n integer)
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
                AND (x.gc_after IS NULL
                    OR x.gc_after <= now())
            ORDER BY
                x.created_at
            LIMIT n
            FOR UPDATE
                SKIP LOCKED)
    RETURNING
        o.id,
        o.object_key
$$;

CREATE FUNCTION public.defer_garbage_object (oid uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    UPDATE
        public.objects
    SET
        gc_attempts = gc_attempts + 1,
        gc_after = now() + least (interval '1 minute' * power(2, least (gc_attempts, 20)), interval '1 day')
    WHERE
        id = oid
        AND state = 'deleting'
$$;

-- Captures that are still running although no queue job can finish them: the
-- job row was lost or removed before its failure was recorded.
-- On a new database the queue's tables are created after these migrations,
-- so the body is not checked against them here.
SET LOCAL check_function_bodies = FALSE;

CREATE FUNCTION public.stale_captures (age interval, n integer)
    RETURNS TABLE (
        id uuid,
        tenant_id uuid)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'pg_catalog',
    'public'
    AS $$
    SELECT
        c.id,
        c.tenant_id
    FROM
        public.captures c
    WHERE
        c.state IN ('queued', 'downloading')
        AND c.created_at < now() - age
        AND NOT EXISTS (
            SELECT
            FROM
                public.river_job j
            WHERE
                j.kind = 'monitor_task'
                AND j.state IN ('available', 'pending', 'retryable', 'running', 'scheduled')
                AND (j.args ->> 'id' = c.id::text
                    OR j.args ->> 'id' IN (
                        SELECT
                            a.id::text
                        FROM
                            public.assets a
                        WHERE
                            a.capture_id = c.id)))
        ORDER BY
            c.created_at
        LIMIT n
$$;
