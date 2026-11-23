ALTER TABLE public.identities
    ADD COLUMN first_name text NOT NULL DEFAULT '',
    ADD COLUMN last_name text NOT NULL DEFAULT '',
    ADD COLUMN username text NOT NULL DEFAULT '';
