-- Quota checks summed the tenant's whole library on every submission, capture
-- and media file. The total is now kept on the tenant and measured again only
-- after the tenant's own content changed or once a minute, which is how long
-- another tenant's capture of shared content can go uncounted.
ALTER TABLE public.tenants
    ADD COLUMN used_bytes bigint DEFAULT 0 NOT NULL,
    ADD COLUMN used_at timestamp with time zone;

CREATE FUNCTION public.tenant_used ()
    RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
    tenant uuid := public.current_tenant ();
    used bigint;
    measured timestamp with time zone;
BEGIN
    IF public.tenant_unlimited () THEN
        RETURN 0;
    END IF;
    -- The row lock orders this after any transaction that is changing the
    -- tenant's content, so a measurement never overwrites a newer reset.
    SELECT
        used_bytes,
        used_at
    INTO
        used,
        measured
    FROM
        public.tenants
    WHERE
        id = tenant
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;
    IF measured IS NULL OR measured < clock_timestamp() - interval '1 minute' THEN
        used := public.tenant_usage ();
        UPDATE
            public.tenants
        SET
            used_bytes = used,
            used_at = clock_timestamp()
        WHERE
            id = tenant;
    END IF;
    RETURN used;
END
$$;

CREATE FUNCTION public.reset_tenant_used ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
    UPDATE
        public.tenants
    SET
        used_at = NULL
    WHERE
        id = coalesce(NEW.tenant_id, OLD.tenant_id)
        AND used_at IS NOT NULL;
    RETURN NULL;
END
$$;

CREATE TRIGGER tenant_used_reset
    AFTER INSERT OR DELETE ON public.tenant_collections
    FOR EACH ROW
    EXECUTE FUNCTION public.reset_tenant_used ();
