import { pool } from "@workspace/db";
import { logger } from "./logger";
import { getSectorStrength } from "./marketDataService";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";
/** Outbound request budget (a hung upstream must not hold the caller forever). */
const FETCH_TIMEOUT_MS = 12_000;

export type ContextSnapshot = {
  capturedAt: string;
  tradeDate: string;
  spy: { price: number | null; changePct: number | null; trend5d: number | null } | null;
  qqq: { price: number | null; changePct: number | null; trend5d: number | null } | null;
  vix: { value: number | null; changePct: number | null; bucket: string | null } | null;
  trendDay: { spy: boolean | null; qqq: boolean | null } | null;
  sector: { sector: string | null; symbol: string | null; strengthPct: number | null; trend5d: number | null } | null;
  events: Array<{ date: string; type: string; name: string; importance: string }>;
  isFomcWeek: boolean;
  isHoliday: boolean;
  isEarningsSeason: boolean;
  marketRegime: string | null;
  marketOpenBucket: string | null;
  session: string | null;
};

function marketOpenBucketFromSession(session: string | null | undefined): string | null {
  if (!session) return null;
  const s = String(session).toLowerCase();
  if (s.includes("pre")) return "before_open";
  if (s.includes("after") || s.includes("post")) return "after_close";
  if (s === "regular" || s.includes("market") || s.includes("rth")) return "during_regular";
  return s;
}

const dayCache = new Map<string, { ts: number; data: any }>();
const DAY_TTL = 5 * 60 * 1000;

const ONE_DAY = 86400;

async function fetchDailyClose(symbol: string, date: string) {
  const key = `${symbol}:${date}`;
  const cached = dayCache.get(key);
  if (cached && Date.now() - cached.ts < DAY_TTL) return cached.data;
  try {
    const targetMid = Math.floor(new Date(date + "T16:00:00-04:00").getTime() / 1000);
    const period1 = targetMid - 14 * ONE_DAY;
    const period2 = targetMid + 1 * ONE_DAY;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`;
    const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const r = data?.chart?.result?.[0];
    if (!r) return null;
    const timestamps: number[] = r.timestamp || [];
    const closes: number[] = r.indicators?.quote?.[0]?.close || [];
    let idx = -1;
    let bestDiff = Infinity;
    const MAX_DIFF_SEC = 18 * 3600;
    for (let i = 0; i < timestamps.length; i++) {
      const diff = Math.abs(timestamps[i] - targetMid);
      if (diff < bestDiff && closes[i] != null) { bestDiff = diff; idx = i; }
    }
    if (idx === -1 || bestDiff > MAX_DIFF_SEC) {
      dayCache.set(key, { ts: Date.now(), data: null });
      return null;
    }
    const price = closes[idx];
    const prev = idx > 0 ? closes[idx - 1] : null;
    const changePct = prev && price ? +(((price - prev) / prev) * 100).toFixed(3) : null;
    const five = idx >= 5 ? closes[idx - 5] : null;
    const trend5d = five && price ? +(((price - five) / five) * 100).toFixed(3) : null;
    const result = { price, changePct, trend5d };
    dayCache.set(key, { ts: Date.now(), data: result });
    return result;
  } catch (e: any) {
    logger.warn({ error: e.message, symbol, date }, "fetchDailyClose failed");
    return null;
  }
}

function vixBucket(v: number | null): string | null {
  if (v == null) return null;
  if (v < 13) return "very_low";
  if (v < 17) return "low";
  if (v < 22) return "normal";
  if (v < 28) return "elevated";
  return "high";
}

function trendDay(changePct: number | null): boolean | null {
  if (changePct == null) return null;
  return Math.abs(changePct) >= 0.6;
}

function isEarningsSeason(date: string): boolean {
  const d = new Date(date + "T12:00:00Z");
  const month = d.getUTCMonth() + 1;
  const dayOfMonth = d.getUTCDate();
  const inSeason = (month === 1 && dayOfMonth >= 10) || month === 2 || (month === 4 && dayOfMonth >= 10) || month === 5 || (month === 7 && dayOfMonth >= 10) || month === 8 || (month === 10 && dayOfMonth >= 10) || month === 11;
  return inSeason;
}

export async function captureContext(input: { tradeDate: string; sector?: string | null; ticker?: string | null; session?: string | null }): Promise<ContextSnapshot | null> {
  const { tradeDate, sector, session } = input;
  if (!tradeDate || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate.substring(0, 10))) return null;
  const dateOnly = tradeDate.substring(0, 10);
  try {
    const [spy, qqq, vix] = await Promise.all([
      fetchDailyClose("SPY", dateOnly),
      fetchDailyClose("QQQ", dateOnly),
      fetchDailyClose("^VIX", dateOnly),
    ]);

    let sectorPoint: { sector: string | null; symbol: string | null; strengthPct: number | null; trend5d: number | null } | null = null;
    if (sector) {
      try {
        const sectors = await getSectorStrength({ force: false });
        const match = sectors.find((s) =>
          s.name?.toLowerCase().includes(String(sector).toLowerCase()) ||
          String(sector).toLowerCase().includes(s.name?.toLowerCase() || "__nope__")
        );
        if (match) {
          sectorPoint = {
            sector: match.name,
            symbol: match.symbol,
            strengthPct: match.changePct,
            trend5d: match.trend5d,
          };
        } else {
          sectorPoint = { sector, symbol: null, strengthPct: null, trend5d: null };
        }
      } catch {}
    }

    const eventsRes = await pool.query(
      `SELECT date, type, name, importance FROM holiday_calendar WHERE date = $1`,
      [dateOnly]
    ).catch(() => ({ rows: [] as any[] }));
    const events = eventsRes.rows.map((r: any) => ({ date: r.date, type: r.type, name: r.name, importance: r.importance }));

    const weekStart = new Date(dateOnly + "T00:00:00Z");
    const day = weekStart.getUTCDay();
    const monday = new Date(weekStart);
    monday.setUTCDate(weekStart.getUTCDate() - ((day + 6) % 7));
    const friday = new Date(monday);
    friday.setUTCDate(monday.getUTCDate() + 4);
    const fmt = (d: Date) => d.toISOString().substring(0, 10);
    const weekEvents = await pool.query(
      `SELECT type, name FROM holiday_calendar WHERE date BETWEEN $1 AND $2`,
      [fmt(monday), fmt(friday)]
    ).catch(() => ({ rows: [] as any[] }));
    const isFomcWeek = weekEvents.rows.some((r: any) => /fomc|fed/i.test(r.type) || /fomc|fed/i.test(r.name));

    const isHoliday = events.some((e) => e.type === "holiday" || e.type === "early_close");

    const spyTrendDay = trendDay(spy?.changePct ?? null);
    const qqqTrendDay = trendDay(qqq?.changePct ?? null);

    const vixVal = vix?.price ?? null;
    const bucket = vixBucket(vixVal);

    let regime: string | null = null;
    if (vixVal != null && spy?.changePct != null) {
      if (vixVal >= 25) regime = "high_vol";
      else if (vixVal >= 20 && spy.changePct < -0.5) regime = "risk_off";
      else if (spy.changePct > 0.6 && (qqq?.changePct ?? 0) > 0.5 && vixVal < 18) regime = "trend_up";
      else if (spy.changePct < -0.6 && (qqq?.changePct ?? 0) < -0.5) regime = "trend_down";
      else if (Math.abs(spy.changePct) < 0.3 && vixVal < 17) regime = "low_vol_chop";
      else regime = "neutral";
    }

    return {
      capturedAt: new Date().toISOString(),
      tradeDate: dateOnly,
      spy: spy ? { price: spy.price, changePct: spy.changePct, trend5d: spy.trend5d } : null,
      qqq: qqq ? { price: qqq.price, changePct: qqq.changePct, trend5d: qqq.trend5d } : null,
      vix: vix ? { value: vix.price, changePct: vix.changePct, bucket } : null,
      trendDay: { spy: spyTrendDay, qqq: qqqTrendDay },
      sector: sectorPoint,
      events,
      isFomcWeek,
      isHoliday,
      isEarningsSeason: isEarningsSeason(dateOnly),
      marketRegime: regime,
      marketOpenBucket: marketOpenBucketFromSession(session),
      session: session ?? null,
    };
  } catch (e: any) {
    logger.warn({ error: e.message, tradeDate }, "captureContext failed");
    return null;
  }
}

export async function backfillMissingContext(
  batchSize = 100,
  afterId = 0
): Promise<{ updated: number; skipped: number; scanned: number; nextCursor: number | null }> {
  const { rows } = await pool.query<any>(
    `SELECT id, date, sector, ticker, session FROM trades
     WHERE deleted_at IS NULL AND context_snapshot IS NULL AND id > $1
     ORDER BY id ASC LIMIT $2`,
    [afterId, batchSize]
  );
  let updated = 0;
  let skipped = 0;
  let lastId = afterId;
  for (const r of rows) {
    lastId = r.id;
    try {
      const snap = await captureContext({ tradeDate: r.date, sector: r.sector, ticker: r.ticker, session: r.session });
      if (snap) {
        await pool.query(`UPDATE trades SET context_snapshot = $1::jsonb WHERE id = $2`, [JSON.stringify(snap), r.id]);
        updated++;
      } else {
        skipped++;
        logger.warn({ tradeId: r.id, tradeDate: r.date }, "context backfill: no market data for date, skipped");
      }
    } catch (e: any) {
      skipped++;
      logger.warn({ tradeId: r.id, tradeDate: r.date, error: e.message }, "context backfill: error processing trade, skipped");
    }
  }
  const nextCursor = rows.length === batchSize ? lastId : null;
  logger.info({ updated, skipped, scanned: rows.length, nextCursor }, "context backfill batch complete");
  return { updated, skipped, scanned: rows.length, nextCursor };
}

export async function captureAndAttach(tradeId: number, opts: { tradeDate: string; sector?: string | null; ticker?: string | null; session?: string | null }): Promise<void> {
  const snap = await captureContext(opts);
  if (!snap) return;
  try {
    await pool.query(
      `UPDATE trades SET context_snapshot = $1::jsonb WHERE id = $2`,
      [JSON.stringify(snap), tradeId]
    );
  } catch (e: any) {
    logger.warn({ error: e.message, tradeId }, "captureAndAttach: failed to persist snapshot");
  }
}
