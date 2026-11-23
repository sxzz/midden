-- Lookups that scanned whole tables: progress polls and delivery by capture,
-- continuation and channel-message checks, and the per-minute collectors.
CREATE INDEX submission_capture ON public.submissions USING btree (capture_id);

CREATE INDEX submission_next ON public.submissions USING btree (tenant_id, next_submission)
WHERE (next_submission IS NOT NULL);

CREATE INDEX submission_message ON public.submissions USING btree (channel_id, chat_id, message_id)
WHERE (channel_id IS NOT NULL);

CREATE INDEX collections_unreferenced ON public.collections USING btree (unreferenced_at)
WHERE (unreferenced_at IS NOT NULL);

CREATE INDEX source_responses_unreferenced ON public.source_responses USING btree (unreferenced_at)
WHERE (unreferenced_at IS NOT NULL);

CREATE INDEX assets_object ON public.assets USING btree (object_id)
WHERE (object_id IS NOT NULL);

CREATE INDEX objects_garbage ON public.objects USING btree (created_at)
WHERE (state IN ('garbage', 'deleting'));
