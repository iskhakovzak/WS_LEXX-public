/**
 * «Сверка с брокером» — pure reconciliation engine (no I/O). The route (routes/reconcile.ts) loads rows and calls
 * `reconcile()`; the vitest suite (lib/__tests__/reconcile.test.ts) feeds synthetic arrays.
 *
 * What is compared
 *  1. Per trading day (NY close date = COALESCE(exit_date, date), the same bucket as dashboard / propreports/daily):
 *     journal numbers of broker-sourced trades (trades.pnl / |trades.fees|) vs the broker snapshot stored on the
 *     trade at import (context_snapshot.gross / totalFees / net), plus broker by-day totals when supplied (`brokerDays`).
 *     Manual trades are summed separately — they are not in the broker's books.
 *  2. Per broker "Trade Performance" report (aggregate, no days): trades / wins / losses / gross / fees / net,
 *     fees by type (per-trade average × count), by side, by weekday and by symbol, over the report period and account.
 *  3. Per trade: snapshot consistency, fee sign, result vs net sign, executions (entry + exit present, exit ≥ entry,
 *     qty agrees, avg prices, gross from fills), duplicates (external id; ticker + open time + qty; manual twin of a
 *     broker trade).
 *
 * Money math follows lib/tradeMath: gross = pnl, net = pnl − |fees| (netPnl). Status per comparison:
 *   ok   |diff| ≤ tolerance ($0.01; for sums over N broker-rounded rows: the rounding band 0.005·√N, never < $0.01)
 *   warn |diff| < $1
 *   error otherwise (and every count mismatch / missing data).
 */
import { netPnl, normResult, num } from "./tradeMath";
import { reconcileT } from "../i18n/ns";
import type { Lang } from "../i18n";

export type Severity = "ok" | "warn" | "error";
export type CompareStatus = Severity | "na";
export type TradeSource = "propreports" | "manual";

export interface BrokerSnapshot {
  gross: number | null;
  net: number | null;
  totalFees: number | null;
  feesByType: Record<string, number> | null;
  qty: number | null;
  avgEntry: number | null;
  avgExit: number | null;
  /** Naive ET "YYYY-MM-DDTHH:MM:SS" as PropReports exports it. */
  openedAt: string | null;
  closedAt: string | null;
  openQty: number | null;
  fromReport: boolean;
}

export interface RecTrade {
  id: number;
  trader: string | null;
  ticker: string;
  /** NY trade (open) date YYYY-MM-DD. */
  date: string;
  exitDate: string | null;
  side: string | null;
  qty: number | null;
  entry: number | null;
  exit: number | null;
  /** Gross P&L. */
  pnl: number | null;
  fees: number | null;
  result: string | null;
  source: TradeSource;
  externalId: string | null;
  account: string | null;
  broker: BrokerSnapshot | null;
}

export interface RecExecution {
  id: number;
  tradeId: number;
  kind: string; // entry | add | trim | exit
  price: number | null;
  qty: number | null;
  /** ISO timestamp (timestamptz). */
  executedAt: string | null;
}

export interface Money { trades: number; gross: number; fees: number; net: number }
export interface MoneyWL extends Money { wins: number; losses: number }

export interface RecReport {
  id: number;
  account: string | null;
  trader: string | null;
  periodFrom: string;
  periodTo: string;
  totals: MoneyWL;
  /** Per-trade average fee by type (4 decimals in the stored report); × trades = estimated total. */
  feeAverages: Record<string, number> | null;
  bySide: Partial<Record<"long" | "short", MoneyWL>>;
  /** keys: monday … friday (lower case). */
  byWeekday: Record<string, MoneyWL>;
  /** keys: upper-case symbol. */
  bySymbol: Record<string, MoneyWL>;
}

/** Optional broker per-day totals (e.g. the "Equities" subtotal rows of a Trades report). */
export interface BrokerDay { date: string; account?: string | null; trades: number; gross: number; fees: number; net: number }

export interface ReconcileOptions {
  from?: string | null;
  to?: string | null;
  /** $ tolerance for "сходится" (default 0.01). */
  tolerance?: number;
  /** below this |diff| a mismatch is a warning, above — serious (default 1). */
  warnBelow?: number;
  /** issues list cap (summary counts stay exact). */
  maxIssues?: number;
  /** language of labels / messages / hints (default ru). */
  lang?: Lang;
}

export interface Compare {
  key: string;
  label: string;
  journal: number | null;
  broker: number | null;
  diff: number | null;
  tolerance: number;
  status: CompareStatus;
  note?: string;
  /** Known cause: "fee_rounding" when the gap is ≤ $0.01 × trades (PropReports import rounds fees per trade). */
  cause?: DiscrepancyCause;
}

export type IssueKind =
  | "total_mismatch" | "day_mismatch" | "group_mismatch" | "fee_type_mismatch"
  | "day_missing_in_journal" | "day_missing_at_broker" | "symbol_missing_in_journal" | "symbol_missing_in_report"
  | "no_snapshot" | "gross_edited" | "fees_edited" | "net_inconsistent" | "fee_breakdown_mismatch" | "negative_fees"
  | "result_sign" | "qty_mismatch"
  | "no_fills" | "no_entry" | "no_exit" | "exit_before_entry" | "fill_qty_mismatch" | "fill_price_mismatch" | "fill_gross_mismatch"
  | "duplicate_external_id" | "duplicate_fill_key" | "manual_twin"
  | "manual_in_broker_period";

export interface Issue {
  id: string;
  severity: Severity;
  kind: IssueKind;
  date: string | null;
  ticker: string | null;
  trader: string | null;
  tradeIds: number[];
  message: string;
  expected?: number | null;
  actual?: number | null;
  diff?: number | null;
  hint?: string;
  cause?: DiscrepancyCause;
}

export type DiscrepancyCause = "fee_rounding";
/** RU label (kept for older imports / tests); the engine renders it in `opts.lang`. */
export const FEE_ROUNDING_LABEL = reconcileT.tFor("ru")("rounding.label");

/**
 * Diagnostic: a non-zero money gap that fits in $0.01 per trade is explained by per-trade fee rounding on import.
 * Only for fees/net (gross is not affected by fee rounding).
 */
export function feeRoundingCause(key: string, diff: number | null, trades: number): DiscrepancyCause | undefined {
  if (diff == null || trades <= 0 || (key !== "fees" && key !== "net")) return undefined;
  const a = Math.abs(diff);
  return a > 1e-9 && a <= 0.01 * trades + 1e-9 ? "fee_rounding" : undefined;
}

function tagRounding(c: Compare, trades: number): Compare {
  if (c.status !== "warn" && c.status !== "error") return c;
  const cause = feeRoundingCause(c.key, c.diff, trades);
  return cause ? { ...c, cause, note: FEE_ROUNDING_LABEL } : c;
}

export interface DayRow {
  date: string;
  status: Severity;
  journal: MoneyWL;
  manual: Money;
  broker: Money | null;
  brokerSource: "snapshot" | "report-days" | null;
  compares: Compare[];
  issueIds: string[];
  tradeIds: number[];
  fills: { withFills: number; withoutFills: number };
}

export interface GroupCheck {
  scope: "side" | "weekday" | "symbol";
  key: string;
  label: string;
  status: Severity;
  journal: MoneyWL;
  broker: MoneyWL;
  diffNet: number;
  cause?: DiscrepancyCause;
}

export interface ReportCheck {
  reportId: number;
  account: string | null;
  trader: string | null;
  periodFrom: string;
  periodTo: string;
  status: Severity;
  compares: Compare[];
  feeTypes: Compare[];
  groups: GroupCheck[];
  symbolsMissingInJournal: string[];
  symbolsMissingInReport: string[];
  manualInPeriod: Money;
}

export interface ReconcileResult {
  summary: {
    status: Severity;
    label: string;
    discrepancies: number;
    counts: Record<Severity, number>;
    period: { from: string | null; to: string | null };
    tolerance: number;
    warnBelow: number;
    journal: MoneyWL & { feesByType: Record<string, number> };
    manual: Money;
    days: number;
    daysWithIssues: number;
    tradesChecked: number;
    fills: { withFills: number; withoutFills: number; brokerWithoutFills: number };
    hasReport: boolean;
    hasBrokerDays: boolean;
    /** warn/error issues explained by per-trade fee rounding on import (known cause). */
    roundingIssues: number;
  };
  days: DayRow[];
  reports: ReportCheck[];
  issues: Issue[];
  issuesTruncated: boolean;
}

/* ─── helpers ──────────────────────────────────────────────────────────── */

export const r2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const RANK: Record<Severity, number> = { ok: 0, warn: 1, error: 2 };
export function worst(...s: Array<Severity | CompareStatus | null | undefined>): Severity {
  let w: Severity = "ok";
  for (const x of s) if (x && x !== "na" && RANK[x] > RANK[w]) w = x;
  return w;
}

/** Rounding band for a sum of `n` values each rounded to cents by the broker (≈1.7σ of the summed error). */
export function roundingTolerance(n: number, base = 0.01): number {
  return Math.max(base, r2(0.005 * Math.sqrt(Math.max(0, n))));
}

/** ≈3σ rounding band for one of many group sums (symbols / weekdays / sides). */
export function groupTolerance(n: number, base = 0.01): number {
  return Math.max(base, r2(0.009 * Math.sqrt(Math.max(0, n))));
}

/** ok / warn / error for a money diff. */
export function classify(diff: number | null, tolerance: number, warnBelow = 1): CompareStatus {
  if (diff == null || !Number.isFinite(diff)) return "na";
  const a = Math.abs(diff);
  if (a <= tolerance + 1e-9) return "ok";
  return a < warnBelow ? "warn" : "error";
}

export function compareMoney(key: string, label: string, journal: number | null, broker: number | null, tolerance: number, warnBelow = 1, lang: Lang = "ru"): Compare {
  if (journal == null || broker == null) return { key, label, journal, broker, diff: null, tolerance, status: "na" };
  const diff = r4(journal - broker);
  const status = classify(diff, tolerance, warnBelow);
  const c: Compare = { key, label, journal: r2(journal), broker: r2(broker), diff: r2(diff), tolerance, status };
  if (status === "ok" && Math.abs(diff) > 0.01 + 1e-9) c.note = reconcileT.tFor(lang)("rounding.note");
  return c;
}

export function compareCount(key: string, label: string, journal: number, broker: number | null): Compare {
  if (broker == null) return { key, label, journal, broker, diff: null, tolerance: 0, status: "na" };
  const diff = journal - broker;
  return { key, label, journal, broker, diff, tolerance: 0, status: diff === 0 ? "ok" : "error" };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** Short weekday label in `lang` (weekday codes from weekdayOf). */
export function weekdayLabel(code: string, lang: Lang = "ru"): string {
  return reconcileT.tryFor(lang, `weekday.${code}`) ?? code;
}
export const WEEKDAY_RU: Record<string, string> = Object.fromEntries(WEEKDAYS.map((w) => [w, weekdayLabel(w, "ru")]));
export function weekdayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function closeDate(t: Pick<RecTrade, "date" | "exitDate">): string {
  return t.exitDate && t.exitDate.trim() ? t.exitDate : t.date;
}

function sideKey(side: string | null): "long" | "short" | null {
  const s = String(side ?? "").trim().toLowerCase();
  if (!s) return null;
  return s.startsWith("s") ? "short" : "long";
}

const isOpenTrade = (t: RecTrade): boolean => normResult(t.result) === "open" || (t.broker?.openQty ?? 0) > 0;

function emptyMoney(): Money { return { trades: 0, gross: 0, fees: 0, net: 0 }; }
function emptyWL(): MoneyWL { return { trades: 0, gross: 0, fees: 0, net: 0, wins: 0, losses: 0 }; }

/** Adds a closed trade with P&L to an accumulator (lib/tradeMath netPnl). Open trades / no P&L count only in `trades`. */
function addTrade(acc: MoneyWL | Money, t: RecTrade): void {
  acc.trades += 1;
  if (isOpenTrade(t) || t.pnl == null) return;
  acc.gross += t.pnl;
  acc.fees += Math.abs(t.fees ?? 0);
  acc.net += netPnl(t) ?? 0;
  if ("wins" in acc) {
    const r = normResult(t.result);
    if (r === "win") acc.wins += 1;
    else if (r === "loss") acc.losses += 1;
  }
}

function roundMoney<T extends Money>(m: T): T {
  return { ...m, gross: r2(m.gross), fees: r2(m.fees), net: r2(m.net) };
}

const fmt = (v: number | null | undefined): string => (v == null ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`);

/** Second-resolution key of a naive ET or ISO timestamp. */
function timeKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(s);
  return m ? `${m[1]}T${m[2]}` : null;
}

/* ─── engine ───────────────────────────────────────────────────────────── */

export function reconcile(
  tradesIn: RecTrade[],
  executions: RecExecution[],
  reports: RecReport[] = [],
  opts: ReconcileOptions = {},
  brokerDays: BrokerDay[] = [],
): ReconcileResult {
  const tol = opts.tolerance ?? 0.01;
  const warnBelow = opts.warnBelow ?? 1;
  const from = opts.from ?? null;
  const to = opts.to ?? null;
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  const lang: Lang = opts.lang ?? "ru";
  const tx = reconcileT.tFor(lang);
  const ROUND_LABEL = tx("rounding.label");
  const ROUND_HINT = tx("rounding.hint");
  const nTrades = (count: number) => tx("trades", { count });

  const issues: Issue[] = [];
  let seq = 0;
  const push = (i: Omit<Issue, "id">): Issue => {
    const full = { id: `i${++seq}`, ...i };
    issues.push(full);
    return full;
  };

  const execByTrade = new Map<number, RecExecution[]>();
  for (const e of executions) {
    const list = execByTrade.get(e.tradeId) ?? [];
    list.push(e);
    execByTrade.set(e.tradeId, list);
  }

  const trades = tradesIn.filter((t) => inRange(closeDate(t)));

  /* ── per-trade checks ── */
  let withFills = 0, withoutFills = 0, brokerWithoutFills = 0;
  const feesByType: Record<string, number> = {};
  for (const t of trades) {
    const day = closeDate(t);
    const base = { date: day, ticker: t.ticker, trader: t.trader, tradeIds: [t.id] };
    const b = t.broker;
    const open = isOpenTrade(t);

    if (t.fees != null && t.fees < 0) {
      push({ ...base, severity: "warn", kind: "negative_fees", message: tx("issue.negativeFees", { fees: fmt(t.fees) }), actual: t.fees });
    }

    if (t.source === "propreports") {
      if (!b) {
        push({ ...base, severity: "warn", kind: "no_snapshot", message: tx("issue.noSnapshot") });
      } else {
        if (b.feesByType) for (const [k, v] of Object.entries(b.feesByType)) feesByType[k] = (feesByType[k] ?? 0) + (num(v) ?? 0);
        if (!open && t.pnl != null && b.gross != null) {
          const st = classify(t.pnl - b.gross, tol, warnBelow);
          if (st !== "ok" && st !== "na") push({ ...base, severity: st, kind: "gross_edited", message: tx("issue.grossEdited", { journal: fmt(t.pnl), broker: fmt(b.gross) }), expected: r2(b.gross), actual: r2(t.pnl), diff: r2(t.pnl - b.gross) });
        }
        if (!open && b.totalFees != null) {
          const jf = Math.abs(t.fees ?? 0);
          const st = classify(jf - Math.abs(b.totalFees), tol, warnBelow);
          if (st !== "ok" && st !== "na") push({ ...base, severity: st, kind: "fees_edited", message: tx("issue.feesEdited", { journal: fmt(jf), broker: fmt(Math.abs(b.totalFees)) }), expected: r2(Math.abs(b.totalFees)), actual: r2(jf), diff: r2(jf - Math.abs(b.totalFees)) });
        }
        if (!open && b.gross != null && b.net != null && b.totalFees != null) {
          const d = b.net - (b.gross - b.totalFees);
          const st = classify(d, tol, warnBelow);
          if (st !== "ok" && st !== "na") push({ ...base, severity: st, kind: "net_inconsistent", message: tx("issue.netInconsistent", { net: fmt(b.net), gross: fmt(b.gross), fees: fmt(b.totalFees) }), diff: r2(d) });
        }
        if (b.feesByType && b.totalFees != null) {
          const vals = Object.values(b.feesByType).map((v) => num(v) ?? 0);
          const sum = vals.reduce((s, v) => s + v, 0);
          const cols = Math.max(1, vals.filter((v) => v !== 0).length);
          const d = sum - b.totalFees;
          // every fee column is rounded to cents by the broker → up to 0.005 per non-zero column is rounding, not an error
          if (Math.abs(d) > cols * 0.005 + 1e-9) {
            const st = classify(d, tol, warnBelow);
            if (st !== "ok" && st !== "na") push({ ...base, severity: st, kind: "fee_breakdown_mismatch", message: tx("issue.feeBreakdown", { sum: fmt(sum), total: fmt(b.totalFees) }), expected: r2(b.totalFees), actual: r2(sum), diff: r2(d) });
          }
        }
        if (b.qty != null && t.qty != null && Math.abs(b.qty - t.qty) > 1e-6) {
          push({ ...base, severity: "error", kind: "qty_mismatch", message: tx("issue.qtyMismatch", { journal: t.qty, broker: b.qty }), expected: b.qty, actual: t.qty });
        }
      }
    }

    // result vs net sign (result is decided on net)
    const r = normResult(t.result);
    const net = netPnl(t);
    if (!open && net != null && (r === "win" || r === "loss" || r === "be")) {
      const bad = (r === "win" && net < -tol) || (r === "loss" && net > tol) || (r === "be" && Math.abs(net) >= warnBelow);
      if (bad) push({ ...base, severity: "warn", kind: "result_sign", message: tx("issue.resultSign", { result: r, net: fmt(net) }), actual: r2(net) });
    }

    /* executions */
    const ex = execByTrade.get(t.id) ?? [];
    if (!ex.length) {
      withoutFills++;
      if (t.source === "propreports") {
        brokerWithoutFills++;
        push({ ...base, severity: "error", kind: "no_fills", message: tx("issue.noFills") });
      }
      continue;
    }
    withFills++;
    const entries = ex.filter((e) => e.kind === "entry" || e.kind === "add");
    const exits = ex.filter((e) => e.kind === "exit" || e.kind === "trim");
    if (!entries.length) push({ ...base, severity: "error", kind: "no_entry", message: tx("issue.noEntry") });
    if (!exits.length && !open) push({ ...base, severity: "error", kind: "no_exit", message: tx("issue.noExit") });
    if (entries.length && exits.length) {
      const firstEntry = Math.min(...entries.map((e) => (e.executedAt ? Date.parse(e.executedAt) : Infinity)));
      const early = exits.filter((e) => e.executedAt && Date.parse(e.executedAt) < firstEntry);
      if (Number.isFinite(firstEntry) && early.length) {
        push({ ...base, severity: "error", kind: "exit_before_entry", message: tx("issue.exitBeforeEntry", { at: String(early[0].executedAt) }) });
      }
    }
    const qIn = entries.reduce((s, e) => s + (e.qty ?? 0), 0);
    const qOut = exits.reduce((s, e) => s + (e.qty ?? 0), 0);
    if (entries.length && exits.length && !open && Math.abs(qIn - qOut) > 1e-6) {
      push({ ...base, severity: "error", kind: "fill_qty_mismatch", message: tx("issue.fillQtyInOut", { in: qIn, out: qOut }), expected: qIn, actual: qOut });
    } else if (t.qty != null && entries.length && Math.abs(qIn - t.qty) > 1e-6) {
      push({ ...base, severity: "error", kind: "fill_qty_mismatch", message: tx("issue.fillQtyTrade", { qty: t.qty, in: qIn }), expected: t.qty, actual: qIn });
    }
    const vwap = (list: RecExecution[]) => {
      const q = list.reduce((s, e) => s + (e.price != null ? e.qty ?? 0 : 0), 0);
      return q > 0 ? list.reduce((s, e) => s + (e.price ?? 0) * (e.qty ?? 0), 0) / q : null;
    };
    const avgIn = vwap(entries), avgOut = vwap(exits);
    const priceTol = 0.0051;
    const badIn = avgIn != null && t.entry != null && Math.abs(avgIn - t.entry) > priceTol;
    const badOut = avgOut != null && t.exit != null && !open && Math.abs(avgOut - t.exit) > priceTol;
    if (badIn || badOut) {
      push({ ...base, severity: "warn", kind: "fill_price_mismatch", message: badIn ? tx("issue.fillPriceIn", { avg: avgIn!.toFixed(4), price: String(t.entry) }) : tx("issue.fillPriceOut", { avg: avgOut!.toFixed(4), price: String(t.exit) }) });
    }
    // gross from fills: (exit − entry)·qty with side sign; report-derived fills carry avg prices rounded to cents
    if (!open && avgIn != null && avgOut != null && t.pnl != null && qOut > 0) {
      const sk = sideKey(t.side) ?? "long";
      const fillGross = (sk === "short" ? avgIn - avgOut : avgOut - avgIn) * qOut;
      const ptol = (b?.fromReport ?? false) ? 0.01 + qOut * 0.01 : 0.01 + qOut * 0.0001;
      const st = classify(fillGross - t.pnl, ptol, Math.max(warnBelow, ptol * 2));
      if (st !== "ok" && st !== "na") {
        push({ ...base, severity: st, kind: "fill_gross_mismatch", message: tx("issue.fillGross", { fills: fmt(fillGross), trade: fmt(t.pnl) }), expected: r2(t.pnl), actual: r2(fillGross), diff: r2(fillGross - t.pnl), hint: tx("hint.fillGross") });
      }
    }
  }

  /* ── duplicates (over the requested range) ── */
  const byExt = new Map<string, RecTrade[]>();
  const byFillKey = new Map<string, RecTrade[]>();
  for (const t of trades) {
    if (t.externalId) {
      const k = `${t.source}|${t.externalId}`;
      byExt.set(k, [...(byExt.get(k) ?? []), t]);
    }
    const ex = execByTrade.get(t.id) ?? [];
    const firstEntry = ex.filter((e) => e.kind === "entry").map((e) => e.executedAt).filter(Boolean).sort()[0] ?? null;
    const opened = timeKey(t.broker?.openedAt) ?? (firstEntry ? new Date(firstEntry).toISOString().slice(0, 19) + "Z" : null);
    if (opened && t.qty != null) {
      const k = `${t.trader ?? ""}|${t.ticker.toUpperCase()}|${opened}|${t.qty}`;
      byFillKey.set(k, [...(byFillKey.get(k) ?? []), t]);
    }
  }
  const dupReported = new Set<string>();
  for (const [k, list] of byExt) {
    if (list.length < 2) continue;
    const ids = list.map((t) => t.id).sort((a, b) => a - b);
    dupReported.add(ids.join(","));
    push({ date: closeDate(list[0]), ticker: list[0].ticker, trader: list[0].trader, tradeIds: ids, severity: "error", kind: "duplicate_external_id", message: tx("issue.dupExternal", { trades: nTrades(list.length), id: k.split("|").slice(1).join("|") }) });
  }
  for (const list of byFillKey.values()) {
    if (list.length < 2) continue;
    const ids = list.map((t) => t.id).sort((a, b) => a - b);
    if (dupReported.has(ids.join(","))) continue;
    push({ date: closeDate(list[0]), ticker: list[0].ticker, trader: list[0].trader, tradeIds: ids, severity: "error", kind: "duplicate_fill_key", message: tx("issue.dupFillKey", { ticker: list[0].ticker, qty: String(list[0].qty), trades: nTrades(list.length) }) });
  }
  // manual trade that mirrors a broker trade (same trader + ticker + date + side) — double counting
  const brokerKey = new Map<string, RecTrade[]>();
  for (const t of trades) if (t.source === "propreports") {
    const k = `${t.trader ?? ""}|${t.ticker.toUpperCase()}|${t.date}|${sideKey(t.side) ?? ""}`;
    brokerKey.set(k, [...(brokerKey.get(k) ?? []), t]);
  }
  for (const t of trades) if (t.source === "manual") {
    const twins = brokerKey.get(`${t.trader ?? ""}|${t.ticker.toUpperCase()}|${t.date}|${sideKey(t.side) ?? ""}`);
    if (twins?.length) {
      push({ date: closeDate(t), ticker: t.ticker, trader: t.trader, tradeIds: [t.id, ...twins.map((x) => x.id)], severity: "warn", kind: "manual_twin", message: tx("issue.manualTwin", { ticker: t.ticker, date: t.date }), hint: tx("hint.manualTwin") });
    }
  }

  /* ── days ── */
  const dayMap = new Map<string, { journal: MoneyWL; manual: Money; broker: Money; brokerN: number; ids: number[]; withFills: number; withoutFills: number }>();
  const dayOf = (d: string) => {
    let x = dayMap.get(d);
    if (!x) { x = { journal: emptyWL(), manual: emptyMoney(), broker: emptyMoney(), brokerN: 0, ids: [], withFills: 0, withoutFills: 0 }; dayMap.set(d, x); }
    return x;
  };
  for (const t of trades) {
    const d = dayOf(closeDate(t));
    d.ids.push(t.id);
    if ((execByTrade.get(t.id) ?? []).length) d.withFills++; else d.withoutFills++;
    if (t.source === "manual") { addTrade(d.manual, t); continue; }
    addTrade(d.journal, t);
    const b = t.broker;
    if (b) {
      d.brokerN++;
      d.broker.trades++;
      if (!isOpenTrade(t) && b.gross != null) {
        d.broker.gross += b.gross;
        d.broker.fees += Math.abs(b.totalFees ?? 0);
        d.broker.net += b.net ?? b.gross - Math.abs(b.totalFees ?? 0);
      }
    }
  }
  const bdMap = new Map<string, Money>();
  for (const bd of brokerDays) {
    if (!inRange(bd.date)) continue;
    const m = bdMap.get(bd.date) ?? emptyMoney();
    m.trades += bd.trades; m.gross += bd.gross; m.fees += bd.fees; m.net += bd.net;
    bdMap.set(bd.date, m);
  }
  const hasBrokerDays = bdMap.size > 0;
  // days known to the broker: a report period or broker-day list covering the date
  const brokerCovers = (d: string) => (hasBrokerDays ? bdMap.has(d) : false) || reports.some((r) => d >= r.periodFrom && d <= r.periodTo);
  const allDates = new Set<string>([...dayMap.keys(), ...bdMap.keys()]);
  const days: DayRow[] = [];
  for (const date of [...allDates].sort()) {
    const d = dayMap.get(date) ?? { journal: emptyWL(), manual: emptyMoney(), broker: emptyMoney(), brokerN: 0, ids: [], withFills: 0, withoutFills: 0 };
    const compares: Compare[] = [];
    const dayIssues: Issue[] = [];
    let brokerRef: Money | null = null;
    let brokerSource: DayRow["brokerSource"] = null;
    const bd = bdMap.get(date);
    if (bd) { brokerRef = bd; brokerSource = "report-days"; }
    else if (d.brokerN > 0) { brokerRef = d.broker; brokerSource = "snapshot"; }

    if (brokerRef) {
      const n = Math.max(d.journal.trades, brokerRef.trades);
      const band = brokerSource === "report-days" ? roundingTolerance(n, tol) : tol;
      compares.push(
        compareCount("trades", tx("compare.trades"), d.journal.trades, brokerRef.trades),
        compareMoney("gross", tx("compare.gross"), d.journal.gross, brokerRef.gross, band, warnBelow, lang),
        tagRounding(compareMoney("fees", tx("compare.fees"), d.journal.fees, brokerRef.fees, band, warnBelow, lang), n),
        tagRounding(compareMoney("net", tx("compare.net"), d.journal.net, brokerRef.net, band, warnBelow, lang), n),
      );
      const bad = compares.filter((c) => c.status === "warn" || c.status === "error");
      if (bad.length) {
        const net = compares.find((c) => c.key === "net")!;
        // all mismatches are fee/net gaps of ≤ $0.01 × trades → known cause
        const rounding = bad.every((c) => c.cause === "fee_rounding");
        dayIssues.push(push({
          date, ticker: null, trader: null, tradeIds: d.ids.slice(0, 50), severity: worst(...bad.map((c) => c.status)), kind: "day_mismatch",
          message: tx("issue.dayMismatch", { date, parts: bad.map((c) => `${c.label.toLowerCase()} ${c.key === "trades" ? c.journal : fmt(c.journal)} vs ${c.key === "trades" ? c.broker : fmt(c.broker)}`).join("; ") }) + (rounding ? ` — ${ROUND_LABEL}` : ""),
          expected: net.broker, actual: net.journal, diff: net.diff,
          ...(rounding ? { cause: "fee_rounding" as const, hint: ROUND_HINT } : {}),
        }));
      }
    }
    if (bd && d.journal.trades === 0) {
      dayIssues.push(push({ date, ticker: null, trader: null, tradeIds: [], severity: "error", kind: "day_missing_in_journal", message: tx("issue.dayMissingInJournal", { date, trades: nTrades(bd.trades), net: fmt(bd.net) }) }));
    } else if (hasBrokerDays && !bd && d.journal.trades > 0) {
      dayIssues.push(push({ date, ticker: null, trader: null, tradeIds: d.ids.slice(0, 50), severity: "error", kind: "day_missing_at_broker", message: tx("issue.dayMissingAtBroker", { date, n: d.journal.trades }) }));
    }
    if (d.manual.trades > 0 && d.journal.trades === 0 && brokerCovers(date)) {
      dayIssues.push(push({ date, ticker: null, trader: null, tradeIds: d.ids.slice(0, 50), severity: "warn", kind: "day_missing_at_broker", message: tx("issue.dayOnlyManual", { date, n: d.manual.trades }), hint: tx("hint.dayOnlyManual") }));
    }
    const tradeIssueIds = issues.filter((i) => i.date === date && !dayIssues.includes(i)).map((i) => i.id);
    const allIds = [...dayIssues.map((i) => i.id), ...tradeIssueIds];
    const status = worst(...compares.map((c) => c.status), ...issues.filter((i) => allIds.includes(i.id)).map((i) => i.severity));
    days.push({
      date, status,
      journal: roundMoney(d.journal), manual: roundMoney(d.manual), broker: brokerRef ? roundMoney({ ...brokerRef }) : null, brokerSource,
      compares, issueIds: allIds, tradeIds: d.ids, fills: { withFills: d.withFills, withoutFills: d.withoutFills },
    });
  }

  /* ── broker reports (aggregate) ── */
  const reportChecks: ReportCheck[] = [];
  for (const rep of reports) {
    const inPeriod = (t: RecTrade) => t.date >= rep.periodFrom && t.date <= rep.periodTo;
    const sameBook = (t: RecTrade) => (rep.account && t.account ? t.account === rep.account : rep.trader ? t.trader === rep.trader : true);
    const book = tradesIn.filter((t) => t.source === "propreports" && inPeriod(t) && sameBook(t) && !isOpenTrade(t));
    const manualIn = tradesIn.filter((t) => t.source === "manual" && inPeriod(t) && (rep.trader ? t.trader === rep.trader : true));
    const J = emptyWL();
    for (const t of book) addTrade(J, t);
    const M = emptyMoney();
    for (const t of manualIn) addTrade(M, t);
    const band = roundingTolerance(book.length, tol);
    const compares = [
      compareCount("trades", tx("compare.trades"), J.trades, rep.totals.trades),
      compareCount("wins", tx("compare.wins"), J.wins, rep.totals.wins),
      compareCount("losses", tx("compare.losses"), J.losses, rep.totals.losses),
      compareMoney("gross", tx("compare.gross"), J.gross, rep.totals.gross, band, warnBelow, lang),
      tagRounding(compareMoney("fees", tx("compare.fees"), J.fees, rep.totals.fees, band, warnBelow, lang), book.length),
      tagRounding(compareMoney("net", tx("compare.net"), J.net, rep.totals.net, band, warnBelow, lang), book.length),
    ];
    // fees by type: journal Σ snapshot breakdown vs report per-trade average × trades
    const feeTypes: Compare[] = [];
    if (rep.feeAverages) {
      const jf: Record<string, number> = {};
      for (const t of book) for (const [k, v] of Object.entries(t.broker?.feesByType ?? {})) jf[k] = (jf[k] ?? 0) + (num(v) ?? 0);
      const keys = [...new Set([...Object.keys(rep.feeAverages), ...Object.keys(jf)])];
      // averages are stored with 4 decimals → estimate error ±0.00005·N on top of per-row cent rounding
      const ftol = r2(band + 0.00005 * rep.totals.trades);
      for (const k of keys) {
        const est = (rep.feeAverages[k] ?? 0) * rep.totals.trades;
        const jv = jf[k] ?? 0;
        if (Math.abs(est) < 0.005 && Math.abs(jv) < 0.005) continue;
        feeTypes.push(compareMoney(`fee:${k}`, k, jv, est, ftol, warnBelow, lang));
      }
    }
    // groups
    const groups: GroupCheck[] = [];
    const groupOf = (scope: GroupCheck["scope"], keyOf: (t: RecTrade) => string | null, ref: Record<string, MoneyWL>, labelOf: (k: string) => string) => {
      if (!Object.keys(ref).length) return; // the report has no such breakdown
      const acc = new Map<string, MoneyWL>();
      for (const t of book) { const k = keyOf(t); if (!k) continue; const a = acc.get(k) ?? emptyWL(); addTrade(a, t); acc.set(k, a); }
      const keys = [...new Set([...acc.keys(), ...Object.keys(ref)])].sort();
      for (const k of keys) {
        const j = acc.get(k) ?? emptyWL();
        const bref = ref[k] ?? emptyWL();
        // many groups are checked at once → a wider (≈3σ) rounding band than the single grand-total check
        const gb = groupTolerance(Math.max(j.trades, bref.trades), tol);
        const st = worst(
          j.trades === bref.trades ? "ok" : "error",
          classify(j.gross - bref.gross, gb, warnBelow),
          classify(j.fees - bref.fees, gb, warnBelow),
          classify(j.net - bref.net, gb, warnBelow),
        );
        const g: GroupCheck = { scope, key: k, label: labelOf(k), status: st, journal: roundMoney(j), broker: roundMoney({ ...bref }), diffNet: r2(j.net - bref.net) };
        if (st !== "ok" && j.trades === bref.trades && classify(j.gross - bref.gross, gb, warnBelow) === "ok" && feeRoundingCause("net", j.net - bref.net, j.trades)) g.cause = "fee_rounding";
        groups.push(g);
      }
    };
    groupOf("side", (t) => sideKey(t.side), rep.bySide as Record<string, MoneyWL>, (k) => tx(k === "long" ? "side.long" : "side.short"));
    groupOf("weekday", (t) => weekdayOf(t.date), rep.byWeekday, (k) => weekdayLabel(k, lang));
    groupOf("symbol", (t) => t.ticker.toUpperCase(), rep.bySymbol, (k) => k);
    const jSyms = new Set(book.map((t) => t.ticker.toUpperCase()));
    const rSyms = new Set(Object.keys(rep.bySymbol));
    const symbolsMissingInJournal = Object.keys(rep.bySymbol).filter((s) => !jSyms.has(s)).sort();
    const symbolsMissingInReport = Object.keys(rep.bySymbol).length ? [...jSyms].filter((s) => !rSyms.has(s)).sort() : [];

    const label = tx("issue.reportLabel", { account: rep.account ?? "", from: rep.periodFrom, to: rep.periodTo }).replace(/\s+/g, " ");
    const badTotals = compares.filter((c) => c.status === "warn" || c.status === "error");
    for (const c of badTotals) {
      const hint = c.cause === "fee_rounding" ? ROUND_HINT
        : c.key === "fees" || c.key === "net" ? feeHint(J.fees - rep.totals.fees, book.length, lang)
        : c.key === "trades" ? tx("hint.totalTrades") : undefined;
      push({
        date: null, ticker: null, trader: rep.trader, tradeIds: [], severity: c.status as Severity, kind: "total_mismatch",
        message: tx("issue.totalMismatch", { label, what: c.label.toLowerCase(), journal: String(c.key === "trades" || c.key === "wins" || c.key === "losses" ? c.journal : fmt(c.journal)), broker: String(c.key === "trades" || c.key === "wins" || c.key === "losses" ? c.broker : fmt(c.broker)) }) + (c.cause === "fee_rounding" ? ` — ${ROUND_LABEL}` : ""),
        expected: c.broker, actual: c.journal, diff: c.diff, hint, cause: c.cause,
      });
    }
    for (const c of feeTypes.filter((x) => x.status === "warn" || x.status === "error")) {
      push({ date: null, ticker: null, trader: rep.trader, tradeIds: [], severity: c.status as Severity, kind: "fee_type_mismatch", message: tx("issue.feeTypeMismatch", { label, fee: c.label, journal: fmt(c.journal), broker: fmt(c.broker) }), expected: c.broker, actual: c.journal, diff: c.diff, hint: tx("hint.feeType") });
    }
    for (const g of groups.filter((x) => x.status !== "ok")) {
      const ids = book.filter((t) => (g.scope === "symbol" ? t.ticker.toUpperCase() === g.key : g.scope === "side" ? sideKey(t.side) === g.key : weekdayOf(t.date) === g.key)).map((t) => t.id);
      push({
        date: null, ticker: g.scope === "symbol" ? g.key : null, trader: rep.trader, tradeIds: ids.slice(0, 50), severity: g.status, kind: g.journal.trades === 0 ? "symbol_missing_in_journal" : g.broker.trades === 0 ? "symbol_missing_in_report" : "group_mismatch",
        message: tx("issue.group", { label, scope: tx(`scope.${g.scope}`), group: g.label, jn: g.journal.trades, jnet: fmt(g.journal.net), bn: g.broker.trades, bnet: fmt(g.broker.net) }) + (g.cause ? ` — ${ROUND_LABEL}` : ""),
        expected: g.broker.net, actual: g.journal.net, diff: g.diffNet,
        ...(g.cause ? { cause: g.cause, hint: ROUND_HINT } : {}),
      });
    }
    if (M.trades > 0) {
      push({ date: null, ticker: null, trader: rep.trader, tradeIds: manualIn.map((t) => t.id).slice(0, 50), severity: "warn", kind: "manual_in_broker_period", message: tx("issue.manualInPeriod", { label, n: M.trades, net: fmt(r2(M.net)) }), hint: tx("hint.manualInPeriod") });
    }
    reportChecks.push({
      reportId: rep.id, account: rep.account, trader: rep.trader, periodFrom: rep.periodFrom, periodTo: rep.periodTo,
      status: worst(...compares.map((c) => c.status), ...feeTypes.map((c) => c.status), ...groups.map((g) => g.status)),
      compares, feeTypes, groups, symbolsMissingInJournal, symbolsMissingInReport, manualInPeriod: roundMoney(M),
    });
  }

  /* ── summary ── */
  const J = emptyWL();
  const Mn = emptyMoney();
  for (const t of trades) addTrade(t.source === "manual" ? Mn : J, t);
  const counts: Record<Severity, number> = { ok: 0, warn: 0, error: 0 };
  for (const i of issues) counts[i.severity]++;
  const discrepancies = counts.warn + counts.error;
  const status = worst(...issues.map((i) => i.severity));
  const sorted = [...issues].sort((a, b) => RANK[b.severity] - RANK[a.severity] || String(b.date ?? "9999").localeCompare(String(a.date ?? "9999")) || a.id.localeCompare(b.id));
  const max = opts.maxIssues ?? 2000;
  const fbt: Record<string, number> = {};
  for (const [k, v] of Object.entries(feesByType)) fbt[k] = r2(v);
  return {
    summary: {
      status,
      label: discrepancies === 0 ? tx("summary.ok") : tx("summary.discrepancies", { count: discrepancies }),
      discrepancies, counts,
      period: { from, to }, tolerance: tol, warnBelow,
      journal: { ...roundMoney(J), feesByType: fbt }, manual: roundMoney(Mn),
      days: days.length, daysWithIssues: days.filter((d) => d.status !== "ok").length,
      tradesChecked: trades.length,
      fills: { withFills, withoutFills, brokerWithoutFills },
      hasReport: reportChecks.length > 0, hasBrokerDays,
      roundingIssues: issues.filter((i) => i.cause === "fee_rounding" && i.severity !== "ok").length,
    },
    days,
    reports: reportChecks,
    issues: sorted.slice(0, max),
    issuesTruncated: sorted.length > max,
  };
}

/** Explains a small fee/net gap vs the broker's own total. */
export function feeHint(feeDiff: number, n: number, lang: Lang = "ru"): string | undefined {
  if (!Number.isFinite(feeDiff) || Math.abs(feeDiff) < 0.005) return undefined;
  const t = reconcileT.tFor(lang);
  if (Math.abs(feeDiff) <= 0.02 * Math.max(1, n)) return t(feeDiff > 0 ? "hint.feesMore" : "hint.feesLess");
  return t("hint.feesLarge");
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* ─── adapters (rows → engine input) ───────────────────────────────────── */

/** PropReports context_snapshot → BrokerSnapshot (null when the snapshot is not a PropReports one). */
export function snapshotFrom(raw: unknown): BrokerSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.source !== "propreports") return null;
  const fbt = s.feesByType && typeof s.feesByType === "object" ? Object.fromEntries(Object.entries(s.feesByType as Record<string, unknown>).map(([k, v]) => [k, num(v) ?? 0])) : null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    gross: num(s.gross), net: num(s.net), totalFees: num(s.totalFees), feesByType: fbt,
    qty: num(s.qty), avgEntry: num(s.avgEntry), avgExit: num(s.avgExit),
    openedAt: str(s.openedAt), closedAt: str(s.closedAt), openQty: num(s.openQty), fromReport: s.fromReport === true,
  };
}

interface PerfRowLike { label?: string; trades?: number; wins?: { count?: number; gross?: number }; losses?: { count?: number }; totals?: { gross?: number; fees?: number; net?: number } }
function perfMoney(r: PerfRowLike | null | undefined): MoneyWL | null {
  if (!r || !r.totals) return null;
  return {
    trades: Number(r.trades ?? 0) || 0, wins: Number(r.wins?.count ?? 0) || 0, losses: Number(r.losses?.count ?? 0) || 0,
    gross: num(r.totals.gross) ?? 0, fees: num(r.totals.fees) ?? 0, net: num(r.totals.net) ?? 0,
  };
}

/** Stored "Trade Performance" report (lib/propreports/parse-performance-report.ts shape) → RecReport. */
export function reportFrom(row: { id: number; account: string | null; trader_name?: string | null; traderName?: string | null; period_from?: string; periodFrom?: string; period_to?: string; periodTo?: string; data: any }): RecReport | null {
  const d = row.data ?? {};
  const totals = perfMoney(d.totals);
  if (!totals) return null;
  const pta = Array.isArray(d.perTradeAverages) ? d.perTradeAverages : [];
  let feeAverages: Record<string, number> | null = null;
  if (pta.length) {
    feeAverages = {};
    for (const g of pta) for (const [k, v] of Object.entries((g?.fees ?? {}) as Record<string, unknown>)) feeAverages[k] = (feeAverages[k] ?? 0) + (num(v) ?? 0);
  }
  const rec = (rows: unknown, key: (l: string) => string): Record<string, MoneyWL> => {
    const out: Record<string, MoneyWL> = {};
    if (Array.isArray(rows)) for (const r of rows as PerfRowLike[]) { const m = perfMoney(r); if (m && r.label) out[key(r.label)] = m; }
    return out;
  };
  const bySide: RecReport["bySide"] = {};
  const long = perfMoney(d.bySide?.long), short = perfMoney(d.bySide?.short);
  if (long) bySide.long = long;
  if (short) bySide.short = short;
  return {
    id: row.id, account: row.account ?? null, trader: row.traderName ?? row.trader_name ?? null,
    periodFrom: String(row.periodFrom ?? row.period_from ?? ""), periodTo: String(row.periodTo ?? row.period_to ?? ""),
    totals, feeAverages, bySide,
    byWeekday: rec(d.byWeekday, (l) => l.trim().toLowerCase()),
    bySymbol: rec(d.bySymbol, (l) => l.trim().toUpperCase()),
  };
}

/** Discrepancies as CSV rows (also built client-side; kept here so the API can serve ?format=csv). */
export function issuesCsv(issues: Issue[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["severity", "kind", "cause", "date", "trader", "ticker", "trade_ids", "expected", "actual", "diff", "message", "hint"];
  const lines = issues.map((i) => [i.severity, i.kind, i.cause, i.date, i.trader, i.ticker, i.tradeIds.join(" "), i.expected, i.actual, i.diff, i.message, i.hint].map(esc).join(","));
  return [head.join(","), ...lines].join("\n");
}
