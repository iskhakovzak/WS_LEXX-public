import { Router, type IRouter } from "express";
import { eq, asc, and, inArray } from "drizzle-orm";
import { db, big7TickersTable, pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { scopeTrader } from "../lib/auth";
import { creatorName, requireRowOwnerOrStaff } from "../lib/ownedRows";
import { netPnlSql, resultSql, num } from "../lib/tradeMath";
import { execSpanJoin } from "../lib/execSpan";
import { nyDate, addDays as nyAddDays } from "../lib/tradingDate";
import { AppError, badRequest, notFound, unauthorized } from "../lib/http";
import { reviewT } from "../i18n/ns";
import { langOf, type Lang } from "../i18n";

const router: IRouter = Router();

const VALID_GROUPS = new Set(["core", "hot"]);
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

router.get("/big7/tickers", asyncHandler(async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(big7TickersTable)
    .orderBy(asc(big7TickersTable.groupName), asc(big7TickersTable.position), asc(big7TickersTable.id));
  res.json(rows);
}));

router.post("/big7/tickers", asyncHandler(async (req, res): Promise<void> => {
  const { symbol, exchange, name, groupName, position } = req.body as Record<string, unknown>;
  if (!symbol) throw new AppError("TICKER_REQUIRED");
  const group = VALID_GROUPS.has(String(groupName)) ? String(groupName) : "core";
  const sym = String(symbol).toUpperCase().trim().replace(/^\$/, "");
  if (!SYMBOL_RE.test(sym)) throw new AppError("INVALID_SYMBOL");
  const existing = await db
    .select()
    .from(big7TickersTable)
    .where(and(eq(big7TickersTable.groupName, group), eq(big7TickersTable.symbol, sym)));
  if (existing.length > 0) {
    res.status(200).json(existing[0]);
    return;
  }
  const [row] = await db.insert(big7TickersTable).values({
    symbol: sym,
    exchange: exchange ? String(exchange).toUpperCase() : "NASDAQ",
    name: name ? String(name) : sym,
    groupName: group,
    position: typeof position === "number" ? position : 999,
    createdBy: await creatorName(req),
  }).returning();
  res.status(201).json(row);
}));

router.post("/big7/tickers/bulk", asyncHandler(async (req, res): Promise<void> => {
  const { symbols, groupName } = req.body as { symbols?: unknown; groupName?: unknown };
  if (!Array.isArray(symbols) || symbols.length === 0) throw new AppError("FIELD_REQUIRED", undefined, { field: "symbols" });
  const group = VALID_GROUPS.has(String(groupName)) ? String(groupName) : "core";
  const cleaned = Array.from(
    new Set(
      symbols
        .map((s) => String(s).toUpperCase().trim())
        .filter((s) => SYMBOL_RE.test(s)),
    ),
  );
  if (cleaned.length === 0) {
    res.json({ added: [], skipped: [] });
    return;
  }
  const existing = await db
    .select()
    .from(big7TickersTable)
    .where(and(eq(big7TickersTable.groupName, group), inArray(big7TickersTable.symbol, cleaned)));
  const existingSet = new Set(existing.map((r) => r.symbol));
  const toInsert = cleaned.filter((s) => !existingSet.has(s));
  let added: typeof existing = [];
  if (toInsert.length > 0) {
    const createdBy = await creatorName(req);
    added = await db.insert(big7TickersTable).values(
      toInsert.map((s, i) => ({
        symbol: s,
        exchange: "NASDAQ",
        name: s,
        groupName: group,
        position: 1000 + i,
        createdBy,
      })),
    ).returning();
  }
  res.status(201).json({ added, skipped: cleaned.filter((s) => existingSet.has(s)) });
}));

router.patch("/big7/tickers/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) throw badRequest("INVALID_ID");
  const [owned] = await db.select({ createdBy: big7TickersTable.createdBy }).from(big7TickersTable).where(eq(big7TickersTable.id, id));
  if (!owned) throw notFound();
  // Reordering (position) and moving between groups touch a shared board row → same owner-or-staff rule.
  if (!(await requireRowOwnerOrStaff(req, res, owned.createdBy))) return;
  const { symbol, exchange, name, groupName, position } = req.body as Record<string, unknown>;
  const [row] = await db.update(big7TickersTable).set({
    symbol: symbol !== undefined ? String(symbol).toUpperCase() : undefined,
    exchange: exchange !== undefined ? String(exchange).toUpperCase() : undefined,
    name: name !== undefined ? String(name) : undefined,
    groupName: groupName !== undefined && VALID_GROUPS.has(String(groupName)) ? String(groupName) : undefined,
    position: typeof position === "number" ? position : undefined,
  }).where(eq(big7TickersTable.id, id)).returning();
  if (!row) {
    throw notFound();
  }
  res.json(row);
}));

router.delete("/big7/tickers/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) throw badRequest("INVALID_ID");
  const [owned] = await db.select({ createdBy: big7TickersTable.createdBy }).from(big7TickersTable).where(eq(big7TickersTable.id, id));
  if (!owned) { res.status(204).send(); return; }
  if (!(await requireRowOwnerOrStaff(req, res, owned.createdBy))) return;
  await db.delete(big7TickersTable).where(eq(big7TickersTable.id, id));
  res.status(204).send();
}));

// ─── Gap risk / relative strength (daily bars, heavily cached) ──────────────
// GET /api/big7/gaprisk?symbols=AAPL,MSFT
// Per symbol: ATR(14), average/p90/max overnight gap, 5d/20d return, trend vs SMA20/50,
// relative strength vs SPY and QQQ, and a 30-close sparkline. SPY/QQQ are always included
// as benchmarks. Daily stats change slowly, so each symbol is fetched from Yahoo at most
// once per BARS_TTL (failures are cached briefly too) with low concurrency.

type DailyBar = { t: number; o: number; h: number; l: number; c: number };

const BARS_TTL = 20 * 60_000;
const BARS_FAIL_TTL = 2 * 60_000;
const barsCache = new Map<string, { ts: number; bars: DailyBar[] | null }>();
const barsInflight = new Map<string, Promise<DailyBar[] | null>>();
const GAP_SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const BENCHMARKS = ["SPY", "QQQ"] as const;

async function fetchDailyBars(sym: string): Promise<DailyBar[] | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1d`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, Array<number | null>>> } }> };
    };
    const r = data?.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const q = r?.indicators?.quote?.[0] ?? {};
    const bars: DailyBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (o == null || h == null || l == null || c == null || !(c > 0) || !(o > 0)) continue;
      bars.push({ t: ts[i] * 1000, o, h, l, c });
    }
    return bars.length ? bars : null;
  } catch {
    return null;
  }
}

async function getDailyBars(sym: string): Promise<DailyBar[] | null> {
  const hit = barsCache.get(sym);
  if (hit && Date.now() - hit.ts < (hit.bars ? BARS_TTL : BARS_FAIL_TTL)) return hit.bars;
  const pending = barsInflight.get(sym);
  if (pending) return pending;
  const p = fetchDailyBars(sym).then((bars) => {
    barsCache.set(sym, { ts: Date.now(), bars });
    barsInflight.delete(sym);
    return bars;
  });
  barsInflight.set(sym, p);
  return p;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function pctl(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}
const etDay = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

type GapStats = {
  lastClose: number;
  atr: number | null;
  atrPct: number | null;
  avgGapPct20: number | null;
  avgGapPct60: number | null;
  p90GapPct60: number | null;
  maxGap60: { pct: number; date: string } | null;
  gapsOver1Pct: number | null;
  todayGapPct: number | null;
  ret5: number | null;
  ret20: number | null;
  sma20: number | null;
  sma50: number | null;
  trend: "up" | "down" | "mixed";
  spark: number[];
};

function computeStats(bars: DailyBar[]): GapStats {
  const n = bars.length;
  const last = bars[n - 1];
  const closes = bars.map((b) => b.c);
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const pc = bars[i - 1].c;
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc)));
  }
  const atr = trs.length >= 14 ? mean(trs.slice(-14)) : null;
  const gaps: Array<{ pct: number; date: string }> = [];
  for (let i = Math.max(1, n - 60); i < n; i++) {
    const pc = bars[i - 1].c;
    gaps.push({ pct: ((bars[i].o - pc) / pc) * 100, date: etDay(bars[i].t) });
  }
  const abs60 = gaps.map((g) => Math.abs(g.pct));
  const abs20 = abs60.slice(-20);
  const maxG = gaps.reduce<{ pct: number; date: string } | null>((m, g) => (!m || Math.abs(g.pct) > Math.abs(m.pct) ? g : m), null);
  const ret = (k: number) => (n > k ? ((last.c / closes[n - 1 - k]) - 1) * 100 : null);
  const sma = (k: number) => (n >= k ? mean(closes.slice(-k)) : null);
  const sma20 = sma(20), sma50 = sma(50);
  const trend: GapStats["trend"] =
    sma20 != null && sma50 != null && last.c > sma20 && sma20 > sma50 ? "up"
      : sma20 != null && sma50 != null && last.c < sma20 && sma20 < sma50 ? "down"
      : "mixed";
  const isToday = etDay(last.t) === etDay(Date.now());
  const avg20 = mean(abs20), avg60 = mean(abs60), p90 = pctl(abs60, 0.9);
  return {
    lastClose: r2(last.c),
    atr: atr != null ? r2(atr) : null,
    atrPct: atr != null ? r2((atr / last.c) * 100) : null,
    avgGapPct20: avg20 != null ? r2(avg20) : null,
    avgGapPct60: avg60 != null ? r2(avg60) : null,
    p90GapPct60: p90 != null ? r2(p90) : null,
    maxGap60: maxG ? { pct: r2(maxG.pct), date: maxG.date } : null,
    gapsOver1Pct: abs60.length ? Math.round((abs60.filter((g) => g > 1).length / abs60.length) * 100) : null,
    todayGapPct: isToday && gaps.length ? r2(gaps[gaps.length - 1].pct) : null,
    ret5: ret(5) != null ? r2(ret(5)!) : null,
    ret20: ret(20) != null ? r2(ret(20)!) : null,
    sma20: sma20 != null ? r2(sma20) : null,
    sma50: sma50 != null ? r2(sma50) : null,
    trend,
    spark: closes.slice(-30).map(r2),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

router.get("/big7/gaprisk", asyncHandler(async (req, res): Promise<void> => {
  const raw = String(req.query.symbols ?? "");
  const requested = Array.from(new Set(
    raw.toUpperCase().split(",").map((s) => s.trim().replace(/^\$/, "")).filter(Boolean),
  ));
  if (requested.length > 30) throw new AppError("TOO_MANY", undefined, { field: "symbols", max: 30 });
  const bad = requested.find((s) => !GAP_SYMBOL_RE.test(s));
  if (bad) throw new AppError("INVALID_SYMBOL", 400, undefined, { symbol: bad });

  const all = Array.from(new Set([...BENCHMARKS, ...requested]));
  const barsList = await mapLimit(all, 4, getDailyBars);
  const stats = new Map<string, GapStats>();
  all.forEach((s, i) => {
    const b = barsList[i];
    if (b && b.length >= 2) stats.set(s, computeStats(b));
  });

  const rel = (a: number | null, b: number | null | undefined) => (a != null && b != null ? r2(a - b) : null);
  const spy = stats.get("SPY");
  const qqq = stats.get("QQQ");
  const symbols: Record<string, GapStats & { rs5Spy: number | null; rs20Spy: number | null; rs5Qqq: number | null; rs20Qqq: number | null }> = {};
  for (const s of requested) {
    const st = stats.get(s);
    if (!st) continue;
    symbols[s] = {
      ...st,
      rs5Spy: rel(st.ret5, spy?.ret5),
      rs20Spy: rel(st.ret20, spy?.ret20),
      rs5Qqq: rel(st.ret5, qqq?.ret5),
      rs20Qqq: rel(st.ret20, qqq?.ret20),
    };
  }
  res.json({
    asOf: new Date().toISOString(),
    benchmarks: { SPY: spy ?? null, QQQ: qqq ?? null },
    symbols,
    missing: requested.filter((s) => !stats.has(s)),
  });
}));

// ─── Personal stats on the board tickers (own trades) ───────────────────────
// GET /api/big7/mystats?symbols=AAPL,MSFT&days=90[&trader=]   (days=0 ⇒ all time)
// Net (pnl − |fees|), win rate W/(W+L), per ticker and per entry-time bucket (NY time).
// Scope: a trader always gets their own book; staff may pass ?trader= (default: themselves).
// Share classes are folded onto the board symbol (GOOG ⇄ GOOGL).

const ALIASES: Record<string, string[]> = { GOOGL: ["GOOG"], GOOG: ["GOOGL"], "BRK.B": ["BRK-B"], "BRK-B": ["BRK.B"] };

const HOUR_BUCKETS: Array<{ key: string; label: string; from: number; to: number }> = [
  { key: "pre", label: "", from: 0, to: 570 }, // label: review namespace hours.pre
  { key: "open", label: "9:30–10", from: 570, to: 600 },
  { key: "10", label: "10–11", from: 600, to: 660 },
  { key: "11", label: "11–12", from: 660, to: 720 },
  { key: "lunch", label: "12–14", from: 720, to: 840 },
  { key: "14", label: "14–15", from: 840, to: 900 },
  { key: "15", label: "15–16", from: 900, to: 960 },
  { key: "post", label: "", from: 960, to: 1440 }, // label: review namespace hours.post
];
/** Bucket label in `lang` (pre / post are words, the rest are time ranges). */
const hourLabel = (b: { key: string; label: string }, lang: Lang): string => (b.key === "pre" || b.key === "post" ? reviewT.tFor(lang)(`hours.${b.key}`) : b.label);
const bucketOf = (min: number | null) => (min == null ? null : HOUR_BUCKETS.find((b) => min >= b.from && min < b.to) ?? null);

type Agg = { n: number; net: number; wins: number; losses: number };
const emptyAgg = (): Agg => ({ n: 0, net: 0, wins: 0, losses: 0 });
const addAgg = (a: Agg, net: number, res: string | null) => {
  a.n++; a.net += net;
  if (res === "win") a.wins++;
  else if (res === "loss") a.losses++;
};
const outAgg = (a: Agg) => ({
  n: a.n,
  net: Math.round(a.net * 100) / 100,
  wins: a.wins,
  losses: a.losses,
  wr: a.wins + a.losses > 0 ? Math.round((a.wins / (a.wins + a.losses)) * 1000) / 10 : null,
  avg: a.n > 0 ? Math.round((a.net / a.n) * 100) / 100 : null,
});

const NY_TZ_SQL = "America/New_York";
const ENTRY_MIN_SQL = `(CASE
  WHEN e.first_entry IS NOT NULL THEN EXTRACT(HOUR FROM (e.first_entry AT TIME ZONE '${NY_TZ_SQL}'))::int * 60 + EXTRACT(MINUTE FROM (e.first_entry AT TIME ZONE '${NY_TZ_SQL}'))::int
  WHEN (t.context_snapshot->>'openedAt') ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}' THEN substring(t.context_snapshot->>'openedAt' from 12 for 2)::int * 60 + substring(t.context_snapshot->>'openedAt' from 15 for 2)::int
  WHEN t.date ~ '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}' THEN substring(t.date from 12 for 2)::int * 60 + substring(t.date from 15 for 2)::int
  ELSE NULL END)`;

router.get("/big7/mystats", asyncHandler(async (req, res): Promise<void> => {
  const lang = langOf(req);
  const raw = String(req.query.symbols ?? "");
  const board = Array.from(new Set(raw.toUpperCase().split(",").map((s) => s.trim().replace(/^\$/, "")).filter(Boolean)));
  if (!board.length) throw new AppError("FIELD_REQUIRED", undefined, { field: "symbols" });
  if (board.length > 30) throw new AppError("TOO_MANY", undefined, { field: "symbols", max: 30 });
  const bad = board.find((s) => !GAP_SYMBOL_RE.test(s));
  if (bad) throw new AppError("INVALID_SYMBOL", 400, undefined, { symbol: bad });
  const daysRaw = Number(req.query.days ?? 0);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(3650, Math.round(daysRaw)) : 0;
  const requested = typeof req.query.trader === "string" && req.query.trader.trim() ? req.query.trader.trim().slice(0, 120) : req.authUser?.name ?? null;
  const scope = await scopeTrader(req, requested);
  if (scope === undefined) throw unauthorized();
  if (!scope) { res.json({ trader: null, from: null, total: outAgg(emptyAgg()), tickers: [], hours: [] }); return; }

  // Every SQL ticker maps back to one board symbol.
  const toBoard = new Map<string, string>();
  for (const s of board) {
    toBoard.set(s, s);
    for (const a of ALIASES[s] ?? []) if (!board.includes(a)) toBoard.set(a, s);
  }
  const from = days > 0 ? nyAddDays(nyDate(), -days) : null;
  const { rows } = await pool.query<{ ticker: string; side: string | null; net: string | number | null; res: string | null; entry_min: number | null; d: string }>(
    `SELECT UPPER(t.ticker) AS ticker, t.side, ${netPnlSql("t")} AS net, ${resultSql("t")} AS res,
            ${ENTRY_MIN_SQL} AS entry_min, substring(t.date from 1 for 10) AS d
     FROM trades t ${execSpanJoin("lateral")}
     WHERE t.deleted_at IS NULL AND t.trader = $1 AND t.pnl IS NOT NULL
       AND UPPER(t.ticker) = ANY($2::text[])
       AND ($3::text IS NULL OR substring(t.date from 1 for 10) >= $3)`,
    [scope, Array.from(toBoard.keys()), from],
  );

  const total = emptyAgg();
  const hours = new Map<string, Agg>();
  const per = new Map<string, { all: Agg; long: Agg; short: Agg; hours: Map<string, Agg>; last: string | null }>();
  for (const r of rows) {
    const net = num(r.net);
    if (net == null) continue;
    const sym = toBoard.get(r.ticker) ?? r.ticker;
    const result = r.res === "open" ? null : r.res;
    addAgg(total, net, result);
    let p = per.get(sym);
    if (!p) { p = { all: emptyAgg(), long: emptyAgg(), short: emptyAgg(), hours: new Map(), last: null }; per.set(sym, p); }
    addAgg(p.all, net, result);
    addAgg(String(r.side ?? "").trim().toLowerCase().startsWith("s") ? p.short : p.long, net, result);
    if (!p.last || r.d > p.last) p.last = r.d;
    const b = bucketOf(r.entry_min == null ? null : Number(r.entry_min));
    if (b) {
      if (!hours.has(b.key)) hours.set(b.key, emptyAgg());
      addAgg(hours.get(b.key)!, net, result);
      if (!p.hours.has(b.key)) p.hours.set(b.key, emptyAgg());
      addAgg(p.hours.get(b.key)!, net, result);
    }
  }
  const pickHour = (m: Map<string, Agg>, dir: 1 | -1) => {
    let best: { key: string; label: string; net: number; n: number } | null = null;
    for (const b of HOUR_BUCKETS) {
      const a = m.get(b.key);
      if (!a || a.n < 2) continue;
      if (!best || dir * a.net > dir * best.net) best = { key: b.key, label: hourLabel(b, lang), net: Math.round(a.net * 100) / 100, n: a.n };
    }
    return best && dir * best.net > 0 ? best : null;
  };
  res.json({
    trader: scope,
    from,
    total: outAgg(total),
    tickers: board.filter((s) => per.has(s)).map((s) => {
      const p = per.get(s)!;
      return { ticker: s, ...outAgg(p.all), longNet: outAgg(p.long).net, shortNet: outAgg(p.short).net, lastDate: p.last, bestHour: pickHour(p.hours, 1), worstHour: pickHour(p.hours, -1) };
    }),
    hours: HOUR_BUCKETS.map((b) => ({ key: b.key, label: hourLabel(b, lang), ...outAgg(hours.get(b.key) ?? emptyAgg()) })),
  });
}));

export default router;
