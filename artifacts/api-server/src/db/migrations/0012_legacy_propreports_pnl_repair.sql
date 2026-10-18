-- Former boot one-off (lib/migrate.ts): the legacy admin XLS import stored pnl = NET and kept gross / fees / qty only
-- in context_snapshot. Contract: pnl = gross, fees = total fees, qty filled, source = 'propreports'. Each repaired row
-- gets the marker legacyPnlRepaired=true, so this is a no-op where it already ran.
DO $$
DECLARE n integer;
BEGIN
  UPDATE trades SET
    pnl = COALESCE((context_snapshot ->> 'gross')::numeric, pnl),
    fees = COALESCE((context_snapshot ->> 'totalFees')::numeric, fees),
    qty = COALESCE(qty, (context_snapshot ->> 'qty')::numeric),
    source = COALESCE(source, 'propreports'),
    context_snapshot = context_snapshot || '{"legacyPnlRepaired": true}'::jsonb
  WHERE context_snapshot ->> 'source' = 'propreports'
    AND external_id IS NULL
    AND COALESCE(context_snapshot ->> 'legacyPnlRepaired', '') <> 'true'
    AND (context_snapshot ->> 'gross') ~ '^-?[0-9]+(\.[0-9]+)?$'
    AND COALESCE(context_snapshot ->> 'totalFees', '0') ~ '^-?[0-9]+(\.[0-9]+)?$'
    AND COALESCE(context_snapshot ->> 'qty', '0') ~ '^-?[0-9]+(\.[0-9]+)?$';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'legacy PropReports pnl repaired: % rows', n;
END $$;
