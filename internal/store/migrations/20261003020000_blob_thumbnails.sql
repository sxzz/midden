-- A small derived image per stored blob, shown in lists instead of the
-- original. Derived data is shared like the blob itself and never counts
-- toward a tenant's usage. A failed row stops further attempts.
CREATE TABLE blob_thumbnails (
    blob_id uuid PRIMARY KEY REFERENCES blobs (id) ON DELETE CASCADE,
    state text NOT NULL CHECK (state IN ('ready', 'failed')),
    object_key text UNIQUE,
    size bigint,
    mime text,
    error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((state = 'ready') = (object_key IS NOT NULL AND size IS NOT NULL AND mime IS NOT NULL))
);

ALTER TABLE blob_thumbnails ENABLE ROW LEVEL SECURITY;

ALTER TABLE blob_thumbnails FORCE ROW LEVEL SECURITY;

CREATE POLICY shared_identity ON blob_thumbnails
    USING (current_tenant () IS NOT NULL)
    WITH CHECK (current_tenant () IS NOT NULL);

-- A thumbnail leaves with its blob; its object then goes through object GC.
CREATE FUNCTION discard_thumbnail_object ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
    UPDATE
        public.objects
    SET
        state = 'garbage'
    WHERE
        object_key = OLD.object_key;
    RETURN OLD;
END
$$;

CREATE TRIGGER discard_thumbnail_object
    AFTER DELETE ON blob_thumbnails
    FOR EACH ROW
    WHEN (OLD.object_key IS NOT NULL)
    EXECUTE FUNCTION discard_thumbnail_object ();

-- Blobs stored before thumbnails existed, each with a tenant that captured it
-- to run the task as. Maintenance runs outside any tenant.
CREATE FUNCTION blobs_missing_thumbnails (n integer)
    RETURNS TABLE (
        blob_id uuid,
        tenant_id uuid)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'pg_catalog',
    'public'
    AS $$
    SELECT
        b.id,
        owner.tenant_id
    FROM
        public.blobs b
    CROSS JOIN LATERAL (
        SELECT
            c.tenant_id
        FROM
            public.assets a
            JOIN public.captures c ON c.id = a.capture_id
        WHERE
            a.blob_id = b.id
            AND c.tenant_id IS NOT NULL
        LIMIT 1)
    OWNER
WHERE
    NOT EXISTS (
        SELECT
        FROM
            public.blob_thumbnails t
        WHERE
            t.blob_id = b.id)
LIMIT n
$$;
