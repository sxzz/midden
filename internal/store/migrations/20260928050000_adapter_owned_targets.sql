-- Platform identities and provider choices must be supplied by adapter discovery.
ALTER TABLE archives ALTER COLUMN platform DROP DEFAULT;
ALTER TABLE archives ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE tenant_archives ALTER COLUMN provider_id DROP DEFAULT;
