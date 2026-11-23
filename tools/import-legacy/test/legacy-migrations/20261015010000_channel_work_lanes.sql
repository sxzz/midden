-- Consecutive failed attempts, so a work that keeps failing backs off instead
-- of being retried every few seconds.
ALTER TABLE public.channel_work
    ADD COLUMN failures integer DEFAULT 0 NOT NULL;

-- Commands and deliveries are claimed by separate workers so a delivery stuck
-- on a slow upload never keeps the bot from answering. A null lane claims both.
DROP FUNCTION public.claim_channel_work (c uuid);

CREATE FUNCTION public.claim_channel_work (c uuid, lane text)
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
                AND (lane IS NULL
                    OR (lane = 'event') = (kind = 'event'))
            ORDER BY
                created_at,
                id
            FOR UPDATE
                SKIP LOCKED
            LIMIT 1)
RETURNING
    *
$$;

REVOKE ALL ON FUNCTION public.claim_channel_work (c uuid, lane text) FROM PUBLIC;

GRANT ALL ON FUNCTION public.claim_channel_work (c uuid, lane text) TO monitor_app;
