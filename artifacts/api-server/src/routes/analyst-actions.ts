import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { safeHttpUrl } from "../lib/safe-url";
import {
  scanWatchlistAnalystActions,
  scanNewsForAnalystActions,
  scanSeekingAlphaForAnalystActions,
  scanNasdaqAnalystActions,
  scanGeneralFinanceFeedsForAnalystActions,
  getDynamicAnalystTickers,
  ANALYST_WATCHLIST,
} from "../lib/marketDataService";
import { fetchDailyRange } from "../lib/candles/market";
import { nyDate, addDays } from "../lib/tradingDate";
import { scopeTrader, GUEST_SCOPE } from "../lib/auth";
import { closedSql, netPnlSql, resultSql } from "../lib/tradeMath";
import { logger } from "../lib/logger";
import {
  aggregate, barsFromCandles, classifyAction, reactionDay, reactionOn,
  type Bar, type EventKind, type Reaction, type ReactionAgg,
} from "../lib/analystReaction";
import { AppError, badRequest, unauthorized } from "../lib/http";

const router: IRouter = Router();

function parseMarketCap(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = String(raw).trim().match(/^([\d.,]+)\s*([TBMK])?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!isFinite(n)) return null;
  const suffix = (m[2] || "").toUpperCase();
  switch (suffix) {
    case "T": return n * 1e12;
    case "B": return n * 1e9;
    case "M": return n * 1e6;
    case "K": return n * 1e3;
    default:  return n;
  }
}

// Map raw Yahoo action codes to UI-friendly category names.
function actionLabel(action: string): "upgrade" | "downgrade" | "initiated" | "maintain" | "reiterated" | "other" {
  const a = (action || "").toLowerCase();
  if (a === "up") return "upgrade";
  if (a === "down") return "downgrade";
  if (a === "init") return "initiated";
  if (a === "main") return "maintain";
  if (a === "reit") return "reiterated";
  return "other";
}

type ActionFilter = "all" | "upgrade" | "downgrade" | "initiated" | "maintain" | "reiterated" | "moves";

function buildActionClause(filter: ActionFilter, paramOffset: number): { clause: string; params: string[] } {
  // 'moves' = upgrade + downgrade only (default UI mode)
  if (filter === "all") return { clause: "TRUE", params: [] };
  if (filter === "moves") return { clause: `a.action IN ('up','down')`, params: [] };
  const reverse: Record<string, string> = {
    upgrade: "up", downgrade: "down", initiated: "init", maintain: "main", reiterated: "reit",
  };
  const code = reverse[filter];
  if (!code) return { clause: "TRUE", params: [] };
  return { clause: `a.action = $${paramOffset}`, params: [code] };
}

router.get("/analyst-actions", asyncHandler(async (req, res): Promise<void> => {
  const minMarketCap = Math.max(0, Number(req.query.minMarketCap) || 0);
  // Cap raised from 2000→10000: when grouped by ticker, a low cap silently
  // drops actions on less-active tickers because LIMIT is applied BEFORE
  // grouping in SQL. With ~50k rows in the cache and "all" filter, 2000 was
  // truncating the visible history per-ticker.
  const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 500));
  // Default changed from "moves" → "all" to match the UI default. Yahoo's
  // upgradeDowngradeHistory module labels most analyst events as main/reit/init
  // (price-target updates, stance reiterations) and only marks up/down when the
  // rating tier actually changes. Defaulting to "moves" was hiding ~95% of
  // analyst activity from any caller that omitted the action param.
  const action = String(req.query.action || "all").toLowerCase() as ActionFilter;
  const groupBy = String(req.query.groupBy || "").toLowerCase();
  const tickerParam = String(req.query.ticker || "").toUpperCase().trim();
  const firmParam = String(req.query.firm || "").trim();

  let before: Date | null = null;
  let after: Date | null = null;
  if (req.query.before) {
    const d = new Date(String(req.query.before));
    if (!isNaN(d.getTime())) before = d;
  }
  if (req.query.after) {
    const d = new Date(String(req.query.after));
    if (!isNaN(d.getTime())) after = d;
  }

  const params: any[] = [];
  const conds: string[] = [];

  const actionPart = buildActionClause(action, params.length + 1);
  conds.push(actionPart.clause);
  params.push(...actionPart.params);

  if (before) { params.push(before.toISOString()); conds.push(`a.graded_at <= $${params.length}`); }
  if (after)  { params.push(after.toISOString());  conds.push(`a.graded_at >= $${params.length}`); }
  if (tickerParam) { params.push(tickerParam); conds.push(`a.ticker = $${params.length}`); }
  if (firmParam)   { params.push(`%${firmParam}%`); conds.push(`a.firm ILIKE $${params.length}`); }

  // SQL-side market cap filter: parse "3.50T" / "150B" / "200M" suffix from
  // ticker_data_cache.market_cap and require >= threshold. Pushing this into
  // SQL is critical because LIMIT is applied after — without it, a query like
  // "give me ≥$10B actions, limit 500" could return 0 rows even when matches
  // exist (if first 500 rows are all small-caps).
  // includeUnknownCap=1 keeps tickers whose market cap is missing / unparseable
  // (treated as "unknown" rather than "small"). Local/dev data often has no
  // fundamentals at all, so a strict ≥$NB filter would hide everything.
  const includeUnknownCap = req.query.includeUnknownCap === "1" || req.query.includeUnknownCap === "true";
  if (minMarketCap > 0) {
    params.push(minMarketCap);
    const capExpr = `(
      CASE
        WHEN t.market_cap ~* '^[0-9.,]+\\s*T$' THEN (regexp_replace(t.market_cap, '[^0-9.]', '', 'g'))::numeric * 1e12
        WHEN t.market_cap ~* '^[0-9.,]+\\s*B$' THEN (regexp_replace(t.market_cap, '[^0-9.]', '', 'g'))::numeric * 1e9
        WHEN t.market_cap ~* '^[0-9.,]+\\s*M$' THEN (regexp_replace(t.market_cap, '[^0-9.]', '', 'g'))::numeric * 1e6
        WHEN t.market_cap ~* '^[0-9.,]+\\s*K$' THEN (regexp_replace(t.market_cap, '[^0-9.]', '', 'g'))::numeric * 1e3
        WHEN t.market_cap ~* '^[0-9.,]+$'      THEN (regexp_replace(t.market_cap, '[^0-9.]', '', 'g'))::numeric
        ELSE NULL
      END
    )`;
    // NULL >= x is NULL → COALESCE(..., TRUE) lets unknown caps through.
    conds.push(includeUnknownCap
      ? `COALESCE(${capExpr} >= $${params.length}, TRUE)`
      : `${capExpr} >= $${params.length}`);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT a.id, a.ticker, a.graded_at, a.firm, a.action, a.to_grade, a.from_grade, a.source, a.source_url,
           a.price_target, a.price_target_from,
           t.market_cap, t.sector, t.long_name
    FROM analyst_actions_cache a
    LEFT JOIN ticker_data_cache t ON t.ticker = a.ticker
    WHERE ${conds.join(" AND ")}
    ORDER BY a.graded_at DESC
    LIMIT ${limitParam}
  `;

  // Surface DB failures as 500 so the UI shows an error state instead of a
  // misleading "no data" empty state.
  let rows: any[];
  try {
    ({ rows } = await pool.query<any>(sql, params));
  } catch (e: any) {
    req.log?.warn({ error: e?.message }, "analyst-actions query failed");
    throw new AppError("COMPUTE_FAILED");
  }

  // Market cap filtering already happened in SQL; here we just shape rows.
  const filtered = rows.map((r: any) => {
    const marketCapNum = parseMarketCap(r.market_cap);
    return {
      id: r.id as number,
      ticker: r.ticker as string,
      firm: r.firm as string,
      action: actionLabel(r.action),
      actionRaw: r.action as string,
      toGrade: r.to_grade as string | null,
      fromGrade: r.from_grade as string | null,
      source: r.source as string,
      // Always validate before returning. For legacy rows without a stored
      // URL we synthesize a safe Yahoo analysis link.
      sourceUrl: safeHttpUrl(r.source_url) ||
        (r.source === "yahoo"
          ? `https://finance.yahoo.com/quote/${encodeURIComponent(r.ticker)}/analysis`
          : null),
      gradedAt: r.graded_at ? new Date(r.graded_at).toISOString() : null,
      priceTarget: r.price_target as string | null,
      priceTargetFrom: r.price_target_from as string | null,
      marketCap: r.market_cap as string | null,
      marketCapNum,
      sector: r.sector as string | null,
      longName: r.long_name as string | null,
    };
  });

  // Collect unique firms for filter UI
  const firmsSet = new Set<string>();
  filtered.forEach((it) => { if (it.firm) firmsSet.add(it.firm); });
  // Additive: how many returned rows have a known vs unknown market cap.
  const capKnown = filtered.reduce((n, it) => n + (it.marketCapNum != null ? 1 : 0), 0);
  const capStats = { known: capKnown, unknown: filtered.length - capKnown };

  if (groupBy === "ticker") {
    // Group by ticker; sort tickers by most-recent graded_at desc.
    const groupMap = new Map<string, {
      ticker: string;
      marketCap: string | null;
      marketCapNum: number | null;
      sector: string | null;
      longName: string | null;
      totalActions: number;
      upgradeCount: number;
      downgradeCount: number;
      lastGradedAt: string | null;
      actions: typeof filtered;
    }>();
    for (const it of filtered) {
      let g = groupMap.get(it.ticker);
      if (!g) {
        g = {
          ticker: it.ticker,
          marketCap: it.marketCap,
          marketCapNum: it.marketCapNum,
          sector: it.sector,
          longName: it.longName,
          totalActions: 0,
          upgradeCount: 0,
          downgradeCount: 0,
          lastGradedAt: null,
          actions: [],
        };
        groupMap.set(it.ticker, g);
      }
      g.actions.push(it);
      g.totalActions++;
      if (it.action === "upgrade") g.upgradeCount++;
      if (it.action === "downgrade") g.downgradeCount++;
      if (!g.lastGradedAt || (it.gradedAt && it.gradedAt > g.lastGradedAt)) {
        g.lastGradedAt = it.gradedAt;
      }
    }
    const groups = Array.from(groupMap.values()).sort((a, b) => {
      const ta = a.lastGradedAt ? Date.parse(a.lastGradedAt) : 0;
      const tb = b.lastGradedAt ? Date.parse(b.lastGradedAt) : 0;
      return tb - ta;
    });
    res.json({
      groups,
      totalGroups: groups.length,
      totalActions: filtered.length,
      availableFirms: Array.from(firmsSet).sort(),
      capStats,
      filters: {
        minMarketCap, action, includeUnknownCap,
        before: before?.toISOString() ?? null,
        after: after?.toISOString() ?? null,
        ticker: tickerParam || null,
        firm: firmParam || null,
      },
    });
    return;
  }

  res.json({
    items: filtered,
    count: filtered.length,
    availableFirms: Array.from(firmsSet).sort(),
    capStats,
    filters: {
      minMarketCap, action, includeUnknownCap,
      before: before?.toISOString() ?? null,
      after: after?.toISOString() ?? null,
      ticker: tickerParam || null,
      firm: firmParam || null,
    },
  });
}));

// POST /api/analyst-actions/refresh — trigger combined refresh:
//  1) Yahoo per-ticker scan over a DYNAMIC ticker list (static watchlist +
//     user trades + watchlist table + tickers seen in recent news)
//  2) News-based parser that extracts firm/action from news_cache headlines
//     for tickers Yahoo doesn't cover.
// Body can override the ticker list (still capped at 500).
router.post("/analyst-actions/refresh", asyncHandler(async (req, res): Promise<void> => {
  const body = (req.body || {}) as { tickers?: string[]; concurrency?: number; newsDays?: number };
  const explicitTickers = Array.isArray(body.tickers) && body.tickers.length
    ? body.tickers.slice(0, 500).map((t) => String(t).toUpperCase().trim()).filter(Boolean)
    : null;
  const tickers = explicitTickers ?? await getDynamicAnalystTickers({ newsDays: 14 });
  const concurrency = body.concurrency && Number.isFinite(Number(body.concurrency))
    ? Math.max(1, Math.min(8, Number(body.concurrency)))
    : 5;
  const newsDays = Math.max(1, Math.min(60, Number(body.newsDays) || 14));

  req.log?.info({ tickers: tickers.length, concurrency, newsDays }, "analyst-actions refresh start");
  const yahoo = await scanWatchlistAnalystActions({ concurrency, tickers, fetchFundamentals: false });
  const news = await scanNewsForAnalystActions({ sinceDays: newsDays });
  const seekingalpha = await scanSeekingAlphaForAnalystActions({ concurrency: Math.min(4, concurrency), tickers });
  const nasdaq = await scanNasdaqAnalystActions({ concurrency: 3, tickers });
  const rss = await scanGeneralFinanceFeedsForAnalystActions({ tickers });
  req.log?.info({ yahoo, news, seekingalpha, nasdaq, rss }, "analyst-actions refresh done");
  const totalInserted = yahoo.rowsInserted + news.inserted + seekingalpha.inserted + nasdaq.inserted + rss.inserted;
  const totalDuration = yahoo.durationMs + news.durationMs + seekingalpha.durationMs + nasdaq.durationMs + rss.durationMs;
  res.json({
    ok: true,
    scanned: yahoo.scanned,
    tickersWithData: yahoo.tickersWithData,
    rowsTotal: yahoo.rowsTotal,
    rowsInserted: totalInserted,
    errors: yahoo.errors + seekingalpha.errors + nasdaq.errors + rss.errors,
    durationMs: totalDuration,
    watchlistSize: tickers.length,
    yahoo,
    news,
    seekingalpha,
    nasdaq,
    rss,
  });
}));

// ── GET /api/analyst-actions/firms — firm reliability stats ──────────────────
// Computed from analyst_actions_cache only (no external calls, read-only).
// "Подтверждаемость": for every directional action (upgrade/downgrade or a PT
// raise/cut) we look at OTHER firms' directional actions on the same ticker in
// the next 30 days; the call is "confirmed" when their net direction agrees.
// `baseRate` is the same ratio across all firms, so the UI can show edge vs street.
type FirmStat = {
  firm: string;
  total: number;
  upgrades: number;
  downgrades: number;
  initiations: number;
  tickers: number;
  avgPtChange: number | null;
  premarketShare: number | null;
  evaluated: number;
  confirmed: number;
  confirmRate: number | null;
  ratingEvaluated: number;
  ratingConfirmed: number;
  ratingConfirmRate: number | null;
  lastAt: string | null;
};
const firmStatsCache = new Map<string, { ts: number; body: unknown }>();
const FIRM_STATS_TTL = 10 * 60 * 1000;
const FOLLOW_DAYS = 30;
const etClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function parsePt(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

router.get("/analyst-actions/firms", asyncHandler(async (req, res): Promise<void> => {
  const days = Math.max(7, Math.min(365, Math.round(Number(req.query.days) || 180)));
  const minActions = Math.max(1, Math.min(100, Math.round(Number(req.query.minActions) || 3)));
  const key = `${days}:${minActions}`;
  const hit = firmStatsCache.get(key);
  if (hit && Date.now() - hit.ts < FIRM_STATS_TTL) { res.json(hit.body); return; }

  const since = new Date(Date.now() - days * 86400_000);
  let rows: Array<{ ticker: string; firm: string; action: string; graded_at: Date; price_target: string | null; price_target_from: string | null }>;
  try {
    ({ rows } = await pool.query(
      `SELECT ticker, firm, action, graded_at, price_target, price_target_from
         FROM analyst_actions_cache
        WHERE graded_at >= $1
        ORDER BY ticker, graded_at`,
      [since.toISOString()],
    ));
  } catch (e: any) {
    req.log?.warn({ error: e?.message }, "analyst-actions firms query failed");
    throw new AppError("COMPUTE_FAILED");
  }

  type Ev = { firm: string; t: number; d: number; rating: boolean };
  const byTicker = new Map<string, Ev[]>();
  const acc = new Map<string, {
    total: number; upgrades: number; downgrades: number; initiations: number;
    tickers: Set<string>; ptSum: number; ptN: number; pre: number; timed: number;
    evaluated: number; confirmed: number; rEval: number; rConf: number; last: number;
  }>();
  const evs: Array<Ev & { ticker: string }> = [];

  for (const r of rows) {
    const firm = String(r.firm || "").trim();
    if (!firm) continue;
    const t = new Date(r.graded_at).getTime();
    if (!Number.isFinite(t)) continue;
    const a = String(r.action || "").toLowerCase();
    const pt = parsePt(r.price_target);
    const ptf = parsePt(r.price_target_from);
    const ptChg = pt != null && ptf != null ? ((pt - ptf) / ptf) * 100 : null;
    const d = a === "up" ? 1 : a === "down" ? -1 : ptChg != null && ptChg !== 0 ? Math.sign(ptChg) : 0;

    let f = acc.get(firm);
    if (!f) {
      f = { total: 0, upgrades: 0, downgrades: 0, initiations: 0, tickers: new Set(), ptSum: 0, ptN: 0, pre: 0, timed: 0, evaluated: 0, confirmed: 0, rEval: 0, rConf: 0, last: 0 };
      acc.set(firm, f);
    }
    f.total++;
    if (a === "up") f.upgrades++;
    else if (a === "down") f.downgrades++;
    else if (a === "init") f.initiations++;
    f.tickers.add(r.ticker);
    // Ignore absurd PT jumps (splits / parse noise) in the average.
    if (ptChg != null && Math.abs(ptChg) < 200) { f.ptSum += ptChg; f.ptN++; }
    const parts = etClock.formatToParts(new Date(t));
    const hh = Number(parts.find((p) => p.type === "hour")?.value);
    const mm = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isFinite(hh) && Number.isFinite(mm) && !(hh === 0 && mm === 0)) {
      f.timed++;
      if (hh * 60 + mm < 9 * 60 + 30) f.pre++;
    }
    if (t > f.last) f.last = t;

    if (d !== 0) {
      const ev = { firm, t, d, rating: a === "up" || a === "down", ticker: r.ticker };
      evs.push(ev);
      let list = byTicker.get(r.ticker);
      if (!list) { list = []; byTicker.set(r.ticker, list); }
      list.push(ev);
    }
  }

  // Follow-through: rows are sorted by ticker, graded_at so each list is chronological.
  const horizon = FOLLOW_DAYS * 86400_000;
  let allEval = 0, allConf = 0;
  for (const list of byTicker.values()) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      let n = 0, s = 0;
      for (let j = i + 1; j < list.length && list[j].t - e.t <= horizon; j++) {
        const o = list[j];
        if (o.t <= e.t || o.firm === e.firm) continue;
        n++; s += o.d;
      }
      if (!n) continue;
      const ok = Math.sign(s) === e.d;
      const f = acc.get(e.firm)!;
      f.evaluated++; if (ok) f.confirmed++;
      allEval++; if (ok) allConf++;
      if (e.rating) { f.rEval++; if (ok) f.rConf++; }
    }
  }

  const firms: FirmStat[] = [];
  for (const [firm, f] of acc) {
    if (f.total < minActions) continue;
    firms.push({
      firm,
      total: f.total,
      upgrades: f.upgrades,
      downgrades: f.downgrades,
      initiations: f.initiations,
      tickers: f.tickers.size,
      avgPtChange: f.ptN ? +(f.ptSum / f.ptN).toFixed(2) : null,
      premarketShare: f.timed ? +(f.pre / f.timed).toFixed(3) : null,
      evaluated: f.evaluated,
      confirmed: f.confirmed,
      confirmRate: f.evaluated ? +(f.confirmed / f.evaluated).toFixed(3) : null,
      ratingEvaluated: f.rEval,
      ratingConfirmed: f.rConf,
      ratingConfirmRate: f.rEval ? +(f.rConf / f.rEval).toFixed(3) : null,
      lastAt: f.last ? new Date(f.last).toISOString() : null,
    });
  }
  firms.sort((a, b) => b.total - a.total);

  const body = {
    days,
    followDays: FOLLOW_DAYS,
    minActions,
    baseRate: allEval ? +(allConf / allEval).toFixed(3) : null,
    totalActions: rows.length,
    firms: firms.slice(0, 300),
    generatedAt: new Date().toISOString(),
  };
  firmStatsCache.set(key, { ts: Date.now(), body });
  res.json(body);
}));

router.get("/analyst-actions/watchlist",asyncHandler(async (_req, res): Promise<void> => {
  res.json({ tickers: ANALYST_WATCHLIST, count: ANALYST_WATCHLIST.length });
}));

/* ═══════════════════════════════════════════════════════════════════════════
 * Market reaction to analyst calls (J8, additive).
 *   GET /api/analyst-actions/reaction?ticker=X        one ticker: events + reaction, by kind, by firm, price series
 *   GET /api/analyst-actions/reactions?tickers=A,B    compact per-ticker summaries (cache only, warms the rest in background)
 *   GET /api/analyst-actions/firm-weight?days=730     firm «weight»: how strongly the market reacts to its rating calls
 *   GET /api/analyst-actions/my-days?trader=&days=    trader's results on tickers on rating-change days vs normal days
 * Daily bars come from Yahoo (candles.fetchDailyRange) and are cached in analyst_bars_cache (≈2 years per ticker,
 * refreshed at most every 20 h). Every Yahoo call goes through one serial gate (≥ 0.7 s apart, ≤ 240 per hour), and
 * list endpoints never wait for Yahoo: they answer from the cache and warm missing tickers in the background.
 * Math: lib/analystReaction.ts.
 * ═══════════════════════════════════════════════════════════════════════════ */

const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,12}$/;
const REACTION_LOOKBACK_DAYS = 730;
const BARS_TTL_MS = 20 * 3600_000;
const BARS_RETRY_MS = 60 * 60_000;

let barsEnsured: Promise<void> | null = null;
function ensureBarsTable(): Promise<void> {
  if (!barsEnsured) {
    barsEnsured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS analyst_bars_cache (
           ticker TEXT PRIMARY KEY,
           bars JSONB NOT NULL DEFAULT '[]'::jsonb,
           from_date TEXT,
           to_date TEXT,
           fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      )
      .then(() => undefined)
      .catch((err) => { barsEnsured = null; throw err; });
  }
  return barsEnsured;
}

/* ── Yahoo gate: one call at a time, spaced, with an hourly budget ─────────── */
const YAHOO_GAP_MS = 700;
const YAHOO_HOURLY_BUDGET = 240;
let yahooChain: Promise<unknown> = Promise.resolve();
let yahooLast = 0;
const yahooCalls: number[] = [];
function viaYahooGate<T>(fn: () => Promise<T | null>): Promise<T | null> {
  const run = async (): Promise<T | null> => {
    const now = Date.now();
    while (yahooCalls.length && now - yahooCalls[0] > 3600_000) yahooCalls.shift();
    if (yahooCalls.length >= YAHOO_HOURLY_BUDGET) return null;
    const wait = yahooLast + YAHOO_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    yahooLast = Date.now();
    yahooCalls.push(yahooLast);
    try { return await fn(); } catch { return null; }
  };
  const p = yahooChain.then(run, run);
  yahooChain = p.catch(() => undefined);
  return p;
}

const barsFailedAt = new Map<string, number>();

type CachedBars = { bars: Bar[]; fetchedAt: number };

async function readBars(tickers: string[]): Promise<Map<string, CachedBars>> {
  const out = new Map<string, CachedBars>();
  if (!tickers.length) return out;
  await ensureBarsTable();
  const { rows } = await pool.query<{ ticker: string; bars: Bar[]; fetched_at: Date }>(
    `SELECT ticker, bars, fetched_at FROM analyst_bars_cache WHERE ticker = ANY($1::text[])`,
    [tickers],
  );
  for (const r of rows) out.set(r.ticker, { bars: Array.isArray(r.bars) ? r.bars : [], fetchedAt: new Date(r.fetched_at).getTime() });
  return out;
}

/** Bars for one ticker: cache first; fetch (through the gate) when missing or older than the TTL. */
async function loadBars(ticker: string, cached?: CachedBars | null): Promise<CachedBars | null> {
  const hit = cached === undefined ? (await readBars([ticker])).get(ticker) ?? null : cached;
  if (hit && Date.now() - hit.fetchedAt < BARS_TTL_MS) return hit;
  const failed = barsFailedAt.get(ticker);
  if (failed && Date.now() - failed < BARS_RETRY_MS) return hit;
  const to = nyDate();
  const from = addDays(to, -(REACTION_LOOKBACK_DAYS + 40));
  const candles = await viaYahooGate(() => fetchDailyRange(ticker, from, to));
  if (!candles || !candles.length) {
    barsFailedAt.set(ticker, Date.now());
    return hit;
  }
  const bars = barsFromCandles(candles);
  try {
    await pool.query(
      `INSERT INTO analyst_bars_cache (ticker, bars, from_date, to_date, fetched_at)
       VALUES ($1, $2::jsonb, $3, $4, NOW())
       ON CONFLICT (ticker) DO UPDATE SET bars = EXCLUDED.bars, from_date = EXCLUDED.from_date,
         to_date = EXCLUDED.to_date, fetched_at = NOW()`,
      [ticker, JSON.stringify(bars), bars[0]?.d ?? from, bars[bars.length - 1]?.d ?? to],
    );
  } catch (err) {
    logger.warn({ err, ticker }, "analyst bars cache write failed");
  }
  return { bars, fetchedAt: Date.now() };
}

/* Background warm-up: one loop, de-duplicated queue, capped. */
const warmQueue = new Set<string>();
let warming = false;
function warmBars(tickers: string[], cap = 20) {
  for (const t of tickers.slice(0, cap)) {
    if (warmQueue.size >= 80) break;
    warmQueue.add(t);
  }
  if (warming || !warmQueue.size) return;
  warming = true;
  void (async () => {
    try {
      while (warmQueue.size) {
        const t = warmQueue.values().next().value as string;
        warmQueue.delete(t);
        await loadBars(t).catch(() => null);
      }
    } finally {
      warming = false;
    }
  })();
}

type ActionRow = {
  id: number; ticker: string; firm: string; action: string; graded_at: Date;
  to_grade: string | null; from_grade: string | null; price_target: string | null; price_target_from: string | null;
};

type ReactionEvent = {
  id: number; at: string; firm: string; kind: EventKind; dir: 1 | -1; rating: boolean; ptChg: number | null;
  reactionDay: string; reaction: Reaction | null;
};

function buildEvents(rows: ActionRow[], bars: Bar[] | null): ReactionEvent[] {
  const out: ReactionEvent[] = [];
  for (const r of rows) {
    const c = classifyAction(r);
    if (!c) continue;
    const at = new Date(r.graded_at);
    if (!Number.isFinite(at.getTime())) continue;
    const rd = reactionDay(at);
    out.push({
      id: r.id, at: at.toISOString(), firm: String(r.firm || "").trim(), kind: c.kind, dir: c.dir, rating: c.rating,
      ptChg: c.ptChg == null ? null : +c.ptChg.toFixed(2), reactionDay: rd,
      reaction: bars && bars.length ? reactionOn(bars, rd) : null,
    });
  }
  return out;
}

const KINDS: EventKind[] = ["up", "down", "init", "ptUp", "ptDown"];
function aggByKind(events: ReactionEvent[]): Record<EventKind | "rating", ReactionAgg> {
  const pick = (f: (e: ReactionEvent) => boolean) =>
    aggregate(events.filter((e) => e.reaction && f(e)).map((e) => ({ dir: e.dir, r: e.reaction! })));
  const out = { rating: pick((e) => e.rating) } as Record<EventKind | "rating", ReactionAgg>;
  for (const k of KINDS) out[k] = pick((e) => e.kind === k);
  return out;
}

function typicalMove(bars: Bar[], n = 60): number | null {
  const xs: number[] = [];
  for (let i = Math.max(1, bars.length - n); i < bars.length; i++) {
    const p = bars[i - 1].c;
    if (p > 0) xs.push(Math.abs((bars[i].c - p) / p) * 100);
  }
  if (xs.length < 10) return null;
  xs.sort((a, b) => a - b);
  return +xs[Math.floor(xs.length / 2)].toFixed(2);
}

async function actionsFor(tickers: string[], sinceIso: string): Promise<ActionRow[]> {
  if (!tickers.length) return [];
  const { rows } = await pool.query<ActionRow>(
    `SELECT id, ticker, firm, action, graded_at, to_grade, from_grade, price_target, price_target_from
       FROM analyst_actions_cache
      WHERE ticker = ANY($1::text[]) AND graded_at >= $2
      ORDER BY graded_at DESC`,
    [tickers, sinceIso],
  );
  return rows;
}

const reactionDetailCache = new Map<string, { ts: number; body: unknown }>();
const DETAIL_TTL = 10 * 60_000;

router.get("/analyst-actions/reaction", asyncHandler(async (req, res): Promise<void> => {
  const ticker = String(req.query.ticker || "").toUpperCase().trim();
  if (!SYMBOL_RE.test(ticker)) throw badRequest("INVALID_TICKER");
  const hit = reactionDetailCache.get(ticker);
  if (hit && Date.now() - hit.ts < DETAIL_TTL) { res.json(hit.body); return; }

  let cached: CachedBars | null;
  let rows: ActionRow[];
  try {
    cached = await loadBars(ticker);
    rows = await actionsFor([ticker], new Date(Date.now() - REACTION_LOOKBACK_DAYS * 86400_000).toISOString());
  } catch (e: any) {
    req.log?.warn({ error: e?.message }, "analyst reaction failed");
    throw new AppError("COMPUTE_FAILED");
  }
  const bars = cached?.bars ?? [];
  const events = buildEvents(rows, bars);

  const firmMap = new Map<string, ReactionEvent[]>();
  for (const e of events) {
    if (!e.firm) continue;
    const arr = firmMap.get(e.firm) ?? [];
    arr.push(e);
    firmMap.set(e.firm, arr);
  }
  const byFirm = Array.from(firmMap.entries())
    .map(([firm, list]) => {
      const withR = list.filter((e) => e.reaction);
      return {
        firm,
        events: list.length,
        rating: aggregate(withR.filter((e) => e.rating).map((e) => ({ dir: e.dir, r: e.reaction! }))),
        all: aggregate(withR.map((e) => ({ dir: e.dir, r: e.reaction! }))),
        lastAt: list[0]?.at ?? null,
      };
    })
    .sort((a, b) => b.events - a.events)
    .slice(0, 25);

  const body = {
    ticker,
    lookbackDays: REACTION_LOOKBACK_DAYS,
    bars: { count: bars.length, from: bars[0]?.d ?? null, to: bars[bars.length - 1]?.d ?? null, fetchedAt: cached ? new Date(cached.fetchedAt).toISOString() : null },
    typicalMove: typicalMove(bars),
    byKind: aggByKind(events),
    byFirm,
    events: events.slice(0, 200).map((e) => ({
      id: e.id, at: e.at, firm: e.firm, kind: e.kind, dir: e.dir, rating: e.rating, ptChg: e.ptChg, reactionDay: e.reactionDay,
      gap: e.reaction?.gap ?? null, day: e.reaction?.dayMove ?? null, o2c: e.reaction?.o2c ?? null,
      ratio: e.reaction?.ratio ?? null, volRatio: e.reaction?.volRatio ?? null,
    })),
    // Closes for the «target vs price» chart (last ~12 months).
    prices: bars.slice(-260).map((b) => ({ d: b.d, c: +b.c.toFixed(4) })),
    generatedAt: new Date().toISOString(),
  };
  if (bars.length) reactionDetailCache.set(ticker, { ts: Date.now(), body });
  res.json(body);
}));

type TickerSummary = {
  typicalMove: number | null;
  rating: ReactionAgg; up: ReactionAgg; down: ReactionAgg; init: ReactionAgg; ptUp: ReactionAgg; ptDown: ReactionAgg;
};
const summaryCache = new Map<string, { fetchedAt: number; body: TickerSummary }>();

router.get("/analyst-actions/reactions", asyncHandler(async (req, res): Promise<void> => {
  const tickers = Array.from(new Set(
    String(req.query.tickers || "").toUpperCase().split(",").map((s) => s.trim()).filter((s) => SYMBOL_RE.test(s)),
  )).slice(0, 80);
  if (!tickers.length) { res.json({ tickers: {}, pending: [] }); return; }

  let cache: Map<string, CachedBars>;
  try {
    cache = await readBars(tickers);
  } catch (e: any) {
    req.log?.warn({ error: e?.message }, "analyst reactions: bars read failed");
    throw new AppError("COMPUTE_FAILED");
  }
  const missing = tickers.filter((t) => !cache.has(t) || Date.now() - cache.get(t)!.fetchedAt > BARS_TTL_MS);
  warmBars(missing, 20);

  const out: Record<string, TickerSummary> = {};
  const need: string[] = [];
  for (const t of tickers) {
    const c = cache.get(t);
    if (!c || !c.bars.length) continue;
    const s = summaryCache.get(t);
    if (s && s.fetchedAt === c.fetchedAt) out[t] = s.body;
    else need.push(t);
  }
  if (need.length) {
    const rows = await actionsFor(need, new Date(Date.now() - REACTION_LOOKBACK_DAYS * 86400_000).toISOString());
    const byT = new Map<string, ActionRow[]>();
    for (const r of rows) { const a = byT.get(r.ticker) ?? []; a.push(r); byT.set(r.ticker, a); }
    for (const t of need) {
      const c = cache.get(t)!;
      const k = aggByKind(buildEvents(byT.get(t) ?? [], c.bars));
      const body: TickerSummary = { typicalMove: typicalMove(c.bars), rating: k.rating, up: k.up, down: k.down, init: k.init, ptUp: k.ptUp, ptDown: k.ptDown };
      summaryCache.set(t, { fetchedAt: c.fetchedAt, body });
      out[t] = body;
    }
  }
  res.json({ tickers: out, pending: tickers.filter((t) => !out[t]) });
}));

type FirmWeight = {
  firm: string;
  /** Rating calls (upgrade / downgrade / initiation with a buy or sell stance) with a measured reaction. */
  rating: ReactionAgg;
  up: ReactionAgg;
  down: ReactionAgg;
  /** Target-only changes ≥ 5 %. */
  pt: ReactionAgg;
  tickers: number;
};
const firmWeightCache = new Map<string, { ts: number; body: unknown }>();
const FIRM_WEIGHT_TTL = 20 * 60_000;

router.get("/analyst-actions/firm-weight", asyncHandler(async (req, res): Promise<void> => {
  const days = Math.max(90, Math.min(REACTION_LOOKBACK_DAYS, Math.round(Number(req.query.days) || REACTION_LOOKBACK_DAYS)));
  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();

  let cachedTickers: { ticker: string; fetched_at: Date }[];
  let rated: { ticker: string; n: number }[];
  try {
    await ensureBarsTable();
    ({ rows: cachedTickers } = await pool.query(`SELECT ticker, fetched_at FROM analyst_bars_cache WHERE jsonb_array_length(bars) > 0`));
    ({ rows: rated } = await pool.query(
      `SELECT ticker, COUNT(*)::int AS n FROM analyst_actions_cache
        WHERE graded_at >= $1 AND action IN ('up','down','init') GROUP BY ticker ORDER BY n DESC`,
      [sinceIso],
    ));
  } catch (e: any) {
    req.log?.warn({ error: e?.message }, "analyst firm weight: base query failed");
    throw new AppError("COMPUTE_FAILED");
  }
  const have = new Set(cachedTickers.map((r) => r.ticker));
  const stale = new Set(cachedTickers.filter((r) => Date.now() - new Date(r.fetched_at).getTime() > BARS_TTL_MS).map((r) => r.ticker));
  // Warm the most-rated tickers we don't have yet (background, capped).
  warmBars(rated.filter((r) => !have.has(r.ticker) || stale.has(r.ticker)).map((r) => r.ticker), 25);

  const coverage = { tickers: rated.filter((r) => have.has(r.ticker)).length, ratedTickers: rated.length, warming: warming || warmQueue.size > 0 };
  const key = `${days}:${have.size}`;
  const hit = firmWeightCache.get(key);
  if (hit && Date.now() - hit.ts < FIRM_WEIGHT_TTL) { res.json({ ...(hit.body as object), coverage }); return; }

  const tickers = rated.filter((r) => have.has(r.ticker)).map((r) => r.ticker);
  const acc = new Map<string, { rating: { dir: 1 | -1; r: Reaction }[]; up: { dir: 1 | -1; r: Reaction }[]; down: { dir: 1 | -1; r: Reaction }[]; pt: { dir: 1 | -1; r: Reaction }[]; tickers: Set<string> }>();
  // Chunked so a large cache never holds every series in memory at once.
  for (let i = 0; i < tickers.length; i += 40) {
    const chunk = tickers.slice(i, i + 40);
    const [bars, rows] = await Promise.all([readBars(chunk), actionsFor(chunk, sinceIso)]);
    const byT = new Map<string, ActionRow[]>();
    for (const r of rows) { const a = byT.get(r.ticker) ?? []; a.push(r); byT.set(r.ticker, a); }
    for (const t of chunk) {
      const b = bars.get(t)?.bars;
      if (!b?.length) continue;
      for (const e of buildEvents(byT.get(t) ?? [], b)) {
        if (!e.reaction || !e.firm) continue;
        let f = acc.get(e.firm);
        if (!f) { f = { rating: [], up: [], down: [], pt: [], tickers: new Set() }; acc.set(e.firm, f); }
        const item = { dir: e.dir, r: e.reaction };
        if (e.rating) {
          f.rating.push(item);
          if (e.kind === "up") f.up.push(item);
          if (e.kind === "down") f.down.push(item);
        } else f.pt.push(item);
        f.tickers.add(t);
      }
    }
  }
  let allRating: { dir: 1 | -1; r: Reaction }[] = [];
  const firms: FirmWeight[] = [];
  for (const [firm, f] of acc) {
    allRating = allRating.concat(f.rating);
    if (f.rating.length + f.pt.length < 3) continue;
    firms.push({ firm, rating: aggregate(f.rating), up: aggregate(f.up), down: aggregate(f.down), pt: aggregate(f.pt), tickers: f.tickers.size });
  }
  firms.sort((a, b) => b.rating.n - a.rating.n || b.pt.n - a.pt.n);
  const body = {
    days,
    minN: 5,
    street: aggregate(allRating),
    firms: firms.slice(0, 300),
    generatedAt: new Date().toISOString(),
  };
  firmWeightCache.set(key, { ts: Date.now(), body });
  res.json({ ...body, coverage });
}));

type DayAgg = { trades: number; days: number; net: number; wins: number; losses: number; winRate: number | null; avgNet: number | null };

router.get("/analyst-actions/my-days", asyncHandler(async (req, res): Promise<void> => {
  const scope = await scopeTrader(req, typeof req.query.trader === "string" ? req.query.trader : null);
  if (scope === undefined) throw unauthorized();
  const days = Math.max(30, Math.min(730, Math.round(Number(req.query.days) || 365)));
  const since = addDays(nyDate(), -days);
  const empty = (): DayAgg => ({ trades: 0, days: 0, net: 0, wins: 0, losses: 0, winRate: null, avgNet: null });

  type Row = { tk: string; d: string; side: string; net: number | null; res: string | null; has_up: boolean; has_down: boolean; has_init: boolean; has_any: boolean };
  let rows: Row[] = [];
  if (scope !== GUEST_SCOPE) {
    try {
      ({ rows } = await pool.query<Row>(
        `WITH tr AS (
           SELECT t.id, UPPER(TRIM(t.ticker)) AS tk, t.date AS d, LOWER(COALESCE(t.side, '')) AS side,
                  ${netPnlSql("t")} AS net, ${resultSql("t")} AS res
             FROM trades t
            WHERE t.deleted_at IS NULL AND ${closedSql("t")}
              AND ($1::text IS NULL OR t.trader = $1)
              AND t.date >= $2
         ), ev AS (
           SELECT x.ticker, x.action,
                  (x.base + CASE EXTRACT(DOW FROM x.base) WHEN 6 THEN 2 WHEN 0 THEN 1 ELSE 0 END)::date AS rd
             FROM (
               SELECT a.ticker, a.action,
                      ((a.graded_at AT TIME ZONE 'America/New_York')::date
                        + CASE WHEN (a.graded_at AT TIME ZONE 'America/New_York')::time >= TIME '16:00' THEN 1 ELSE 0 END) AS base
                 FROM analyst_actions_cache a
                WHERE a.graded_at >= ($2::date - 5)
                  AND a.ticker IN (SELECT DISTINCT tk FROM tr)
             ) x
         )
         SELECT tr.tk, tr.d, tr.side, tr.net::float8 AS net, tr.res,
                COALESCE(BOOL_OR(ev.action = 'up'), FALSE) AS has_up,
                COALESCE(BOOL_OR(ev.action = 'down'), FALSE) AS has_down,
                COALESCE(BOOL_OR(ev.action = 'init'), FALSE) AS has_init,
                COUNT(ev.action) > 0 AS has_any
           FROM tr LEFT JOIN ev ON ev.ticker = tr.tk AND ev.rd::text = tr.d
          GROUP BY tr.id, tr.tk, tr.d, tr.side, tr.net, tr.res`,
        [scope, since],
      ));
    } catch (e: any) {
      req.log?.warn({ error: e?.message }, "analyst my-days query failed");
      throw new AppError("COMPUTE_FAILED");
    }
  }

  const buckets = { rating: empty(), target: empty(), none: empty(), up: empty(), down: empty(), init: empty(), withCall: empty(), againstCall: empty() };
  const daySets = new Map<DayAgg, Set<string>>();
  const add = (a: DayAgg, r: Row) => {
    a.trades++;
    if (r.net != null && Number.isFinite(r.net)) a.net += r.net;
    if (r.res === "win") a.wins++;
    if (r.res === "loss") a.losses++;
    let s = daySets.get(a);
    if (!s) { s = new Set(); daySets.set(a, s); }
    s.add(r.d);
  };
  const tick = new Map<string, { ticker: string; trades: number; net: number; wins: number; losses: number; lastDate: string; ratingDays: number }>();
  for (const r of rows) {
    const rating = r.has_up || r.has_down || r.has_init;
    add(rating ? buckets.rating : r.has_any ? buckets.target : buckets.none, r);
    if (r.has_up) add(buckets.up, r);
    if (r.has_down) add(buckets.down, r);
    if (r.has_init) add(buckets.init, r);
    if (r.has_up !== r.has_down) {
      const long = r.side.startsWith("l") || r.side.startsWith("b");
      const short = r.side.startsWith("s");
      if (long || short) add((r.has_up && long) || (r.has_down && short) ? buckets.withCall : buckets.againstCall, r);
    }
    let t = tick.get(r.tk);
    if (!t) { t = { ticker: r.tk, trades: 0, net: 0, wins: 0, losses: 0, lastDate: r.d, ratingDays: 0 }; tick.set(r.tk, t); }
    t.trades++;
    if (r.net != null && Number.isFinite(r.net)) t.net += r.net;
    if (r.res === "win") t.wins++;
    if (r.res === "loss") t.losses++;
    if (r.d > t.lastDate) t.lastDate = r.d;
    if (rating) t.ratingDays++;
  }
  for (const a of Object.values(buckets)) {
    a.days = daySets.get(a)?.size ?? 0;
    a.net = +a.net.toFixed(2);
    a.winRate = a.wins + a.losses ? +(a.wins / (a.wins + a.losses)).toFixed(3) : null;
    a.avgNet = a.trades ? +(a.net / a.trades).toFixed(2) : null;
  }
  res.json({
    trader: scope === GUEST_SCOPE ? null : scope,
    from: since,
    to: nyDate(),
    days,
    buckets,
    tickers: Array.from(tick.values())
      .map((t) => ({ ...t, net: +t.net.toFixed(2) }))
      .sort((a, b) => b.trades - a.trades)
      .slice(0, 400),
  });
}));

export default router;
