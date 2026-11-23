-- Observed values (counts) of each entity a capture saw, by entity type and
-- external ID. Versions keep content only, so a change in counts alone no
-- longer makes a new version; reads show the newest readable capture's counts.
ALTER TABLE public.captures
    ADD COLUMN metrics jsonb;

CREATE INDEX captures_latest_metrics ON public.captures (collection_id, finished_at DESC, id DESC)
WHERE
    metrics IS NOT NULL AND state IN ('complete', 'partial');
