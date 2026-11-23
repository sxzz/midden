-- What the adapter already observed of a related target, kept until the
-- capture it created has fetched, so a listed member needs no request of its
-- own however long it waits in the queue.
ALTER TABLE public.captures
    ADD COLUMN prefetch bytea;
