import { Router, type IRouter } from "express";
import { asyncHandler } from "../lib/asyncHandler";

const router: IRouter = Router();

const CURRENCIES = ["RUB", "EUR", "KZT", "UZS", "UAH", "GBP", "CNY", "JPY", "TRY", "AED"] as const;
type Cur = typeof CURRENCIES[number];

const CACHE_TTL_MS = 10 * 60 * 1000;
// Partial/failed upstream fetch: cache briefly so a transient Yahoo outage is not pinned for 10 minutes.
const PARTIAL_CACHE_TTL_MS = 60 * 1000;
let cache: { ts: number; rates: Record<string, number>; prev: Record<string, number>; complete: boolean } | null = null;

/** Latest rate plus previous session close (for the daily change shown in the converter). */
async function fetchPair(pair: string): Promise<{ price: number; prev: number | null } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pair}=X?range=1d&interval=1d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    const j = await r.json() as any;
    const meta = j?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? meta?.previousClose;
    if (!(typeof price === "number" && price > 0)) return null;
    const prevRaw = meta?.chartPreviousClose ?? meta?.previousClose;
    const prev = typeof prevRaw === "number" && prevRaw > 0 ? prevRaw : null;
    return { price, prev };
  } catch {
    return null;
  }
}

router.get("/fx/rates", asyncHandler(async (req, res): Promise<void> => {
  const now = Date.now();
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
  if (cache && now - cache.ts < (cache.complete ? CACHE_TTL_MS : PARTIAL_CACHE_TTL_MS)) {
    res.json({ base: "USD", rates: cache.rates, prev: cache.prev, fetchedAt: cache.ts, cached: true });
    return;
  }
  const results = await Promise.all(
    CURRENCIES.map(async (c) => [c, await fetchPair(`USD${c}`)] as [Cur, { price: number; prev: number | null } | null]),
  );
  const rates: Record<string, number> = { USD: 1 };
  // Additive field: previous close per currency (vs USD); absent when upstream did not report it.
  const prev: Record<string, number> = { USD: 1 };
  for (const [c, v] of results) {
    if (v === null) continue;
    rates[c] = v.price;
    if (v.prev !== null) prev[c] = v.prev;
  }
  const complete = Object.keys(rates).length === CURRENCIES.length + 1;
  // Keep the last known good rates for currencies that failed this time.
  if (!complete && cache) {
    for (const c of CURRENCIES) {
      if (rates[c] === undefined && cache.rates[c] !== undefined) rates[c] = cache.rates[c];
      if (prev[c] === undefined && cache.prev[c] !== undefined) prev[c] = cache.prev[c];
    }
  }
  cache = { ts: now, rates, prev, complete };
  req.log?.info({ count: Object.keys(rates).length }, "fx rates fetched");
  res.json({ base: "USD", rates, prev, fetchedAt: now, cached: false });
}));

export default router;
