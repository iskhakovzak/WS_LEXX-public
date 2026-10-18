/**
 * Pure overnight-book math: mark-to-market, gap scenarios and concentration.
 * No React / fetch here so it can be checked offline (scratchpad risk-math.check.ts).
 */

export type BookPosition = {
  id: number;
  ticker: string;
  trader: string;
  side: string | null;
  qty: number | null;
  entry: number | null;
  stop: number | null;
  exposureUsd: number | null;
  sector?: string | null;
  /** ATR from the server cache (fallback when the quote has none). */
  atr?: number | null;
};

export type BookQuote = { price: number | null; atr?: number | null };

export type BookLimits = {
  dailyLossLimit: number | null;
  maxOvernightExposure?: number | null;
} | null;

export type TraderRoom = {
  trader: string;
  limits: BookLimits;
  /** Remaining daily loss room right now (null when no daily limit). */
  dailyRemainingUsd: number | null;
};

/** Fallback ATR when neither quote nor cache has one: 3% of price. */
export const ATR_FALLBACK_PCT = 0.03;

export function isShort(side: string | null | undefined): boolean {
  const s = String(side ?? "").trim().toLowerCase();
  return s.startsWith("s") || s.startsWith("ш"); // i18n-ignore: parses broker side spelled «шорт» (data, not UI)
}

/** +1 for long, −1 for short. */
export function dir(side: string | null | undefined): 1 | -1 {
  return isShort(side) ? -1 : 1;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export type Marked = {
  last: number | null;
  /** Price used for maths: last → entry. */
  mark: number | null;
  atr: number | null;
  atrSource: "quote" | "cache" | "fallback" | null;
  unrealizedUsd: number | null;
  unrealizedPct: number | null;
  /** $ lost if the stop is hit from the current mark (0 when already through the stop). */
  riskToStopUsd: number | null;
  /** Live market value |mark × qty| (falls back to cost exposure). */
  marketValueUsd: number | null;
};

export function markPosition(p: BookPosition, q: BookQuote | undefined): Marked {
  const last = q?.price != null && Number.isFinite(q.price) && q.price > 0 ? q.price : null;
  const mark = last ?? p.entry ?? null;
  const d = dir(p.side);
  const qty = p.qty != null ? Math.abs(p.qty) : null;
  let atr: number | null = null;
  let atrSource: Marked["atrSource"] = null;
  if (q?.atr != null && q.atr > 0) { atr = q.atr; atrSource = "quote"; }
  else if (p.atr != null && p.atr > 0) { atr = p.atr; atrSource = "cache"; }
  else if (mark != null) { atr = r2(mark * ATR_FALLBACK_PCT); atrSource = "fallback"; }
  const unrealized = last != null && p.entry != null && qty != null ? r2(d * (last - p.entry) * qty) : null;
  const unrealizedPct = last != null && p.entry != null && p.entry > 0 ? r2((d * (last - p.entry) / p.entry) * 100) : null;
  const riskToStop = mark != null && p.stop != null && qty != null ? r2(Math.max(0, d * (mark - p.stop) * qty)) : null;
  const mv = mark != null && qty != null ? r2(mark * qty) : p.exposureUsd ?? null;
  return { last, mark, atr, atrSource, unrealizedUsd: unrealized, unrealizedPct, riskToStopUsd: riskToStop, marketValueUsd: mv };
}

// ─── gap scenarios ──────────────────────────────────────────────────────────

export type Shock =
  | { key: string; label: string; kind: "atr"; k: number }
  | { key: string; label: string; kind: "pct"; pct: number };

export const DEFAULT_SHOCKS: Shock[] = [
  { key: "-1atr", label: "−1 ATR", kind: "atr", k: -1 },
  { key: "-2atr", label: "−2 ATR", kind: "atr", k: -2 },
  { key: "-3atr", label: "−3 ATR", kind: "atr", k: -3 },
];

/**
 * "market": every ticker gaps by the shock (longs lose on a down gap, shorts gain).
 * "adverse": every position gaps against itself by |shock| (worst case for the book).
 */
export type ShockMode = "market" | "adverse";

export type PositionShock = { id: number; ticker: string; trader: string; newPrice: number | null; pnlUsd: number | null; movePct: number | null };
export type TraderShock = {
  trader: string;
  pnlUsd: number;
  /** Daily room after the shock (null when no limit). Negative ⇒ breach of the daily stop. */
  remainingAfterUsd: number | null;
  breach: boolean;
  /** Positions that drive the loss, worst first. */
  worst: PositionShock[];
};
export type ShockResult = {
  shock: Shock;
  mode: ShockMode;
  positions: PositionShock[];
  traders: TraderShock[];
  desk: { pnlUsd: number; breaches: string[]; worstTrader: string | null };
};

export function shockPrice(mark: number, atr: number | null, shock: Shock, mode: ShockMode, side: string | null): number {
  const d = dir(side);
  let move: number; // signed $ move of the price
  if (shock.kind === "atr") {
    const a = atr ?? mark * ATR_FALLBACK_PCT;
    move = shock.k * a;
  } else {
    move = (shock.pct / 100) * mark;
  }
  if (mode === "adverse") move = -Math.abs(move) * d; // against the position: long → down, short → up
  return Math.max(0, r2(mark + move));
}

export function runShock(
  positions: BookPosition[],
  quotes: Record<string, BookQuote | undefined>,
  rooms: TraderRoom[],
  shock: Shock,
  mode: ShockMode = "market",
): ShockResult {
  const roomBy = new Map(rooms.map((r) => [r.trader, r]));
  const perPos: PositionShock[] = positions.map((p) => {
    const m = markPosition(p, quotes[p.ticker.toUpperCase()]);
    const qty = p.qty != null ? Math.abs(p.qty) : null;
    if (m.mark == null || qty == null) return { id: p.id, ticker: p.ticker, trader: p.trader, newPrice: null, pnlUsd: null, movePct: null };
    const np = shockPrice(m.mark, m.atr, shock, mode, p.side);
    const pnl = r2(dir(p.side) * (np - m.mark) * qty);
    return { id: p.id, ticker: p.ticker, trader: p.trader, newPrice: np, pnlUsd: pnl, movePct: r2(((np - m.mark) / m.mark) * 100) };
  });
  const traders = [...new Set(positions.map((p) => p.trader))].map((t) => {
    const mine = perPos.filter((x) => x.trader === t);
    const pnl = r2(mine.reduce((s, x) => s + (x.pnlUsd ?? 0), 0));
    const room = roomBy.get(t);
    const remaining = room?.dailyRemainingUsd ?? null;
    const after = remaining == null ? null : r2(remaining + pnl);
    return {
      trader: t,
      pnlUsd: pnl,
      remainingAfterUsd: after,
      breach: after != null && after < 0,
      worst: [...mine].sort((a, b) => (a.pnlUsd ?? 0) - (b.pnlUsd ?? 0)).slice(0, 3),
    };
  }).sort((a, b) => a.pnlUsd - b.pnlUsd);
  const desk = r2(traders.reduce((s, t) => s + t.pnlUsd, 0));
  return {
    shock,
    mode,
    positions: perPos,
    traders,
    desk: { pnlUsd: desk, breaches: traders.filter((t) => t.breach).map((t) => t.trader), worstTrader: traders[0]?.trader ?? null },
  };
}

export function customPctShock(pct: number): Shock {
  const p = Math.max(-95, Math.min(95, pct));
  return { key: `pct${p}`, label: `${p > 0 ? "+" : ""}${p}%`, kind: "pct", pct: p };
}

// ─── concentration ──────────────────────────────────────────────────────────

export type Bucket = { key: string; grossUsd: number; netUsd: number; longUsd: number; shortUsd: number; count: number; traders: string[]; pctOfGross: number };
export type SharedTicker = { ticker: string; traders: string[]; grossUsd: number; sides: ("long" | "short")[]; sameSide: boolean };
export type CorrelatedGroup = { sector: string; tickers: string[]; traders: string[]; longUsd: number; count: number; pctOfGross: number };
export type Concentration = {
  grossUsd: number;
  longUsd: number;
  shortUsd: number;
  netUsd: number;
  /** 0..100: share of the largest ticker in gross exposure. */
  topTickerPct: number;
  byTicker: Bucket[];
  bySector: Bucket[];
  bySide: { long: number; short: number; longPct: number };
  byTrader: Bucket[];
  sharedTickers: SharedTicker[];
  correlatedLongs: CorrelatedGroup[];
};

/** Bucket key of positions without a sector (display: risk «overnight.conc.noSector»). */
export const NO_SECTOR = "";

export function concentration(positions: BookPosition[], quotes: Record<string, BookQuote | undefined>, sectors: Record<string, string | null | undefined> = {}): Concentration {
  const rows = positions.map((p) => {
    const m = markPosition(p, quotes[p.ticker.toUpperCase()]);
    const mv = m.marketValueUsd ?? 0;
    const d = dir(p.side);
    const sector = p.sector ?? sectors[p.ticker.toUpperCase()] ?? null;
    return { p, mv, d, sector: sector && sector.trim() ? sector : NO_SECTOR };
  });
  const gross = r2(rows.reduce((s, x) => s + x.mv, 0));
  const longUsd = r2(rows.filter((x) => x.d > 0).reduce((s, x) => s + x.mv, 0));
  const shortUsd = r2(rows.filter((x) => x.d < 0).reduce((s, x) => s + x.mv, 0));
  const bucketize = (keyOf: (x: (typeof rows)[number]) => string): Bucket[] => {
    const m = new Map<string, Bucket>();
    for (const x of rows) {
      const k = keyOf(x);
      const b = m.get(k) ?? { key: k, grossUsd: 0, netUsd: 0, longUsd: 0, shortUsd: 0, count: 0, traders: [], pctOfGross: 0 };
      b.grossUsd = r2(b.grossUsd + x.mv);
      b.netUsd = r2(b.netUsd + x.d * x.mv);
      if (x.d > 0) b.longUsd = r2(b.longUsd + x.mv); else b.shortUsd = r2(b.shortUsd + x.mv);
      b.count++;
      if (!b.traders.includes(x.p.trader)) b.traders.push(x.p.trader);
      m.set(k, b);
    }
    return [...m.values()].map((b) => ({ ...b, pctOfGross: gross > 0 ? r2((b.grossUsd / gross) * 100) : 0 })).sort((a, b) => b.grossUsd - a.grossUsd);
  };
  const byTicker = bucketize((x) => x.p.ticker.toUpperCase());
  const bySector = bucketize((x) => x.sector);
  const byTrader = bucketize((x) => x.p.trader);
  const sharedTickers: SharedTicker[] = byTicker
    .filter((b) => b.traders.length >= 2)
    .map((b) => {
      const sides = rows.filter((x) => x.p.ticker.toUpperCase() === b.key).map((x) => (x.d > 0 ? "long" : "short") as "long" | "short");
      return { ticker: b.key, traders: b.traders, grossUsd: b.grossUsd, sides, sameSide: new Set(sides).size === 1 };
    });
  const correlatedLongs: CorrelatedGroup[] = bySector
    .map((b) => {
      const longs = rows.filter((x) => x.sector === b.key && x.d > 0);
      const tickers = [...new Set(longs.map((x) => x.p.ticker.toUpperCase()))];
      return {
        sector: b.key,
        tickers,
        traders: [...new Set(longs.map((x) => x.p.trader))],
        longUsd: r2(longs.reduce((s, x) => s + x.mv, 0)),
        count: longs.length,
        pctOfGross: gross > 0 ? r2((longs.reduce((s, x) => s + x.mv, 0) / gross) * 100) : 0,
      };
    })
    .filter((g) => g.count >= 2 && g.sector !== NO_SECTOR)
    .sort((a, b) => b.longUsd - a.longUsd);
  return {
    grossUsd: gross,
    longUsd,
    shortUsd,
    netUsd: r2(longUsd - shortUsd),
    topTickerPct: byTicker[0]?.pctOfGross ?? 0,
    byTicker,
    bySector,
    bySide: { long: longUsd, short: shortUsd, longPct: gross > 0 ? r2((longUsd / gross) * 100) : 0 },
    byTrader,
    sharedTickers,
    correlatedLongs,
  };
}

// ─── CSV ────────────────────────────────────────────────────────────────────

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(esc).join(";")).join("\r\n");
}

// ─── per-trader exposure (desk table) ───────────────────────────────────────

export type ExposurePosition = {
  ticker: string;
  trader: string;
  side: string | null;
  exposureUsd: number | null;
  carriedTonight?: boolean;
};

export type TraderExposure = {
  count: number;
  longUsd: number;
  shortUsd: number;
  grossUsd: number;
  netUsd: number;
  overnightCount: number;
  overnightUsd: number;
  /** Largest ticker by gross exposure (null when no $ exposure). */
  topTicker: string | null;
  /** 0..100 share of the top ticker in gross. */
  topTickerPct: number | null;
};

/** Long / short / gross $ (cost basis), overnight share and ticker concentration per trader. */
export function exposureByTrader(positions: ExposurePosition[]): Map<string, TraderExposure> {
  const out = new Map<string, TraderExposure>();
  const tick = new Map<string, Map<string, number>>();
  for (const p of positions) {
    const e: TraderExposure = out.get(p.trader) ?? {
      count: 0, longUsd: 0, shortUsd: 0, grossUsd: 0, netUsd: 0, overnightCount: 0, overnightUsd: 0, topTicker: null, topTickerPct: null,
    };
    const usd = Math.abs(p.exposureUsd ?? 0);
    e.count++;
    if (isShort(p.side)) e.shortUsd = r2(e.shortUsd + usd);
    else e.longUsd = r2(e.longUsd + usd);
    if (p.carriedTonight) {
      e.overnightCount++;
      e.overnightUsd = r2(e.overnightUsd + usd);
    }
    out.set(p.trader, e);
    const t = tick.get(p.trader) ?? new Map<string, number>();
    const k = p.ticker.toUpperCase();
    t.set(k, (t.get(k) ?? 0) + usd);
    tick.set(p.trader, t);
  }
  for (const [trader, e] of out) {
    e.grossUsd = r2(e.longUsd + e.shortUsd);
    e.netUsd = r2(e.longUsd - e.shortUsd);
    let best: [string, number] | null = null;
    for (const kv of tick.get(trader) ?? new Map<string, number>()) if (!best || kv[1] > best[1]) best = kv;
    if (best && best[1] > 0 && e.grossUsd > 0) {
      e.topTicker = best[0];
      e.topTickerPct = Math.round((best[1] / e.grossUsd) * 1000) / 10;
    }
  }
  return out;
}

// ─── desk ranking ───────────────────────────────────────────────────────────

export type RankLevel = "stop" | "near" | "ok" | "none";

export type RankInput = {
  halted: boolean;
  status: "ok" | "warn" | "breach" | "no_limits";
  stopState: string;
  dailyPct: number | null;
  weeklyPct: number | null;
  drawdownPct: number | null;
  /** Highest pct among the trader's alerts (positions, overnight…). */
  alertPct: number | null;
  todayPnl: number | null;
};

/** ok / near / stop as the desk sees it: halted or any breach ⇒ stop; warn ⇒ near; no limits ⇒ none. */
export function rankLevel(r: RankInput): RankLevel {
  if (r.halted || r.status === "breach") return "stop";
  if (r.status === "warn" || r.stopState === "warn") return "near";
  if (r.status === "no_limits") return "none";
  return "ok";
}

/** Worst usage of the trader's limits, in % (null when nothing is limited). */
export function worstUsage(r: Pick<RankInput, "dailyPct" | "weeklyPct" | "drawdownPct" | "alertPct">): number | null {
  const xs = [r.dailyPct, r.weeklyPct, r.drawdownPct, r.alertPct].filter((v): v is number => v != null && Number.isFinite(v));
  return xs.length ? Math.max(...xs) : null;
}

/** Sort score, higher = more urgent: stop > near > ok > no limits; inside a level by worst usage, then by today's loss. */
export function riskScore(r: RankInput): number {
  const base = { stop: 3000, near: 2000, ok: 1000, none: 0 }[rankLevel(r)];
  const usage = Math.min(999, worstUsage(r) ?? 0);
  const loss = Math.min(0.99, Math.max(0, -(r.todayPnl ?? 0)) / 1e6);
  return base + usage + loss;
}

// ─── intraday equity curve ──────────────────────────────────────────────────

export type DayTrade = {
  id: number;
  ticker: string;
  side: string | null;
  qty: number | null;
  /** Net P&L (gross − |fees|), null when unknown. */
  net: number | null;
  /** NY wall-clock minutes since midnight of the close / open (null when unknown). */
  closeMin: number | null;
  openMin: number | null;
};

export type CurvePoint = { min: number; cum: number; tradeId: number | null; ticker: string | null; net: number | null };

/** "2026-10-15T16:00:01" (NY wall clock) → 960. Accepts "HH:MM" too. */
export function wallMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /(?:T|\s|^)(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h >= 0 && h < 24 && mi >= 0 && mi < 60 ? h * 60 + mi : null;
}

/**
 * Cumulative net P&L through the day by close time. Starts at 0 at the first open (or 9:30 ET).
 * Trades without a time keep their id order and go one minute after the previous point.
 */
export function intradayCurve(trades: DayTrade[]): { points: CurvePoint[]; low: number; high: number; final: number; timed: boolean } {
  const withNet = trades.filter((t) => t.net != null);
  const timed = withNet.length > 0 && withNet.every((t) => t.closeMin != null);
  const sorted = [...withNet].sort((a, b) => (a.closeMin ?? Infinity) - (b.closeMin ?? Infinity) || a.id - b.id);
  const starts = [570, ...withNet.map((t) => t.openMin).filter((v): v is number => v != null), ...sorted.map((t) => t.closeMin).filter((v): v is number => v != null)];
  const start = Math.min(...starts);
  const points: CurvePoint[] = [{ min: start, cum: 0, tradeId: null, ticker: null, net: null }];
  let cum = 0;
  let low = 0;
  let high = 0;
  let lastMin = start;
  for (const t of sorted) {
    cum = r2(cum + (t.net ?? 0));
    const min = t.closeMin ?? lastMin + 1;
    lastMin = Math.max(lastMin, min);
    points.push({ min, cum, tradeId: t.id, ticker: t.ticker, net: t.net });
    low = Math.min(low, cum);
    high = Math.max(high, cum);
  }
  return { points, low, high, final: cum, timed };
}

// ─── limit breach history (retro, against the current limits) ───────────────

export type DailyPoint = { date: string; pnl: number | null; drawdown: number };
export type BreachLimits = { dailyLossLimit: number | null; weeklyLossLimit: number | null; maxDrawdown: number | null } | null;
export type RetroBreach = { date: string; kind: "daily" | "weekly" | "drawdown"; level: "breach" | "warn"; used: number; limit: number; pct: number };

export function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().slice(0, 10);
}

/**
 * Days / weeks / drawdown episodes that hit the trader's CURRENT limits (≥100% breach, ≥warnPct warn).
 * Daily: every day. Weekly: one record per week, dated the first day the running weekly loss reached its
 * strongest level. Drawdown: one record per episode (an episode ends when equity is back at its peak).
 * Newest first; breach before warn on the same day.
 */
export function breachHistory(points: DailyPoint[], limits: BreachLimits, warnPct = 70): RetroBreach[] {
  if (!limits) return [];
  const out: RetroBreach[] = [];
  const pct = (used: number, limit: number) => Math.round((used / limit) * 1000) / 10;
  const level = (p: number): "breach" | "warn" | null => (p >= 100 ? "breach" : p >= warnPct ? "warn" : null);
  const stronger = (a: "breach" | "warn" | null, b: "breach" | "warn") => a == null || (a === "warn" && b === "breach");

  const D = limits.dailyLossLimit;
  if (D != null && D > 0) {
    for (const p of points) {
      if (p.pnl == null || p.pnl >= 0) continue;
      const used = -p.pnl;
      const lv = level(pct(used, D));
      if (lv) out.push({ date: p.date, kind: "daily", level: lv, used: r2(used), limit: D, pct: pct(used, D) });
    }
  }

  const W = limits.weeklyLossLimit;
  if (W != null && W > 0) {
    const byWeek = new Map<string, RetroBreach>();
    const run = new Map<string, number>();
    for (const p of points) {
      const wk = mondayOf(p.date);
      const total = (run.get(wk) ?? 0) + (p.pnl ?? 0);
      run.set(wk, total);
      const used = Math.max(0, -total);
      const lv = level(pct(used, W));
      if (lv && stronger(byWeek.get(wk)?.level ?? null, lv)) {
        byWeek.set(wk, { date: p.date, kind: "weekly", level: lv, used: r2(used), limit: W, pct: pct(used, W) });
      }
    }
    out.push(...byWeek.values());
  }

  const M = limits.maxDrawdown;
  if (M != null && M > 0) {
    let episode: "breach" | "warn" | null = null;
    for (const p of points) {
      const used = Math.max(0, -p.drawdown);
      if (used === 0) { episode = null; continue; }
      const lv = level(pct(used, M));
      if (lv && stronger(episode, lv)) {
        episode = lv;
        out.push({ date: p.date, kind: "drawdown", level: lv, used: r2(used), limit: M, pct: pct(used, M) });
      }
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || (a.level === b.level ? 0 : a.level === "breach" ? -1 : 1));
}
