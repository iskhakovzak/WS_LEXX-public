// Server mirror of edge-tracker/src/lib/trade-math.ts: one definition of R, net P&L and result
// buckets for every aggregate. SQL fragments assume the trades table is aliased as `t`
// (pass another alias to the *Sql() builders when needed).

const WIN = `('win','прибыль','профит')`; // i18n-ignore (legacy stored result values)
const LOSS = `('loss','убыток','лосс')`; // i18n-ignore (legacy stored result values)
const BE = `('be','breakeven','безубыток','бу')`; // i18n-ignore (legacy stored result values)

// LOWER() only folds ASCII under the "C" collation (the local DB is created that way), so the Cyrillic
// aliases are folded explicitly — every upper-case letter that occurs in WIN/LOSS/BE.
const res = (a: string) => `TRANSLATE(LOWER(TRIM(${a}.result)), 'ПРИБЫЛЬОФТУКСЕЗ', 'прибыльофтуксез')`; // i18n-ignore (case folding of legacy values)

/** 'win' | 'loss' | 'be' | 'open' | NULL — canonical result. */
export function resultSql(a = "t"): string {
  return `(CASE WHEN ${res(a)} IN ${WIN} THEN 'win' WHEN ${res(a)} IN ${LOSS} THEN 'loss' WHEN ${res(a)} IN ${BE} THEN 'be' WHEN ${res(a)} = 'open' THEN 'open' ELSE NULL END)`;
}

/** TRUE for win/loss (win-rate denominator; break-even excluded). Always a real boolean (NULL result ⇒ FALSE). */
export function decidedSql(a = "t"): string {
  return `COALESCE(${res(a)} IN ${WIN} OR ${res(a)} IN ${LOSS}, FALSE)`;
}

/** TRUE for any closed trade (win/loss/be). Always a real boolean (NULL result ⇒ FALSE). */
export function closedSql(a = "t"): string {
  return `COALESCE(${res(a)} IN ${WIN} OR ${res(a)} IN ${LOSS} OR ${res(a)} IN ${BE}, FALSE)`;
}

/** Net P&L = gross pnl − |fees|; NULL when pnl is NULL. */
export function netPnlSql(a = "t"): string {
  return `(${a}.pnl - ABS(COALESCE(${a}.fees, 0)))`;
}

/** Day the result is realised (exit date for multi-day holds). */
export function closeDateSql(a = "t"): string {
  return `COALESCE(NULLIF(${a}.exit_date, ''), ${a}.date)`;
}

/** 'intraday' | 'overnight' | 'swing' (NULL ⇒ intraday). */
export function horizonSql(a = "t"): string {
  return `COALESCE(NULLIF(${a}.horizon, ''), 'intraday')`;
}

/**
 * Signed R, same rule as the client:
 * stored r_multiple with sign from result → price-derived (side-aware) → pnl / risk_usd. BE ⇒ 0, open ⇒ NULL. Clamped ±20.
 */
export function signedRSql(a = "t"): string {
  const short = `LOWER(TRIM(COALESCE(${a}.side, ''))) LIKE 's%'`;
  const priceR = `(CASE WHEN ${a}.entry IS NOT NULL AND ${a}.exit IS NOT NULL AND ${a}.stop IS NOT NULL AND ${a}.entry <> ${a}.stop
      THEN (CASE WHEN ${short} THEN ${a}.entry - ${a}.exit ELSE ${a}.exit - ${a}.entry END) / ABS(${a}.entry - ${a}.stop) END)`;
  const raw = `(CASE
      WHEN ${res(a)} = 'open' THEN NULL
      WHEN ${res(a)} IN ${BE} THEN 0
      WHEN ${a}.r_multiple IS NOT NULL AND ${res(a)} IN ${WIN} THEN ABS(${a}.r_multiple)
      WHEN ${a}.r_multiple IS NOT NULL AND ${res(a)} IN ${LOSS} THEN -ABS(${a}.r_multiple)
      WHEN ${a}.r_multiple IS NOT NULL THEN ${a}.r_multiple
      WHEN ${priceR} IS NOT NULL THEN ${priceR}
      WHEN ${a}.pnl IS NOT NULL AND ${a}.risk_usd > 0 THEN ${a}.pnl / ${a}.risk_usd
    END)`;
  // GREATEST/LEAST skip NULLs in Postgres (LEAST(20, NULL) = 20), so guard the open/unknown case explicitly.
  return `(CASE WHEN ${raw} IS NULL THEN NULL ELSE GREATEST(-20, LEAST(20, ${raw})) END)`;
}

// JS versions for rows already in memory.

export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "string" && v.trim() === "") return null; // Number("  ") === 0 — a blank cell is not a zero
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normResult(r: unknown): "win" | "loss" | "be" | "open" | null {
  const s = String(r ?? "").trim().toLowerCase();
  if (["win", "прибыль", "профит"].includes(s)) return "win"; // i18n-ignore (legacy stored result values)
  if (["loss", "убыток", "лосс"].includes(s)) return "loss"; // i18n-ignore (legacy stored result values)
  if (["be", "breakeven", "безубыток", "бу"].includes(s)) return "be"; // i18n-ignore (legacy stored result values)
  if (s === "open") return "open";
  return null;
}

export interface TradeRowLike {
  result?: unknown; side?: unknown; entry?: unknown; exit?: unknown; stop?: unknown;
  r_multiple?: unknown; rMultiple?: unknown; pnl?: unknown; fees?: unknown; risk_usd?: unknown; riskUsd?: unknown;
}

export function signedR(t: TradeRowLike): number | null {
  const r = normResult(t.result);
  if (r === "open") return null;
  if (r === "be") return 0;
  const clamp = (x: number) => Math.max(-20, Math.min(20, x));
  const stored = num(t.rMultiple ?? t.r_multiple);
  if (stored != null) {
    if (r === "win") return clamp(Math.abs(stored));
    if (r === "loss") return clamp(-Math.abs(stored));
    return clamp(stored);
  }
  const entry = num(t.entry), exit = num(t.exit), stop = num(t.stop);
  if (entry != null && exit != null && stop != null && entry !== stop) {
    const short = String(t.side ?? "").trim().toLowerCase().startsWith("s");
    return clamp((short ? entry - exit : exit - entry) / Math.abs(entry - stop));
  }
  const pnl = num(t.pnl), risk = num(t.riskUsd ?? t.risk_usd);
  if (pnl != null && risk != null && risk > 0) return clamp(pnl / risk);
  return null;
}

export function netPnl(t: TradeRowLike): number | null {
  const g = num(t.pnl);
  return g == null ? null : g - Math.abs(num(t.fees) ?? 0);
}
