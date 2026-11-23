-- Tenant library views merge source scopes by the adapter's stable object identity.
CREATE INDEX collections_logical_identity ON collections (platform, kind, object_scope, external_id, observed_at DESC, id DESC);
