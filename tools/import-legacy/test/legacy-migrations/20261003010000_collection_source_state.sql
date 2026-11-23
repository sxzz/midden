-- What the last refresh learned about the source itself: the post was deleted or
-- its account suspended. Cleared by the next successful capture, since a
-- suspension can be lifted.
ALTER TABLE collections
    ADD COLUMN source_state text CHECK (source_state IN ('deleted', 'suspended')),
    ADD COLUMN source_state_at timestamptz,
    ADD CONSTRAINT collection_source_state_at CHECK ((source_state IS NULL) = (source_state_at IS NULL));
