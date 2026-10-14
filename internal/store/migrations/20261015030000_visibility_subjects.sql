-- A private capture or version that is private only because one account
-- limits who may read it (an X post by a protected account, say). Once a
-- capture observes that account public, its versions become public; versions
-- private for any other reason carry no subject and never open this way.
ALTER TABLE public.captures
    ADD COLUMN subject_platform text,
    ADD COLUMN subject_kind text,
    ADD COLUMN subject_scope text,
    ADD COLUMN subject_external_id text;

ALTER TABLE public.revisions
    ADD COLUMN subject_platform text,
    ADD COLUMN subject_kind text,
    ADD COLUMN subject_scope text,
    ADD COLUMN subject_external_id text;

CREATE INDEX revisions_private_subject ON public.revisions (subject_platform, subject_kind, subject_scope, subject_external_id)
WHERE
    visibility = 'private' AND subject_external_id IS NOT NULL;

-- Any tenant's capture may observe an account public; every version kept
-- private only for that account opens, whoever saved it.
CREATE FUNCTION public.publish_subject (p text, k text, s text, x text)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    UPDATE
        public.revisions
    SET
        visibility = 'public'
    WHERE
        visibility = 'private'
        AND (subject_platform,
            subject_kind,
            subject_scope,
            subject_external_id) = (p,
            k,
            s,
            x)
$$;

REVOKE ALL ON FUNCTION public.publish_subject (p text, k text, s text, x text) FROM PUBLIC;

GRANT ALL ON FUNCTION public.publish_subject (p text, k text, s text, x text) TO monitor_app;
