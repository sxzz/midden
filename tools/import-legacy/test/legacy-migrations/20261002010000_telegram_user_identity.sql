-- Telegram users keep one tenant across bots; other channel kinds stay scoped to their channel.
CREATE OR REPLACE FUNCTION public.resolve_identity (cid uuid, external_user text, quota bigint)
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
    channel_kind text;
BEGIN
    SELECT
        c.kind
    INTO
        STRICT channel_kind
    FROM
        public.channels c
    WHERE
        c.id = cid;
    -- Lock the shared user key so concurrent first contacts through different bots join one tenant.
    IF channel_kind = 'telegram' THEN
        PERFORM
            pg_advisory_xact_lock(hashtextextended('telegram:' || external_user, 0));
    ELSE
        PERFORM
            pg_advisory_xact_lock(hashtextextended(cid::text || ':' || external_user, 0));
    END IF;
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
    IF iid IS NOT NULL THEN
        RETURN QUERY
        SELECT
            iid,
            tid;
        RETURN;
    END IF;
    IF channel_kind = 'telegram' THEN
        SELECT
            i.tenant_id
        INTO
            tid
        FROM
            public.identities i
            JOIN public.channels c ON c.id = i.channel_id
        WHERE
            c.kind = 'telegram'
            AND i.external_id = external_user
        ORDER BY
            i.tenant_id
        LIMIT 1;
    END IF;
    IF tid IS NULL THEN
        INSERT INTO public.tenants (quota_bytes)
            VALUES (quota)
        RETURNING
            id
        INTO
            tid;
    END IF;
    INSERT INTO public.identities (tenant_id, channel_id, external_id)
        VALUES (tid, cid, external_user)
    RETURNING
        id
    INTO
        iid;
    RETURN QUERY
    SELECT
        iid,
        tid;
END
$$;
