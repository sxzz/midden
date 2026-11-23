-- Media size is bounded only by the tenant's remaining storage.
DELETE FROM config
WHERE key IN ('max_image_bytes', 'max_video_bytes');

ALTER TABLE config
    DROP CONSTRAINT config_check;

ALTER TABLE config
    ADD CONSTRAINT config_check CHECK (CASE WHEN (key = 'web_app_url'::text) THEN
        ((value = ''::text) OR (value ~ '^https://[^/?#]+/app/$'::text))
    WHEN (key = 'additional_adapters'::text) THEN
        (jsonb_typeof((value)::jsonb) = 'array'::text)
    WHEN (key = 'telegram_bot_token'::text) THEN
        ((length(value) <= 4096) AND ((value = ''::text) OR (value ~ '^[0-9]+:[A-Za-z0-9_-]+$'::text)))
    WHEN (key = 'telegram_channel_id'::text) THEN
        ((value = ''::text) OR (value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text))
    ELSE
        ((value ~ '^[0-9]{1,16}$'::text) AND (((value)::numeric >= (1)::numeric) AND ((value)::numeric <= ( CASE WHEN (key = ANY (ARRAY['collection_retention_days'::text, 'object_gc_grace_hours'::text])) THEN
            (36500)::bigint
        WHEN (key = 'tenant_quota_bytes'::text) THEN
            '1125899906842624'::bigint
        WHEN (key = ANY (ARRAY['capture_rate'::text, 'tenant_concurrency'::text, 'connection_concurrency'::text, 'capture_workers'::text, 'download_workers'::text, 'control_workers'::text, 'delivery_workers'::text, 'max_media'::text])) THEN
            (1000)::bigint
        ELSE
            (0)::bigint
        END)::numeric)))
    END);
