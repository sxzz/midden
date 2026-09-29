ALTER TABLE submissions ADD COLUMN collection_stopped boolean NOT NULL DEFAULT false;
ALTER TABLE submissions ADD COLUMN parent_submission uuid;
ALTER TABLE submissions ADD CONSTRAINT submission_parent_owner FOREIGN KEY (tenant_id, parent_submission) REFERENCES submissions (tenant_id, id) ON DELETE SET NULL (parent_submission);
CREATE INDEX submission_parent ON submissions (parent_submission) WHERE parent_submission IS NOT NULL;
