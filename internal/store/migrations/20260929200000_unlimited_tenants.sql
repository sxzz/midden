CREATE TABLE tenant_entitlements (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    unlimited boolean NOT NULL DEFAULT false
);
ALTER TABLE tenant_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_entitlements
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON tenant_entitlements TO monitor_app;

CREATE FUNCTION tenant_unlimited() RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT unlimited FROM tenant_entitlements
      WHERE tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid), false)
$$;
REVOKE ALL ON FUNCTION tenant_unlimited() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_unlimited() TO monitor_app;
