/**
 * Training tasks (chart-lab «Тренировка») — pure helpers for routes/training.ts: filter parsing, the resolution of a
 * task's day, picking a random task and the trade payload a trainee may see.
 *
 * Sources:
 *   - mine  — the viewer's own trades;
 *   - desk  — every trader's trades (members only, not guests). Someone else's trade comes with its $ / size nulled
 *             (lib/playbookPrivacy redactTradeRow / redactExecutions / redactStructure): prices, times, side and R stay;
 *   - day   — a ticker + day with no trade at all (a day that has bars cached or a day someone traded).
 * A task never names the trader, side or result: the page shows them only after the reveal.
 */
import { redactExecutions, redactStructure, redactTradeRow, type MoneyViewer, type Redacted } from "./playbookPrivacy";
import { dayResolution } from "./candleLimits";
import { roleLabel, structureSummary, type TradeStructure } from "./tradeStructure";
import type { Lang } from "../i18n";
import { signedR } from "./tradeMath";

export type TrainingSource = "mine" | "desk" | "day";
export type TaskResolution = "1m" | "5m" | "60m";
/** Coarsest bars a task may have: "1m" — only 1-minute days, "5m" — 1m or 5m (default), "any" — hourly too. */
export type ResolutionPref = "1m" | "5m" | "any";

export type TaskFilters = {
  source: TrainingSource;
  side: "long" | "short" | null;
  result: "win" | "loss" | null;
  ticker: string | null;
  from: string | null;
  to: string | null;
  res: ResolutionPref;
  /** Task keys to skip (recently played), see {@link taskKey}. */
  exclude: string[];
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,10}$/;

function one(v: unknown): string {
  return String(Array.isArray(v) ? v[0] ?? "" : v ?? "").trim();
}

export function parseTaskFilters(q: Record<string, unknown>): TaskFilters {
  const source = one(q.source);
  const side = one(q.side).toLowerCase();
  const result = one(q.result).toLowerCase();
  const ticker = one(q.ticker).toUpperCase();
  const from = one(q.from);
  const to = one(q.to);
  const res = one(q.res);
  return {
    source: source === "desk" || source === "day" ? source : "mine",
    side: side === "long" || side === "short" ? side : null,
    result: result === "win" || result === "loss" ? result : null,
    ticker: TICKER_RE.test(ticker) ? ticker : null,
    from: YMD.test(from) ? from : null,
    to: YMD.test(to) ? to : null,
    res: res === "1m" || res === "any" ? res : "5m",
    exclude: one(q.exclude).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200),
  };
}

export function meetsResolution(r: TaskResolution, pref: ResolutionPref): boolean {
  if (pref === "any") return true;
  if (pref === "1m") return r === "1m";
  return r === "1m" || r === "5m";
}

export type TaskCandidate = {
  kind: "trade" | "day";
  tradeId: number | null;
  ticker: string;
  date: string;
  res: TaskResolution;
};

/** Stable key of a task (for «don't repeat the last few»). */
export function taskKey(c: Pick<TaskCandidate, "kind" | "tradeId" | "ticker" | "date">): string {
  return c.kind === "trade" ? `t${c.tradeId}` : `d:${c.ticker}:${c.date}`;
}

/** Candidate from a DB row (trade or day) with its cache flags. Null for tickers / days the chart cannot load. */
export function candidateOf(row: { id?: number | null; ticker: string; date: string; m1?: boolean | null; m5?: boolean | null }, nowMs: number = Date.now()): TaskCandidate | null {
  const ticker = String(row.ticker ?? "").toUpperCase().trim();
  const date = String(row.date ?? "").slice(0, 10);
  if (!TICKER_RE.test(ticker) || !YMD.test(date)) return null;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return null;
  const res = dayResolution(date, { m1: !!row.m1, m5: !!row.m5 }, nowMs);
  return row.id != null ? { kind: "trade", tradeId: Number(row.id), ticker, date, res } : { kind: "day", tradeId: null, ticker, date, res };
}

export type ResolutionCounts = { total: number; "1m": number; "5m": number; "60m": number };

export function resolutionCounts(list: readonly Pick<TaskCandidate, "res">[]): ResolutionCounts {
  const out: ResolutionCounts = { total: list.length, "1m": 0, "5m": 0, "60m": 0 };
  for (const c of list) out[c.res] += 1;
  return out;
}

/**
 * Random task meeting the resolution preference, skipping excluded keys (when everything is excluded the exclusion
 * is dropped so the pool never looks empty just because it was played through). `rnd` is injectable for tests.
 */
export function pickTask(list: readonly TaskCandidate[], pref: ResolutionPref, exclude: readonly string[], rnd: () => number = Math.random): TaskCandidate | null {
  const ok = list.filter((c) => meetsResolution(c.res, pref));
  if (!ok.length) return null;
  const skip = new Set(exclude);
  const fresh = ok.filter((c) => !skip.has(taskKey(c)));
  const from = fresh.length ? fresh : ok;
  return from[Math.min(from.length - 1, Math.floor(rnd() * from.length))];
}

/** Trade fields the training chart needs — nothing else (no notes, screenshots, context, tags). */
export const TRAINING_TRADE_FIELDS = [
  "id", "ticker", "date", "side", "entry", "exit", "stop", "qty", "pnl", "fees", "riskUsd", "result", "horizon", "exitDate", "rMultiple", "movePct", "setup", "trader",
] as const;

export type TrainingTradeRow = {
  id: number; ticker: string; date: string; side: string | null; entry: number | null; exit: number | null; stop: number | null;
  qty: number | null; pnl: number | null; fees: number | null; riskUsd: number | null; result: string | null; horizon: string | null;
  exitDate: string | null;
  /** Signed R (lib/tradeMath.signedR: stored R → price/stop → pnl/risk), worked out BEFORE the $ are redacted. */
  rMultiple: number | null;
  /** Side-aware price move entry → exit, % (no $, no size) — the result to show when R is unknown. */
  movePct: number | null;
  setup: string | null; trader: string | null;
};

/** Side-aware % move from entry to exit (short: entry above exit is a gain). */
export function sideMovePct(side: unknown, entry: number | null, exit: number | null): number | null {
  if (entry == null || exit == null || !(entry > 0)) return null;
  const short = String(side ?? "").trim().toLowerCase().startsWith("s");
  return Math.round(((short ? entry - exit : exit - entry) / entry) * 10000) / 100;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** DB row (snake_case, numerics as strings) → the training trade shape, $ redacted for someone else's trade. */
export function trainingTradeOf(r: Record<string, unknown>, viewer: MoneyViewer): Redacted<TrainingTradeRow> {
  const row: TrainingTradeRow = {
    id: Number(r.id),
    ticker: String(r.ticker ?? "").toUpperCase(),
    date: String(r.date ?? "").slice(0, 10),
    side: r.side != null ? String(r.side) : null,
    entry: num(r.entry), exit: num(r.exit), stop: num(r.stop),
    qty: num(r.qty), pnl: num(r.pnl), fees: num(r.fees), riskUsd: num(r.risk_usd),
    result: r.result != null ? String(r.result) : null,
    horizon: r.horizon != null ? String(r.horizon) : null,
    exitDate: r.exit_date != null ? String(r.exit_date).slice(0, 10) : null,
    // Desk trades rarely store r_multiple and their pnl / risk are nulled for other traders, so the result shown after
    // the reveal is derived here from the full row: R where it can be worked out, else the % move.
    rMultiple: (() => { const v = signedR(r); return v == null ? null : Math.round(v * 100) / 100; })(),
    movePct: sideMovePct(r.side, num(r.entry), num(r.exit)),
    setup: r.setup != null ? String(r.setup) : null,
    trader: r.trader != null ? String(r.trader) : null,
  };
  return redactTradeRow(row, viewer);
}

/** Desk trades (and any trade by id) are open to signed-in members; guests / anonymous only get «day» tasks. */
export function canTrainOnTrades(viewer: MoneyViewer, isGuest: boolean): boolean {
  return !isGuest && !!viewer.name;
}

/** A fill as GET /training/trades/:id sends it (same shape as GET /trades/:id/executions). */
export type TrainingExecution = {
  id: number; tradeId: number; kind: string; price: string; qty: string | null; executedAt: string | null; note: string | null;
  sortOrder: number; role: string | null; roleLabel: string | null; roleInferred: boolean; legIndex: number | null;
};

/**
 * Response of GET /training/trades/:id: the trade (only the fields the chart needs), its fills and recognised
 * structure — with share counts, fees and $ nulled when the trade is not the viewer's and the viewer is not staff.
 */
export function buildTrainingTradePayload(
  tradeRow: Record<string, unknown>,
  execRows: readonly Record<string, unknown>[],
  computed: { structure: TradeStructure; siblings: unknown[] } | null,
  viewer: MoneyViewer,
  lang: Lang = "ru",
): { trade: Redacted<TrainingTradeRow>; executions: TrainingExecution[]; structure: Record<string, unknown> | null } {
  const trade = trainingTradeOf(tradeRow, viewer);
  const owner = tradeRow.trader != null ? String(tradeRow.trader) : null;
  const byExec = computed?.structure.byExecution ?? {};
  const executions: TrainingExecution[] = execRows.map((r) => {
    const id = Number(r.id);
    const s = byExec[id];
    return {
      id,
      tradeId: Number(r.trade_id),
      kind: String(r.kind),
      price: String(r.price),
      qty: r.qty != null ? String(r.qty) : null,
      executedAt: r.executed_at ? new Date(r.executed_at as string).toISOString() : null,
      note: r.note != null ? String(r.note) : null,
      sortOrder: Number(r.sort_order ?? 0),
      role: s?.role ?? null,
      roleLabel: s ? roleLabel(s.role, lang) : null,
      roleInferred: s?.inferred ?? false,
      legIndex: s?.legIndex ?? null,
    };
  });
  const structure = computed
    ? { ...redactStructure({ legs: computed.structure.legs, stats: { ...computed.structure.stats, summary: structureSummary(computed.structure.stats, lang) } }, viewer, owner), siblings: computed.siblings }
    : null;
  return { trade, executions: redactExecutions(executions, viewer, owner), structure };
}
