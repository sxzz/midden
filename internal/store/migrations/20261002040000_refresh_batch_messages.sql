-- A batch started from the web reports to the requester's private chat in one
-- message, edited as it progresses.
ALTER TABLE refresh_batches
    ADD COLUMN channel_id uuid REFERENCES channels (id),
    ADD COLUMN chat_id text,
    ADD CONSTRAINT refresh_batches_chat CHECK ((channel_id IS NULL) = (chat_id IS NULL));

ALTER TABLE channel_work
    DROP CONSTRAINT channel_work_kind_check,
    ADD CONSTRAINT channel_work_kind_check CHECK (kind IN ('event', 'delivery', 'reply', 'batch'));
