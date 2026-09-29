ALTER TABLE config
    ALTER COLUMN value_type SET EXPRESSION AS (
    CASE WHEN key IN ('telegram_bot_token', 'telegram_channel_id', 'additional_adapters', 'web_app_url') THEN
        'text'
    ELSE
        'integer'
    END);

ALTER TABLE config
    DROP CONSTRAINT config_check;

ALTER TABLE config
    ADD CHECK (CASE WHEN key = 'web_app_url' THEN
        value = ''
            OR value ~ '^https://[^/?#]+/app/$'
    WHEN key = 'additional_adapters' THEN
        jsonb_typeof(value::jsonb) = 'array'
    WHEN key = 'telegram_bot_token' THEN
        length(value) <= 4096
        AND (value = ''
        OR value ~ '^[0-9]+:[A-Za-z0-9_-]+$')
    WHEN key = 'telegram_channel_id' THEN
        value = ''
        OR value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ELSE
        value ~ '^[0-9]{1,16}$'
        AND value::numeric BETWEEN 1 AND CASE WHEN key IN ('archive_retention_days', 'object_gc_grace_hours') THEN
            36500
        WHEN key IN ('tenant_quota_bytes', 'max_image_bytes', 'max_video_bytes') THEN
            1125899906842624
        WHEN key IN ('capture_rate', 'tenant_concurrency', 'connection_concurrency', 'capture_workers', 'download_workers', 'control_workers', 'delivery_workers', 'max_media') THEN
            1000
        ELSE
            0
        END
    END);

INSERT INTO config (key, value)
    VALUES ('web_app_url', '')
ON CONFLICT
    DO NOTHING;

CREATE TABLE web_sessions (
    digest text PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL DEFAULT now() + interval '12 hours'
);

CREATE INDEX web_sessions_expiry ON web_sessions (expires_at);

ALTER TABLE web_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE web_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON web_sessions
    USING (tenant_id = nullif (current_setting('app.tenant_id', TRUE), '')::uuid);

GRANT SELECT, INSERT, DELETE ON web_sessions TO monitor_app;

CREATE FUNCTION authenticate_web_session (d text)
    RETURNS uuid
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    SELECT
        tenant_id
    FROM
        public.web_sessions
    WHERE
        digest = d
        AND expires_at > now()
$$;

CREATE FUNCTION cleanup_web_sessions ()
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    DELETE FROM public.web_sessions
    WHERE expires_at <= now()
$$;

REVOKE ALL ON FUNCTION authenticate_web_session (text), cleanup_web_sessions () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION authenticate_web_session (text), cleanup_web_sessions () TO monitor_app;
