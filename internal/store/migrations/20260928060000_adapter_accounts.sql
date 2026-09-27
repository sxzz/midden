ALTER TABLE tenant_preferences ADD COLUMN adapter_id text;
UPDATE tenant_preferences t SET adapter_id=c.adapter_id FROM connections c WHERE c.id=t.default_connection_id;
DELETE FROM tenant_preferences WHERE adapter_id IS NULL;
ALTER TABLE tenant_preferences ALTER COLUMN adapter_id SET NOT NULL;
ALTER TABLE tenant_preferences DROP CONSTRAINT tenant_preferences_pkey;
ALTER TABLE tenant_preferences ADD PRIMARY KEY (tenant_id,adapter_id);
ALTER TABLE captures ADD COLUMN adapter_id text NOT NULL DEFAULT '';
UPDATE captures c SET adapter_id=a.platform FROM archives a WHERE a.id=c.archive_id;
UPDATE captures c SET adapter_id=n.adapter_id FROM connections n WHERE n.id=c.connection_id;
ALTER TABLE tenant_archives ADD COLUMN adapter_id text NOT NULL DEFAULT '';
UPDATE tenant_archives t SET adapter_id=a.platform FROM archives a WHERE a.id=t.archive_id;
UPDATE tenant_archives t SET adapter_id=c.adapter_id FROM connections c WHERE c.id=t.connection_id;

ALTER TABLE config ALTER COLUMN value_type SET EXPRESSION AS (CASE WHEN key IN ('telegram_bot_token','telegram_channel_id','additional_adapters') THEN 'text' ELSE 'integer' END);
ALTER TABLE config ALTER COLUMN sensitive SET EXPRESSION AS (key IN ('telegram_bot_token','additional_adapters'));
ALTER TABLE config DROP CONSTRAINT config_check;
ALTER TABLE config ADD CHECK (CASE WHEN key = 'additional_adapters' THEN jsonb_typeof(value::jsonb)='array' WHEN key = 'telegram_bot_token' THEN
        length(value) <= 4096 AND (value = '' OR value ~ '^[0-9]+:[A-Za-z0-9_-]+$')
    WHEN key = 'telegram_channel_id' THEN
        value = '' OR value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ELSE
        value ~ '^[0-9]{1,16}$' AND value::numeric BETWEEN 1 AND CASE WHEN key IN ('archive_retention_days', 'object_gc_grace_hours') THEN
            36500
        WHEN key IN ('tenant_quota_bytes', 'max_image_bytes', 'max_video_bytes') THEN
            1125899906842624
        WHEN key IN ('capture_rate', 'tenant_concurrency', 'connection_concurrency', 'capture_workers', 'download_workers', 'control_workers', 'delivery_workers', 'max_media') THEN
            1000
        ELSE
            0
        END
    END);
INSERT INTO config(key,value) VALUES('additional_adapters','[]');
ALTER TABLE connections ADD UNIQUE (tenant_id,adapter_id,id);
ALTER TABLE tenant_preferences ADD FOREIGN KEY (tenant_id,adapter_id,default_connection_id) REFERENCES connections(tenant_id,adapter_id,id);
DROP INDEX one_active_capture;
CREATE UNIQUE INDEX one_active_capture ON captures (archive_id,adapter_id,provider_id,(coalesce(connection_id,'00000000-0000-0000-0000-000000000000'::uuid))) WHERE state IN ('queued','downloading');
ALTER TABLE captures ALTER COLUMN adapter_id DROP DEFAULT;
ALTER TABLE tenant_archives ALTER COLUMN adapter_id DROP DEFAULT;
