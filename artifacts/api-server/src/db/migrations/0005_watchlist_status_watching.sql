-- Owner-approved data fix (2026-10-17): legacy watchlist rows seeded with status 'Active' (any casing) become the
-- canonical 'watching' (routes/watchlist.ts already treats them so on read and writes 'watching').
DO $$
DECLARE n integer;
BEGIN
  UPDATE watchlist SET status = 'watching' WHERE LOWER(TRIM(status)) = 'active';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'watchlist.status Active -> watching: % rows', n;
END $$;
