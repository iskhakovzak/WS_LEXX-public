-- Former boot one-off (lib/migrate.ts): rename the untouched system tier «Джуниор» → «Джун» (lib/scalingEngine.ts).
-- A curator's own name (updated_by <> 'system') stays. scaling_tiers may not exist yet on some databases.
DO $$
DECLARE n integer := 0;
BEGIN
  IF to_regclass('public.scaling_tiers') IS NOT NULL THEN
    UPDATE scaling_tiers SET name = 'Джун' WHERE key = 'junior' AND name = 'Джуниор' AND updated_by = 'system';
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  RAISE NOTICE 'scaling_tiers junior renamed: % rows', n;
END $$;
