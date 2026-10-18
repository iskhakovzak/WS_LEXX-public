-- Former boot one-off (lib/migrate.ts): restore playbook rows accidentally soft-deleted on 2026-04-22 17:35–17:40 UTC.
-- It re-ran on every start and would undelete anything deleted in that window again; now it runs once.
DO $$
DECLARE n integer;
BEGIN
  UPDATE playbook SET deleted_at = NULL
   WHERE deleted_at >= '2026-04-22T17:35:00Z' AND deleted_at <= '2026-04-22T17:40:00Z';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'playbook rows restored (2026-04-22 window): % rows', n;
END $$;
