/**
 * Сборка TradeForRule из строки БД — чистая функция (без БД), чтобы её можно было проверить офлайн.
 * Время сделки: сначала исполнения (trade_executions), затем снимок брокера (context_snapshot.openedAt/closedAt —
 * настенное время Нью-Йорка без зоны), затем hold_time («5m», «1h 3m», «45s»).
 */
import { etWallToMs } from "./dayReport";
import { averagingDownShare, type TradeForRule } from "./rulesEval";
import { num } from "./tradeMath";
import { nyMinutes } from "./tradingDate";

export interface ExecRow { kind: string; price: number; qty: number | null; at: number | null }

/** «5m», «1h 3m», «45s», «2d», «00:05:12» → секунды. */
export function parseHoldTime(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim().toLowerCase();
  const hms = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (hms) return hms[3] != null ? +hms[1] * 3600 + +hms[2] * 60 + +hms[3] : +hms[1] * 60 + +hms[2];
  let total = 0;
  let hit = false;
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m|min|s|sec)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    hit = true;
    const n = Number(m[1]);
    total += m[2] === "d" ? n * 86400 : m[2] === "h" ? n * 3600 : m[2].startsWith("m") ? n * 60 : n;
  }
  return hit ? total : null;
}

function normSide(v: unknown): "long" | "short" | null {
  const s = String(v ?? "").toLowerCase();
  if (s.startsWith("l") || s === "buy") return "long";
  if (s.startsWith("s")) return "short";
  return null;
}

/** row — поля SELECT из lib/rulesEngine.fetchTrades; execs — исполнения сделки по порядку. */
export function mapTradeRow(r: any, execs: ExecRow[] = []): TradeForRule {
  const snap = r.context_snapshot && typeof r.context_snapshot === "object" ? r.context_snapshot : {};
  const entries = execs.filter((e) => e.kind === "entry" || e.kind === "add");
  const exits = execs.filter((e) => e.kind === "trim" || e.kind === "exit" || e.kind === "stop");
  const firstEntry = entries.find((e) => e.at != null)?.at ?? null;
  const lastExit = exits.reduce<number | null>((m, e) => (e.at != null && (m == null || e.at > m) ? e.at : m), null);
  const entryAt = firstEntry ?? etWallToMs(snap.openedAt);
  const exitAt = lastExit ?? etWallToMs(snap.closedAt);
  let holdSec: number | null = entryAt != null && exitAt != null && exitAt >= entryAt ? Math.round((exitAt - entryAt) / 1000) : null;
  if (holdSec == null) holdSec = parseHoldTime(r.hold_time);
  const side = normSide(r.side);
  const fills = execs.length || num(snap.fillCount) || null;
  return {
    id: Number(r.id),
    trader: r.trader ?? null,
    date: String(r.date),
    closeDate: String(r.close_date ?? r.date),
    result: r.result ?? null,
    pnl: num(r.pnl),
    netPnl: num(r.net_pnl),
    signedR: num(r.signed_r),
    entry: num(r.entry),
    stop: num(r.stop),
    qty: num(r.qty),
    riskUsd: num(r.risk_usd),
    horizon: r.horizon === "overnight" || r.horizon === "swing" ? r.horizon : "intraday",
    source: r.source ?? null,
    playbookId: r.playbook_id == null ? null : Number(r.playbook_id),
    setupScore: num(r.setup_score),
    maxNotional: num(r.max_notional),
    checklistRuns: Number(r.checklist_runs ?? 0),
    ticker: r.ticker ? String(r.ticker).toUpperCase() : null,
    side,
    entryAt,
    exitAt,
    entryMin: entryAt != null ? nyMinutes(new Date(entryAt)) : null,
    holdSec,
    execFills: fills,
    avgDownShare: execs.length >= 3 ? averagingDownShare(side, execs) : null,
  };
}

/** Порядок сделок внутри дня — по времени входа (иначе по id): от него зависят серии и «N-я сделка за день». */
export function sortTrades(list: TradeForRule[]): TradeForRule[] {
  return [...list].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ea = a.entryAt ?? Number.MAX_SAFE_INTEGER;
    const eb = b.entryAt ?? Number.MAX_SAFE_INTEGER;
    if (ea !== eb) return ea - eb;
    return a.id - b.id;
  });
}
