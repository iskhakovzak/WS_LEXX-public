/**
 * Trade structure ↔ DB. The maths lives in lib/tradeStructure.ts (pure); this file loads a trade with the other
 * trades of its day chain (same trader + ticker + session date — re-entries and flips need the neighbours),
 * runs the classifier and persists the result additively:
 *
 *   trades.structure        JSONB  StructureStats + `summary` (one Russian line for lists)
 *   trades.reentry_of       INT    previous trade of the chain when this one is a re-entry / flip
 *   trade_executions.role / role_inferred / leg_index / order_id
 *
 * Everything is recomputable: refreshTradeStructures() is idempotent (writes only rows whose value changed) and is
 * called after PropReports syncs, execution edits and stop / risk edits; backfillTradeStructures() runs at startup
 * for trades without a structure. GET /trades/:id/executions computes on read (always fresh).
 */
import { pool } from "@workspace/db";
import { cleanCandles, type Ohlcv } from "./candleClean";
import type { Lang } from "../i18n";
import {
  classifyTrade, linkTrades, structureSummary,
  type ExecIn, type ExecKind, type Leg, type Side, type StructureStats, type TradeHead, type TradeSource, type TradeStructure,
} from "./tradeStructure";

type Queryable = { query: (typeof pool)["query"] };

export async function ensureTradeStructureSchema(q: Queryable = pool): Promise<void> {
  await q.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS structure JSONB`);
  await q.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS reentry_of INTEGER`);
  await q.query(`CREATE INDEX IF NOT EXISTS trades_chain_idx ON trades(trader, ticker, date)`);
  await q.query(`ALTER TABLE trade_executions ADD COLUMN IF NOT EXISTS role TEXT`);
  await q.query(`ALTER TABLE trade_executions ADD COLUMN IF NOT EXISTS role_inferred BOOLEAN NOT NULL DEFAULT FALSE`);
  await q.query(`ALTER TABLE trade_executions ADD COLUMN IF NOT EXISTS leg_index INTEGER`);
  await q.query(`ALTER TABLE trade_executions ADD COLUMN IF NOT EXISTS order_id TEXT`);
}

export interface TradeRowLite {
  id: number;
  trader: string | null;
  broker_account: string | null;
  ticker: string;
  date: string;
  side: string | null;
  stop: string | number | null;
  risk_usd: string | number | null;
  qty: string | number | null;
  result: string | null;
  source: string | null;
  context_snapshot: Record<string, unknown> | null;
}

export interface ExecRowLite {
  id: number;
  trade_id: number;
  kind: string;
  price: string | number;
  qty: string | number | null;
  executed_at: Date | string | null;
  sort_order: number;
  order_id?: string | null;
}

/** Bump when the stored shape / rules change: the startup back-fill then recomputes every trade. */
export const STRUCTURE_VERSION = 2; // 2: reasons / notes also stored as data (localizeStats)

/** Persisted shape (trades.structure). */
export type PersistedStructure = StructureStats & { summary: string };

const num = (x: unknown): number | null => {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const iso = (x: Date | string | null): string | null => {
  if (x == null) return null;
  const d = x instanceof Date ? x : new Date(x);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const KINDS: ReadonlySet<string> = new Set(["entry", "add", "trim", "exit", "stop"]);

export function sideOfRow(side: string | null | undefined): Side {
  return (side || "").toLowerCase().includes("short") ? "short" : "long";
}

/** fills = PropReports fills sync, report = PropReports «Trades» report (averages only), manual = typed in. */
export function sourceOfRow(t: Pick<TradeRowLite, "source" | "context_snapshot">): TradeSource {
  if (t.source !== "propreports") return "manual";
  return t.context_snapshot && (t.context_snapshot as { fromReport?: unknown }).fromReport === true ? "report" : "fills";
}

function toExecIn(e: ExecRowLite): ExecIn {
  return {
    id: e.id,
    kind: (KINDS.has(e.kind) ? e.kind : "entry") as ExecKind,
    price: num(e.price) ?? 0,
    qty: num(e.qty),
    at: iso(e.executed_at),
    orderId: e.order_id ?? null,
    sortOrder: e.sort_order,
  };
}

function headOf(t: TradeRowLite, execs: readonly ExecRowLite[]): TradeHead {
  const times = execs.map((e) => iso(e.executed_at)).filter((x): x is string => !!x).sort();
  const open = (t.result || "").toLowerCase() === "open";
  return {
    id: t.id,
    group: `${t.trader ?? ""}\u0000${t.broker_account ?? ""}`,
    symbol: t.ticker,
    session: String(t.date).slice(0, 10),
    side: sideOfRow(t.side),
    openedAt: times[0] ?? null,
    closedAt: open ? null : times[times.length - 1] ?? null,
  };
}

/**
 * Pure: structures for a set of trades (pass whole day chains so links are right). `extremes` = most adverse price
 * during each trade's hold from cached candles (optional, feeds the inferred-stop heuristic).
 */
export function computeStructures(trades: readonly TradeRowLite[], execs: readonly ExecRowLite[], extremes?: ReadonlyMap<number, number>, lang: Lang = "ru"): Map<number, TradeStructure> {
  const byTrade = new Map<number, ExecRowLite[]>();
  for (const e of execs) {
    const l = byTrade.get(e.trade_id);
    if (l) l.push(e); else byTrade.set(e.trade_id, [e]);
  }
  const links = linkTrades(trades.map((t) => headOf(t, byTrade.get(t.id) ?? [])));
  const out = new Map<number, TradeStructure>();
  for (const t of trades) {
    out.set(t.id, classifyTrade((byTrade.get(t.id) ?? []).map(toExecIn), {
      side: sideOfRow(t.side),
      source: sourceOfRow(t),
      stop: num(t.stop),
      riskUsd: num(t.risk_usd),
      tradeQty: num(t.qty),
      link: links.get(t.id) ?? null,
      adverseExtreme: extremes?.get(t.id) ?? null,
      lang,
    }));
  }
  return out;
}

export function persistedOf(s: TradeStructure): PersistedStructure {
  return { ...s.stats, summary: structureSummary(s.stats) };
}

const TRADE_COLS = `id, trader, broker_account, ticker, date, side, stop, risk_usd, qty, result, source, context_snapshot`;

/** The trades plus every live trade sharing their (trader, ticker, date). */
async function loadChains(q: Queryable, tradeIds: readonly number[]): Promise<TradeRowLite[]> {
  if (!tradeIds.length) return [];
  const { rows } = await q.query(
    `SELECT ${TRADE_COLS} FROM trades t
      WHERE t.deleted_at IS NULL
        AND ((t.trader, t.ticker, t.date) IN (SELECT s.trader, s.ticker, s.date FROM trades s WHERE s.id = ANY($1::int[]))
             OR t.id = ANY($1::int[]))`,
    [tradeIds],
  );
  return rows as TradeRowLite[];
}

async function loadExecs(q: Queryable, tradeIds: readonly number[]): Promise<ExecRowLite[]> {
  if (!tradeIds.length) return [];
  const { rows } = await q.query(
    `SELECT id, trade_id, kind, price, qty, executed_at, sort_order, order_id
       FROM trade_executions WHERE trade_id = ANY($1::int[]) ORDER BY trade_id, sort_order, id`,
    [tradeIds],
  );
  return rows as ExecRowLite[];
}

/**
 * Most adverse price inside each trade's hold window from candles ALREADY in candles_cache (1m / 5m), cleaned of stray
 * prints by lib/candleClean like every other candle read. Never fetches:
 * no cached candles → no entry → the heuristic simply does not fire.
 */
export async function loadExtremes(q: Queryable, trades: readonly TradeRowLite[], execs: readonly ExecRowLite[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const window = new Map<number, { from: number; to: number }>();
  for (const t of trades) {
    const ts = execs.filter((e) => e.trade_id === t.id).map((e) => iso(e.executed_at)).filter((x): x is string => !!x).map((x) => Date.parse(x) / 1000);
    if (ts.length >= 2) window.set(t.id, { from: Math.min(...ts), to: Math.max(...ts) });
  }
  const pairs = [...new Set(trades.filter((t) => window.has(t.id)).map((t) => `${t.ticker}|${String(t.date).slice(0, 10)}`))];
  if (!pairs.length) return out;
  const { rows } = await q.query(
    `SELECT DISTINCT ON (ticker, date) ticker, date, interval, ohlcv FROM candles_cache
      WHERE interval IN ('1m', '5m') AND (ticker || '|' || date) = ANY($1::text[])
      ORDER BY ticker, date, (interval = '1m') DESC, extended DESC, fetched_at DESC`,
    [pairs],
  );
  const bars = new Map<string, { sec: number; list: { t: number; h: number; l: number }[] }>();
  for (const r of rows as { ticker: string; date: string; interval: string; ohlcv: unknown }[]) {
    if (!Array.isArray(r.ohlcv)) continue;
    // Same bad-print cleaning as the chart (routes/candles.ts): a stray Yahoo wick must not become the trade's MAE.
    bars.set(`${r.ticker}|${r.date}`, { sec: r.interval === "1m" ? 60 : 300, list: cleanCandles(r.ohlcv as Ohlcv[]) });
  }
  for (const t of trades) {
    const w = window.get(t.id);
    const b = bars.get(`${t.ticker}|${String(t.date).slice(0, 10)}`);
    if (!w || !b) continue;
    const inHold = b.list.filter((c) => Number.isFinite(c.h) && Number.isFinite(c.l) && c.t + b.sec > w.from && c.t <= w.to);
    if (!inHold.length) continue;
    out.set(t.id, sideOfRow(t.side) === "short" ? Math.max(...inHold.map((c) => c.h)) : Math.min(...inHold.map((c) => c.l)));
  }
  return out;
}

export interface SiblingTrade {
  id: number;
  side: Side;
  reentryIndex: number;
  isCurrent: boolean;
  summary: string;
  legs: Array<Pick<Leg, "role" | "label" | "price" | "at" | "opening">>;
}

/** Structure of one trade, computed now, plus the light-weight legs of its day chain (for the chart's re-entry links). */
/** `lang` = language of labels / reasons / notes / summaries in the answer (computed on read). */
export async function structureForTrade(tradeId: number, q: Queryable = pool, lang: Lang = "ru"): Promise<{ structure: TradeStructure; siblings: SiblingTrade[] } | null> {
  const chain = await loadChains(q, [tradeId]);
  if (!chain.some((t) => t.id === tradeId)) return null;
  const execs = await loadExecs(q, chain.map((t) => t.id));
  const extremes = await loadExtremes(q, chain.filter((t) => t.id === tradeId), execs);
  const all = computeStructures(chain, execs, extremes, lang);
  const structure = all.get(tradeId)!;
  const siblings: SiblingTrade[] = chain
    .map((t) => {
      const s = all.get(t.id)!;
      return {
        id: t.id, side: sideOfRow(t.side), reentryIndex: s.stats.reentryIndex, isCurrent: t.id === tradeId, summary: structureSummary(s.stats, lang),
        legs: s.legs.map((l) => ({ role: l.role, label: l.label, price: l.price, at: l.at, opening: l.opening })),
      };
    })
    .sort((a, b) => a.reentryIndex - b.reentryIndex || a.id - b.id);
  return { structure, siblings };
}

export interface RefreshResult { trades: number; tradesChanged: number; executionsChanged: number }

/**
 * Recompute and persist the structure of the given trades (and their day-chain neighbours, whose links may change),
 * or of every live trade with "all". Idempotent: only rows whose stored value differs are written.
 */
export async function refreshTradeStructures(target: readonly number[] | "all", q: Queryable = pool): Promise<RefreshResult> {
  let trades: TradeRowLite[];
  if (target === "all") {
    const { rows } = await q.query(`SELECT ${TRADE_COLS} FROM trades WHERE deleted_at IS NULL`);
    trades = rows as TradeRowLite[];
  } else {
    trades = await loadChains(q, target);
  }
  if (!trades.length) return { trades: 0, tradesChanged: 0, executionsChanged: 0 };
  const execs = await loadExecs(q, trades.map((t) => t.id));
  const extremes = await loadExtremes(q, trades, execs);
  const all = computeStructures(trades, execs, extremes);

  const ids: number[] = [], payloads: string[] = [], reentry: (number | null)[] = [];
  for (const t of trades) {
    const s = all.get(t.id)!;
    ids.push(t.id);
    payloads.push(JSON.stringify(persistedOf(s)));
    reentry.push(s.stats.reentryIndex > 0 ? s.stats.prevId : null);
  }
  const tr = await q.query(
    `UPDATE trades t SET structure = v.s, reentry_of = v.r
       FROM (SELECT unnest($1::int[]) AS id, unnest($2::jsonb[]) AS s, unnest($3::int[]) AS r) v
      WHERE t.id = v.id AND (t.structure IS DISTINCT FROM v.s OR t.reentry_of IS DISTINCT FROM v.r)`,
    [ids, payloads, reentry],
  );

  const eIds: number[] = [], roles: string[] = [], inferred: boolean[] = [], legIdx: number[] = [];
  for (const e of execs) {
    const r = all.get(e.trade_id)?.byExecution[e.id];
    if (!r) continue;
    eIds.push(e.id); roles.push(r.role); inferred.push(r.inferred); legIdx.push(r.legIndex);
  }
  let executionsChanged = 0;
  if (eIds.length) {
    const er = await q.query(
      `UPDATE trade_executions e SET role = v.role, role_inferred = v.inf, leg_index = v.leg
         FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS role, unnest($3::bool[]) AS inf, unnest($4::int[]) AS leg) v
        WHERE e.id = v.id AND (e.role IS DISTINCT FROM v.role OR e.role_inferred IS DISTINCT FROM v.inf OR e.leg_index IS DISTINCT FROM v.leg)`,
      [eIds, roles, inferred, legIdx],
    );
    executionsChanged = er.rowCount ?? 0;
  }
  return { trades: trades.length, tradesChanged: tr.rowCount ?? 0, executionsChanged };
}

/**
 * Back-fill: compute the structure of every live trade that has none yet (or an older `v`), in chunks.
 * Idempotent — a second run finds nothing to do. Runs in the background at startup.
 */
export async function backfillTradeStructures(q: Queryable = pool, chunk = 400): Promise<RefreshResult> {
  const { rows } = await q.query(
    `SELECT id FROM trades WHERE deleted_at IS NULL AND (structure IS NULL OR COALESCE((structure->>'v')::int, 0) < $1) ORDER BY id`,
    [STRUCTURE_VERSION],
  );
  const ids = (rows as { id: number }[]).map((r) => Number(r.id));
  const total: RefreshResult = { trades: 0, tradesChanged: 0, executionsChanged: 0 };
  for (let i = 0; i < ids.length; i += chunk) {
    const r = await refreshTradeStructures(ids.slice(i, i + chunk), q);
    total.trades += r.trades; total.tradesChanged += r.tradesChanged; total.executionsChanged += r.executionsChanged;
  }
  return total;
}
