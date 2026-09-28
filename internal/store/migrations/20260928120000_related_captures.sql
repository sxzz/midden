ALTER TABLE captures ADD COLUMN automatic boolean NOT NULL DEFAULT false;
ALTER TABLE captures ADD COLUMN related_targets jsonb NOT NULL DEFAULT '[]';
-- Keep each submitter's execution choice; a shared capture may belong to another tenant.
ALTER TABLE submissions ADD COLUMN related_provider text NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN related_connection uuid;
ALTER TABLE submissions ADD COLUMN related_adapter text NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN related_state text NOT NULL DEFAULT 'none';
ALTER TABLE submissions ADD COLUMN related_error text NOT NULL DEFAULT '';
ALTER TABLE submissions ADD CONSTRAINT related_connection_owner FOREIGN KEY(tenant_id,related_connection) REFERENCES connections(tenant_id,id);

ALTER TABLE submissions ADD COLUMN related_source_archive uuid;
