-- Owner-approved (2026-10-17): drop the legacy playbook_trade_ideas table — ONLY when it is empty. Its boot-time merge
-- into trade_ideas failed on every start (column "market_cap" does not exist) and is removed from lib/migrate.ts.
-- A non-empty table is kept and reported, so no row is ever lost.
DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.playbook_trade_ideas') IS NULL THEN
    RAISE NOTICE 'playbook_trade_ideas: not present, nothing to do';
    RETURN;
  END IF;
  EXECUTE 'SELECT count(*) FROM playbook_trade_ideas' INTO n;
  IF n = 0 THEN
    DROP TABLE playbook_trade_ideas;
    RAISE NOTICE 'playbook_trade_ideas: empty, dropped';
  ELSE
    RAISE NOTICE 'playbook_trade_ideas: % rows — KEPT (needs a manual merge decision)', n;
  END IF;
END $$;
