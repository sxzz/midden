-- Every capture observes its target again: a collection's members come with
-- its listing and counts no longer make versions, so the choice between a full
-- and an appending update is gone.
ALTER TABLE public.submissions
    DROP COLUMN update_mode;

ALTER TABLE public.refresh_batches
    DROP COLUMN update_mode;
