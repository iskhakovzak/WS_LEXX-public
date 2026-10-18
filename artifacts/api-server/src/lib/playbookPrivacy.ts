/**
 * Playbook privacy — who may see the dollar facts of a trade shown inside a setup (examples, gallery, linked
 * trades, $-stats). Pure functions only (unit-tested in __tests__/playbookPrivacy.test.ts); the request-level
 * viewer comes from loadMoneyViewer() in playbookAccess.ts.
 *
 * Rule: a viewer sees the $ facts of a trade only when
 *   - they own it (trades.trader = viewer name), or
 *   - they are staff (role curator / admin).
 * Everyone else gets those fields as null plus `redacted: true`. What stays: ticker, dates, side, entry/exit times,
 * prices (the chart needs them), R, tier, note, checklist marks, media, trader / who added it.
 *
 * Aggregates over several traders' trades keep counts, win rate and R; their $ fields are null unless every
 * included trade is the viewer's own (or the viewer is staff).
 *
 * The trades API (routes/trades.ts, routes/executions.ts) applies the same rule — see the section near the end.
 */

export interface MoneyViewer {
  /** Viewer's user name; null for anonymous / guest (never owns a trade). */
  name: string | null;
  /** Curator or admin. */
  staff: boolean;
}

/** $ fields of a trade row as returned by the playbook routes (absent keys are left alone). */
export const TRADE_MONEY_FIELDS = [
  "netPnl", "pnl", "grossPnl", "fees", "commission", "qty", "riskUsd", "slippage",
  "positionUsd", "positionSize", "notional", "notionalUsd", "mfeUsd", "maeUsd", "totalPnl",
] as const;

/** $ fields of a UsdStats block (lib/playbookEdge.computeUsdStats). n / wins / losses / winrate stay. */
export const USD_STATS_MONEY_FIELDS = ["net", "expectancy", "avgWin", "avgLoss", "payoff", "profitFactor", "best", "worst"] as const;

/** $ fields of an EdgeStats block (lib/playbookEdge.computeEdge). R-based fields and counts stay. */
export const EDGE_MONEY_FIELDS = ["maxDrawdown", "totalPnl", "totalPnlGross", "fees"] as const;

/** $ fields of a time-slot row (lib/playbookEdge.slotStats). */
export const SLOT_MONEY_FIELDS = ["net", "expectancy"] as const;

/** $ fields of a GET /playbook/summary row (byHorizon.*.netPnl is handled by redactSummaryRow). */
export const SUMMARY_MONEY_FIELDS = [
  "netPnl", "grossPnl", "totalPnl", "expectancyUsd", "avgWinUsd", "avgLossUsd", "profitFactorUsd",
] as const;

/** Copy of `obj` with every listed key that is present set to null. */
export function nullFields<T extends object>(obj: T, keys: readonly string[]): T {
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const k of keys) if (k in out) out[k] = null;
  return out as T;
}

export function isOwnTrade(v: MoneyViewer, trader: string | null | undefined): boolean {
  return !!v.name && !!trader && trader === v.name;
}

/** May the viewer see the $ facts of a trade owned by `trader`? */
export function canSeeTradeMoney(v: MoneyViewer, trader: string | null | undefined): boolean {
  return v.staff || isOwnTrade(v, trader);
}

/** Are all of these trades the viewer's own (or is the viewer staff)? An empty set is trivially visible. */
export function canSeeAggregateMoney(v: MoneyViewer, traders: Iterable<string | null | undefined>): boolean {
  if (v.staff) return true;
  for (const t of traders) if (!isOwnTrade(v, t)) return false;
  return true;
}

export type Redacted<T> = T & { redacted: boolean };

/**
 * One trade-shaped row (example, gallery card, linked trade, picker row). `trader` is the owner of the trade.
 * Visible rows get `redacted: false`, others have every $ field nulled and `redacted: true`.
 */
export function redactTradeRow<T extends { trader?: string | null }>(row: T, v: MoneyViewer): Redacted<T> {
  if (canSeeTradeMoney(v, row.trader)) return { ...row, redacted: false };
  return { ...nullFields(row, TRADE_MONEY_FIELDS), redacted: true };
}

export function redactTradeRows<T extends { trader?: string | null }>(rows: T[], v: MoneyViewer): Redacted<T>[] {
  return rows.map((r) => redactTradeRow(r, v));
}

export function redactUsdStats<T extends object>(s: T): T {
  return nullFields(s, USD_STATS_MONEY_FIELDS);
}

export function redactEdgeStats<T extends object>(e: T): T {
  return nullFields(e, EDGE_MONEY_FIELDS);
}

export function redactSlot<T extends object>(s: T): T {
  return nullFields(s, SLOT_MONEY_FIELDS);
}

/** A GET /playbook/summary row: top-level $ fields and byHorizon.*.netPnl. */
export function redactSummaryRow<T extends { byHorizon?: Record<string, object> }>(row: T): Redacted<T> {
  const out = nullFields(row, SUMMARY_MONEY_FIELDS);
  if (row.byHorizon) {
    out.byHorizon = Object.fromEntries(
      Object.entries(row.byHorizon).map(([k, h]) => [k, nullFields(h, ["netPnl"])]),
    ) as T["byHorizon"];
  }
  return { ...out, redacted: true };
}

// ─── Trades API (/trades, /trades/:id, /trades/page, /trades/days, executions) ──────────────────────────────
// Same rule outside the playbook: a non-staff viewer never gets the $ of another trader's trade, whatever the
// permission matrix lets them read (a "team.read" / "trades.read.team" grant widens WHICH trades, not WHAT).

/** $ fields of a GET /trades/page summary. Counts, win rate, R and dates stay. */
export const BOOK_SUMMARY_MONEY_FIELDS = [
  "gross", "fees", "net", "avgWinNet", "avgLossNet", "posNet", "negNet", "profitFactorNet", "maxNet", "minNet",
] as const;

/** $ fields of a GET /trades/days row (`seq` = per-trade net, emptied separately). */
export const BOOK_DAY_MONEY_FIELDS = ["gross", "fees", "net", "maxNet", "minNet"] as const;

/** $ fields of an execution (fill) row. Price and time stay — the chart draws the fills. */
export const EXECUTION_MONEY_FIELDS = ["qty"] as const;

/**
 * May the viewer see the $ of a book scoped to `scope` (lib/auth scopeTrader: a trader name, or null = whole desk)?
 * Only staff see a multi-trader book; everyone else only their own.
 */
export function canSeeBookMoney(v: MoneyViewer, scope: string | null): boolean {
  return v.staff || (scope != null && isOwnTrade(v, scope));
}

/** A /trades/page summary block with its $ nulled and `redacted: true`. */
export function redactBookSummary<T extends object>(s: T): Redacted<T> {
  return { ...nullFields(s, BOOK_SUMMARY_MONEY_FIELDS), redacted: true };
}

/** A /trades/days row with its $ nulled, the $ sequence emptied and `redacted: true`. */
export function redactBookDay<T extends { seq?: unknown[] }>(d: T): Redacted<T> {
  const out = nullFields(d, BOOK_DAY_MONEY_FIELDS);
  if ("seq" in out) out.seq = [] as unknown[] as T["seq"];
  return { ...out, redacted: true };
}

/**
 * «fees 1.23» inside an execution note — PropReports sync writes «PropReports B #123 · fees 0.42», and the client
 * (ExecutionsPanel feesFromNote) reads the same pattern back.
 */
const NOTE_FEES_RE = /\s*·?\s*\bfees?\s*[:=]?\s*\$?-?\d+(?:[.,]\d+)?/gi;

/** Executions of a trade owned by `trader`: qty nulled and fee amounts cut from notes for viewers who may not see its $. */
export function redactExecutions<T extends { note?: string | null }>(rows: T[], v: MoneyViewer, trader: string | null | undefined): T[] {
  if (canSeeTradeMoney(v, trader)) return rows;
  return rows.map((r) => {
    const out = nullFields(r, EXECUTION_MONEY_FIELDS);
    if (typeof out.note === "string") out.note = out.note.replace(NOTE_FEES_RE, "").trim() || null;
    return out;
  });
}

/** $ / size fields of a trade-structure leg (lib/tradeStructure). Role, price, time, fraction of max size and R stay. */
export const STRUCTURE_LEG_MONEY_FIELDS = ["qty", "positionBefore", "positionAfter", "realized"] as const;
/** $ / size fields of trade-structure stats. */
export const STRUCTURE_STATS_MONEY_FIELDS = ["maxPosition", "openQty", "realized"] as const;

/** A trade structure ({ legs, stats }) with share counts and $ nulled for viewers who may not see the trade's $. */
export function redactStructure<T extends { legs: object[]; stats: object }>(s: T, v: MoneyViewer, trader: string | null | undefined): T {
  if (canSeeTradeMoney(v, trader)) return s;
  return { ...s, legs: s.legs.map((l) => nullFields(l, STRUCTURE_LEG_MONEY_FIELDS)), stats: nullFields(s.stats, STRUCTURE_STATS_MONEY_FIELDS) };
}

/** Cumulative signed R by close day — the $-free equity curve shown when the $ curve is hidden. */
export function equityByR(trades: { closeDate: string; r: number | null }[]): { day: string; r: number; cum: number }[] {
  const byDay = new Map<string, number>();
  for (const t of trades) {
    if (t.r == null || !Number.isFinite(t.r) || !t.closeDate) continue;
    byDay.set(t.closeDate, (byDay.get(t.closeDate) ?? 0) + t.r);
  }
  let cum = 0;
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, r]) => ({ day, r: Number(r.toFixed(3)), cum: Number((cum += r).toFixed(3)) }));
}
