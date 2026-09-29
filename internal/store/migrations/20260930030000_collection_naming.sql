-- Rename stored content without changing IDs, ownership, foreign keys or RLS.
-- Historical migration files remain immutable.
ALTER TABLE archives RENAME TO collections;
ALTER TABLE tenant_archives RENAME TO tenant_collections;
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT table_name,column_name FROM information_schema.columns
          WHERE table_schema='public' AND column_name LIKE '%archive%'
 LOOP
  EXECUTE format('ALTER TABLE public.%I RENAME COLUMN %I TO %I',r.table_name,r.column_name,replace(r.column_name,'archive','collection'));
 END LOOP;
 FOR r IN SELECT c.oid::regclass AS tbl,k.conname FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND k.conname LIKE '%archive%'
 LOOP
  EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',r.tbl,r.conname,replace(r.conname,'archive','collection'));
 END LOOP;
 FOR r IN SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE '%archive%'
 LOOP
  EXECUTE format('ALTER INDEX public.%I RENAME TO %I',r.indexname,CASE WHEN r.indexname='archive_recent' THEN 'collections_recent' ELSE replace(r.indexname,'archive','collection') END);
 END LOOP;
END $$;
ALTER FUNCTION collect_unreferenced_archives(interval) RENAME TO collect_unreferenced_collections;
-- SQL/PLpgSQL bodies are stored as text; PostgreSQL does not rewrite them on rename.
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.prokind='f' AND p.prosrc LIKE '%archive%'
 LOOP
  EXECUTE replace(r.def,'archive','collection');
 END LOOP;
END $$;
-- Preserve the configured retention period under the new key.
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT conname,pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid='public.config'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%archive%'
 LOOP
  EXECUTE format('ALTER TABLE public.config DROP CONSTRAINT %I',r.conname);
  UPDATE config SET key='collection_retention_days' WHERE key='archive_retention_days';
  EXECUTE format('ALTER TABLE public.config ADD CONSTRAINT %I %s',r.conname,replace(r.def,'archive','collection'));
 END LOOP;
END $$;
UPDATE config SET key='collection_retention_days' WHERE key='archive_retention_days';
-- Cached channel results may survive a process restart across this upgrade.
UPDATE channel_work SET result=replace(replace(result::text,'"archive":','"collection":'),'"archive_id":','"collection_id":')::jsonb WHERE result IS NOT NULL;
