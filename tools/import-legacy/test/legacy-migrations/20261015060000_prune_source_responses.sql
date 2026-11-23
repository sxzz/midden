-- Raw responses of a capture that made no version and is no longer its
-- collection's newest complete look only repeat what the version's own
-- capture and the newest one keep. They go after a grace period, so a
-- collection keeps about one set of raw responses per version, plus the
-- newest. Returns how many captures it cleared.
CREATE FUNCTION public.prune_source_responses (age interval, n integer)
    RETURNS integer
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    WITH superseded AS (
        SELECT
            c.id
        FROM
            public.captures c
        WHERE
            c.id IN (
                SELECT
                    capture_id
                FROM
                    public.source_responses)
                AND c.state IN ('complete', 'partial')
                AND c.finished_at < now() - age
                AND NOT EXISTS (
                    SELECT
                    FROM
                        public.revisions r
                    WHERE
                        r.capture_id = c.id)
                    AND EXISTS (
                        SELECT
                        FROM
                            public.captures newer
                        WHERE
                            newer.collection_id = c.collection_id
                            AND newer.state IN ('complete', 'partial')
                            AND (newer.finished_at,
                                newer.id) > (c.finished_at,
                                c.id))
                    LIMIT n
),
cleared AS (
    DELETE FROM public.source_responses sr USING superseded
WHERE sr.capture_id = superseded.id
RETURNING
    sr.capture_id
)
SELECT
    count(DISTINCT capture_id)::integer
FROM
    cleared
$$;

REVOKE ALL ON FUNCTION public.prune_source_responses (age interval, n integer) FROM PUBLIC;

GRANT ALL ON FUNCTION public.prune_source_responses (age interval, n integer) TO monitor_app;
