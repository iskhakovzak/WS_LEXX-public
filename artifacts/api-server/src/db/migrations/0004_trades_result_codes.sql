-- Owner-approved data fix (2026-10-17): trades.result holds canonical codes only — win / loss / be / open.
-- Before: 'breakeven' (PropReports parsers) and possibly Russian synonyms (прибыль/профит, убыток/лосс, безубыток/бу)
-- were normalised on every read (lib/tradeMath.ts). From now on they are normalised on write (PropReports sync, API).
-- Values that map to no code are left untouched and counted.
DO $$
DECLARE
  r record;
  n integer;
  unknown integer;
BEGIN
  FOR r IN
    SELECT result AS v, count(*) AS c FROM trades
     WHERE result IS NOT NULL AND result NOT IN ('win', 'loss', 'be', 'open')
     GROUP BY result ORDER BY result
  LOOP
    RAISE NOTICE 'trades.result %: % rows', quote_literal(r.v), r.c;
  END LOOP;

  WITH m AS (
    SELECT id, CASE
      WHEN TRANSLATE(LOWER(TRIM(result)), 'ПРИБЫЛЬОФТУКСЕЗ', 'прибыльофтуксез') IN ('win', 'прибыль', 'профит') THEN 'win'
      WHEN TRANSLATE(LOWER(TRIM(result)), 'ПРИБЫЛЬОФТУКСЕЗ', 'прибыльофтуксез') IN ('loss', 'убыток', 'лосс') THEN 'loss'
      WHEN TRANSLATE(LOWER(TRIM(result)), 'ПРИБЫЛЬОФТУКСЕЗ', 'прибыльофтуксез') IN ('be', 'breakeven', 'безубыток', 'бу') THEN 'be'
      WHEN LOWER(TRIM(result)) = 'open' THEN 'open'
    END AS code
    FROM trades
    WHERE result IS NOT NULL AND result NOT IN ('win', 'loss', 'be', 'open')
  )
  UPDATE trades t SET result = m.code FROM m WHERE t.id = m.id AND m.code IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;

  SELECT count(*) INTO unknown FROM trades WHERE result IS NOT NULL AND result NOT IN ('win', 'loss', 'be', 'open');
  RAISE NOTICE 'trades.result normalised: % rows updated, % rows with an unknown value left as is', n, unknown;
END $$;
