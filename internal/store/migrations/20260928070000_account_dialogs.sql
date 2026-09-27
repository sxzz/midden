CREATE TABLE account_dialogs (
 tenant_id uuid NOT NULL REFERENCES tenants,
 identity_id uuid NOT NULL,
 chat_id text NOT NULL,
 flow_id uuid NOT NULL,
 adapter_id text NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,identity_id,chat_id),
 FOREIGN KEY(tenant_id,identity_id) REFERENCES identities(tenant_id,id)
);
ALTER TABLE account_dialogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_dialogs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_dialogs USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
