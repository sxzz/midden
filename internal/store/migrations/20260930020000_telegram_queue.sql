-- Upgrade with the old combined core stopped.
CREATE TABLE channel_work (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 channel_id uuid NOT NULL REFERENCES channels(id),
 kind text NOT NULL CHECK (kind IN ('event','delivery','reply')),
 resource text NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}',
 result jsonb,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','failed')),
 lease uuid,
 lease_until timestamptz,
 available_at timestamptz NOT NULL DEFAULT now(),
 progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
 message_id bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(channel_id,kind,resource)
);
CREATE INDEX channel_work_pending ON channel_work(channel_id,available_at,created_at) WHERE state='pending';
ALTER TABLE channel_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_work FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_work USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON channel_work TO monitor_app;
CREATE FUNCTION claim_channel_work(c uuid) RETURNS SETOF channel_work
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 UPDATE public.channel_work SET lease=gen_random_uuid(),lease_until=now()+interval '90 seconds'
 WHERE id=(SELECT id FROM public.channel_work WHERE channel_id=c AND state='pending'
 AND available_at<=now() AND (lease_until IS NULL OR lease_until<now())
 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *
$$;
CREATE FUNCTION channel_work_tenant(c uuid,w uuid,l uuid) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT tenant_id FROM public.channel_work WHERE channel_id=c AND id=w AND lease=l AND (lease_until>now() OR state IN ('done','failed'))
$$;
REVOKE ALL ON FUNCTION claim_channel_work(uuid),channel_work_tenant(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_channel_work(uuid),channel_work_tenant(uuid,uuid,uuid) TO monitor_app;
-- Preserve pending sends and partial media progress; channel renders new results.
INSERT INTO channel_work(tenant_id,channel_id,kind,resource,progress,message_id)
 SELECT tenant_id,channel_id,'delivery',id::text,progress,message_id FROM submissions
 WHERE channel_id IS NOT NULL AND state NOT IN ('sent','failed') ON CONFLICT DO NOTHING;
INSERT INTO channel_work(tenant_id,channel_id,kind,resource,progress,message_id)
 SELECT r.tenant_id,i.channel_id,'reply',r.id::text,r.progress,r.message_id FROM replies r JOIN inbox i ON i.id=r.inbox_id
 WHERE r.state='pending' ON CONFLICT DO NOTHING;
-- Retain old input envelopes for channel-side parsing after upgrade.
INSERT INTO channel_work(id,tenant_id,channel_id,kind,resource,payload,created_at)
 SELECT id,tenant_id,channel_id,'event',update_id::text,jsonb_build_object('legacy',payload),created_at FROM inbox WHERE state='pending' ON CONFLICT DO NOTHING;
DO $$ BEGIN
IF to_regclass('public.river_job') IS NOT NULL THEN
UPDATE river_job SET state='cancelled',finalized_at=now(),metadata=metadata||'{"reconciled":true}'::jsonb
 WHERE kind='monitor_task' AND args->>'type' IN ('inbox','reply','deliver','status') AND state IN ('available','scheduled','retryable','running');

END IF;
END $$;
