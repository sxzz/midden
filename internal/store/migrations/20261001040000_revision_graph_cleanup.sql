-- Both revision foreign keys must cascade: the scope constraint must not
-- prevent the revision's graph from being removed during collection cleanup.
ALTER TABLE public.revision_entities
    DROP CONSTRAINT revision_entities_data_scope_revision_id_fkey,
    ADD CONSTRAINT revision_entities_data_scope_revision_id_fkey FOREIGN KEY (data_scope, revision_id) REFERENCES public.revisions (data_scope, id) ON DELETE CASCADE;
