-- Owner-approved data fix (2026-10-17): trade_quality rows whose trade no longer exists (hard-deleted) are derived
-- cache rows with nothing to show; delete them (data.md §6: 41 locally). Soft-deleted trades keep theirs.
DO $$
DECLARE n integer := 0;
BEGIN
  IF to_regclass('public.trade_quality') IS NOT NULL THEN
    DELETE FROM trade_quality q WHERE NOT EXISTS (SELECT 1 FROM trades t WHERE t.id = q.trade_id);
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  RAISE NOTICE 'trade_quality orphans deleted: % rows', n;
END $$;
