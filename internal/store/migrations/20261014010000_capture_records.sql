-- The capture record list reads one tenant's own requests newest first. The
-- captures a collection starts for its members are submissions too and
-- outnumber those requests by orders of magnitude.
CREATE INDEX submission_records ON public.submissions USING btree (tenant_id, created_at DESC, id DESC)
WHERE (parent_submission IS NULL AND input <> '');
