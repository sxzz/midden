-- Keep the selected connection when consolidating existing active duplicates.
CREATE TEMP TABLE duplicate_connections ON COMMIT DROP AS
SELECT id, first_value(id) OVER (
 PARTITION BY tenant_id,adapter_id,provider_id,account_id
 ORDER BY EXISTS(SELECT FROM tenant_preferences p WHERE p.tenant_id=c.tenant_id AND p.default_connection_id=c.id) DESC, revision DESC,id
) AS keep_id
FROM connections c WHERE state<>'revoked' AND account_id IS NOT NULL AND account_id<>'';
UPDATE tenant_preferences p SET default_connection_id=d.keep_id FROM duplicate_connections d WHERE p.default_connection_id=d.id AND d.id<>d.keep_id;
UPDATE connections c SET state='revoked',credential_ref=NULL,revision=revision+1 FROM duplicate_connections d WHERE c.id=d.id AND d.id<>d.keep_id;
DELETE FROM account_credentials c WHERE NOT EXISTS(SELECT FROM connections n WHERE n.credential_ref=c.id);
CREATE UNIQUE INDEX unique_active_account ON connections(tenant_id,adapter_id,provider_id,account_id) WHERE state<>'revoked' AND account_id IS NOT NULL AND account_id<>'';
CREATE TABLE connection_imports (
 tenant_id uuid NOT NULL REFERENCES tenants,
 request_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,request_id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id)
);
ALTER TABLE connection_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connection_imports USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
