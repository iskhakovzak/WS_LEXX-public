/**
 * Daily loop service — DB-backed entry points over the pure engine (lib/daily/engine.ts). Used by routes/daily.ts, the
 * curator queue (lib/daily/costQueue.ts, curatorFocus.ts) and the Telegram bot (lib/daily/telegram*).
 *
 *   focusFor(trader, date)    the focus FOR a day: stored on the first request (table daily_focus); a curator override
 *                             (source "curator") wins; mistakes the trader disputed in the window are skipped
 *   eveningFor(trader, date)  the evening card; once the day is finished its verdict snapshot is stored in
 *                             daily_reviews.verdict (the contract's disciplineDelta feeds next-day discipline)
 *   dailyMe(trader)           phase (lib/curatorLogic tradingPhase), focus, last finished day, tier progress, intraday
 *   markReviewed / setFocusOverride / mistakeCosts / costQueue / checkIntradayContracts
 *
 * Tables: migration 0202_daily_loop.sql. Money is net; dates are New York trading days.
 */
import { pool } from "@workspace/db";
import { addDays, isWeekend, nyDate, nyMinutes } from "../tradingDate";
import { prevTradingDay, tradingPhase } from "../curatorLogic";
import { syncCron } from "../propreports/scheduler";
import { loadBehaviorRows, rowToBehaviorTrade } from "../../routes/behavior";
import {
  analyzeWindow, contractOf, dayTotals, focusOf, focusWindow, pickFocus, tierProgressOf, tradeToReview, verdictOf,
  type WindowAnalysis,
} from "./engine";
import { dayPath, windowDays } from "./detectors";
import { dayFinished, planContractOf, scaleVerdict } from "./discipline";
import { cardRewards, forgetRewards, rewardsFor } from "./rewards";
import { deskTradersOn, inputFor, loadDailyContext, type DailyContext } from "./load";
import { buildCostQueue } from "./costQueue";
import { settingsChangedAt } from "../settings/store";
import type { CostQueueItem, DailyFocus, DailyMe, EveningCard, MistakeCost, MistakeId, TierProgress } from "./types";

type FocusRow = {
  trader: string; date: string; mistake: string | null; cost_net: number | string | null; count: number; days: number;
  window_from: string; window_to: string; source: DailyFocus["source"]; set_by: string | null; updated_at: Date | string;
};
type ReviewRow = { reviewed_at: Date | null; note: string | null; disputed: boolean; disputed_mistake: string | null };

const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function rowToFocus(r: FocusRow): DailyFocus {
  const window = { from: r.window_from, to: r.window_to };
  if (!r.mistake) return focusOf(r.trader, r.date, window, null);
  const days = Number(r.days ?? 0);
  const f = focusOf(r.trader, r.date, window, { id: r.mistake, count: Number(r.count ?? 0), days, costNet: numOrNull(r.cost_net), examples: [] }, r.source);
  // A curator focus with no hits in the window: the line is the mistake's name, not «0 times in 0 days».
  if (!days) f.text = { key: `mistake.${r.mistake}` };
  return f;
}

async function storedFocus(trader: string, date: string): Promise<FocusRow | null> {
  const { rows } = await pool.query<FocusRow>(
    `SELECT trader, date, mistake, cost_net, count, days, window_from, window_to, source, set_by, updated_at FROM daily_focus WHERE trader = $1 AND date = $2`,
    [trader, date],
  );
  return rows[0] ?? null;
}

/** overwrite: "all" (curator / reset), "auto" (refresh an engine row, never a curator's), "none" (first write wins). */
async function saveFocus(f: DailyFocus, days: number, setBy: string | null, overwrite: "all" | "auto" | "none"): Promise<void> {
  await pool.query(
    `INSERT INTO daily_focus (trader, date, mistake, cost_net, count, days, window_from, window_to, source, set_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (trader, date) DO ${overwrite !== "none" ? `UPDATE SET mistake = EXCLUDED.mistake, cost_net = EXCLUDED.cost_net, count = EXCLUDED.count,
       days = EXCLUDED.days, window_from = EXCLUDED.window_from, window_to = EXCLUDED.window_to, source = EXCLUDED.source, set_by = EXCLUDED.set_by, updated_at = now()${overwrite === "auto" ? " WHERE daily_focus.source <> 'curator'" : ""}` : "NOTHING"}`,
    [f.trader, f.date, f.mistake, f.costNet, f.count, days, f.window.from, f.window.to, f.source, setBy],
  );
}

/** Mistakes the trader disputed («not a mistake») on days of [from, to]. */
async function disputedIn(trader: string, from: string, to: string): Promise<Set<MistakeId>> {
  const { rows } = await pool.query<{ m: string | null }>(
    `SELECT DISTINCT disputed_mistake AS m FROM daily_reviews WHERE trader = $1 AND disputed AND date >= $2 AND date <= $3`,
    [trader, from, to],
  );
  return new Set(rows.map((r) => r.m).filter((m): m is string => !!m));
}

async function reviewOf(trader: string, date: string): Promise<ReviewRow | null> {
  const { rows } = await pool.query<ReviewRow>(
    `SELECT reviewed_at, note, disputed, disputed_mistake FROM daily_reviews WHERE trader = $1 AND date = $2`,
    [trader, date],
  );
  return rows[0] ?? null;
}

/** Computes the auto focus for `date` from an already loaded context (does not store). */
async function computeFocus(trader: string, date: string, ctx: DailyContext): Promise<{ focus: DailyFocus; days: number; analysis: WindowAnalysis }> {
  const w = focusWindow(date);
  const analysis = analyzeWindow(inputFor(ctx, w.from, w.to));
  const pick = pickFocus(analysis.costs, await disputedIn(trader, w.from, w.to));
  return { focus: focusOf(trader, date, w, pick), days: pick?.days ?? 0, analysis };
}

/** Focus for `date`, using `ctx` when it already covers the window (eveningFor shares one load). */
async function focusWith(trader: string, date: string, ctx?: DailyContext): Promise<DailyFocus> {
  const stored = await storedFocus(trader, date);
  // An engine row is final once it was computed after its window closed — unless an admin changed the daily-focus
  // settings after that and the day has not passed yet (then it is re-computed); a curator's row always wins.
  if (stored && (stored.source === "curator" || (dayFinished(stored.window_to, new Date(stored.updated_at)) && !settingsNewer(stored)))) return rowToFocus(stored);
  const w = focusWindow(date);
  const c = ctx && ctx.loadedFrom <= w.from && ctx.loadedTo >= w.to ? ctx : await loadDailyContext(trader, w.from, w.to);
  const { focus, days } = await computeFocus(trader, date, c);
  // A window that is not over yet (a focus asked for days ahead) is answered but not frozen.
  if (!dayFinished(w.to)) return focus;
  await saveFocus(focus, days, null, "auto");
  const again = await storedFocus(trader, date);
  return again ? rowToFocus(again) : focus;
}

/** The daily-focus settings changed after this engine row was computed, and its day is today or later. */
function settingsNewer(r: FocusRow): boolean {
  const changed = settingsChangedAt("daily.");
  return !!changed && r.date >= nyDate() && new Date(changed).getTime() > new Date(r.updated_at).getTime();
}

/** Costs of every mistake kind for one trader over [from, to] (NY dates, inclusive), costliest first. */
export async function mistakeCosts(trader: string, from: string, to: string): Promise<MistakeCost[]> {
  const ctx = await loadDailyContext(trader, from, to);
  return analyzeWindow(inputFor(ctx, from, to)).costs;
}

/** The focus for `date` (computed and stored on first request; a curator override wins). */
export async function focusFor(trader: string, date: string): Promise<DailyFocus | null> {
  return focusWith(trader, date);
}

/** Curator override (`mistake`) or back to the engine's pick (`null`). Returns the focus now in force. */
export async function setFocusOverride(trader: string, date: string, mistake: MistakeId | null, by: string): Promise<DailyFocus> {
  const w = focusWindow(date);
  const ctx = await loadDailyContext(trader, w.from, w.to);
  const { focus, days, analysis } = await computeFocus(trader, date, ctx);
  if (mistake == null) {
    await saveFocus(focus, days, null, "all");
    return focus;
  }
  const cost = analysis.costs.find((c) => c.id === mistake) ?? { id: mistake, count: 0, days: 0, costNet: null, examples: [] };
  await saveFocus(focusOf(trader, date, w, cost, "curator"), cost.days, by, "all");
  return rowToFocus({ trader, date, mistake, cost_net: cost.costNet, count: cost.count, days: cost.days, window_from: w.from, window_to: w.to, source: "curator", set_by: by, updated_at: new Date() });
}

/** The evening card for a finished trading day (focus verdict, trade to review, desk same ticker, contract). */
export async function eveningFor(trader: string, date: string): Promise<EveningCard | null> {
  const w = focusWindow(date);
  const ctx = await loadDailyContext(trader, w.from, date);
  const [focus, review] = await Promise.all([focusWith(trader, date, ctx), reviewOf(trader, date)]);
  const a = analyzeWindow(inputFor(ctx, date, date));
  const disputed = !!review?.disputed && (!review.disputed_mistake || review.disputed_mistake === focus.mistake);
  const verdict = focus.mistake ? verdictOf(a, date, focus.mistake, disputed) : null;
  const raw = contractOf(a, date, ctx.plans?.get(date));
  // The day's actual points on the progressive scale (streak bonus / penalty) — lib/daily/discipline.ts.
  const scaled = raw ? await scaleVerdict(trader, raw, ctx.trades).catch(() => null) : null;
  const contract = scaled?.contract ?? raw;
  const review1 = tradeToReview(a, date, focus.mistake);
  const totals = dayTotals(a, date);
  const day = a.tradesByDay.get(date) ?? [];
  const ticker = review1?.ticker ?? mostTraded(day.map((t) => t.ticker));
  const others = ticker ? await deskTradersOn(ticker, date, trader).catch(() => 0) : 0;
  const card: EveningCard = {
    trader, date, trades: totals.trades, netPnl: totals.netPnl, focus: verdict, tradeToReview: review1,
    deskSameTicker: ticker && others > 0 ? { ticker, traders: others } : null,
    contract, reviewed: !!review?.reviewed_at, reviewNote: review?.note ?? null,
  };
  if (dayFinished(date)) {
    if (await saveVerdict(card).catch(() => false)) forgetRewards(trader);
    card.rewards = await cardRewards(trader, date, scaled?.streak ?? null).catch(() => null);
  }
  return card;
}

function mostTraded(tickers: readonly string[]): string | null {
  const n = new Map<string, number>();
  for (const t of tickers) if (t) n.set(t, (n.get(t) ?? 0) + 1);
  let best: string | null = null;
  for (const [t, c] of n) if (best == null || c > (n.get(best) ?? 0)) best = t;
  return best;
}

/** Stores the finished day's snapshot; true when it changed. */
async function saveVerdict(card: EveningCard): Promise<boolean> {
  const snapshot = JSON.stringify({ trades: card.trades, netPnl: card.netPnl, focus: card.focus, contract: card.contract, tradeToReview: card.tradeToReview });
  const res = await pool.query(
    `INSERT INTO daily_reviews (trader, date, verdict, verdict_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (trader, date) DO UPDATE SET verdict = EXCLUDED.verdict, verdict_at = now(), updated_at = now()
      WHERE daily_reviews.verdict IS DISTINCT FROM EXCLUDED.verdict`,
    [card.trader, card.date, snapshot],
  );
  return (res.rowCount ?? 0) > 0;
}

function nextWeekday(date: string): string {
  let d = date;
  do d = addDays(d, 1); while (isWeekend(d));
  return d;
}

async function tierProgress(trader: string, today: string): Promise<TierProgress | null> {
  try {
    const { evaluateTraderNow } = await import("../../routes/scaling");
    return tierProgressOf(await evaluateTraderNow(trader, today));
  } catch {
    return null;
  }
}

/** Everything the dashboard / bot shows for a trader right now. */
export async function dailyMe(trader: string): Promise<DailyMe | null> {
  const now = new Date();
  const today = nyDate(now);
  const phase = tradingPhase(today, nyMinutes(now));
  const focusDate = phase === "weekend" ? nextWeekday(today) : today;
  const eveningDate = phase === "afterclose" ? today : prevTradingDay(today);
  const [focus, evening, progress] = await Promise.all([
    focusFor(trader, focusDate),
    eveningFor(trader, eveningDate),
    tierProgress(trader, today),
  ]);
  const rewards = await rewardsFor(trader, now);
  return { today, phase, focus, evening, progress, intraday: syncCron() != null, discipline: rewards?.discipline ?? null, badges: rewards?.badges ?? [] };
}

/** Marks the day reviewed (optional one-line note); `dispute` = «the focus hit was not a mistake». */
export async function markReviewed(trader: string, date: string, opts: { note?: string | null; dispute?: boolean } = {}): Promise<void> {
  let disputedMistake: string | null = null;
  if (opts.dispute) disputedMistake = (await storedFocus(trader, date))?.mistake ?? (await focusFor(trader, date))?.mistake ?? null;
  const hasNote = opts.note !== undefined;
  const note = typeof opts.note === "string" ? opts.note.trim().slice(0, 500) || null : null;
  await pool.query(
    `INSERT INTO daily_reviews (trader, date, reviewed_at, note, disputed, disputed_mistake)
     VALUES ($1, $2, now(), $3, $4, $5)
     ON CONFLICT (trader, date) DO UPDATE SET
       reviewed_at = COALESCE(daily_reviews.reviewed_at, now()),
       note = CASE WHEN $6 THEN EXCLUDED.note ELSE daily_reviews.note END,
       disputed = daily_reviews.disputed OR EXCLUDED.disputed,
       disputed_mistake = COALESCE(EXCLUDED.disputed_mistake, daily_reviews.disputed_mistake),
       updated_at = now()`,
    [trader, date, note, disputedMistake != null, disputedMistake, hasNote],
  );
  forgetRewards(trader); // the review run may have reached its badge
}

/** Desk-wide cost ranking for the curator queue (traders the viewer may see). Owned by lib/daily/costQueue.ts. */
export async function costQueue(traders: readonly string[], date: string): Promise<CostQueueItem[]> {
  return buildCostQueue(traders, date, { eveningFor });
}

/**
 * Intraday own-contract check for DAILY Telegram alerts (after each scheduled PropReports sync): traders whose plan for
 * `date` sets a daily stop / max trades and who reached it — max_loss: worst cumulative realised net ≤ −limit
 * (actual = that net, ≤ 0); max_trades: trades of the day (open ones included) ≥ limit.
 */
export async function checkIntradayContracts(date: string): Promise<{ trader: string; kind: "max_loss" | "max_trades"; limit: number; actual: number }[]> {
  const { rows: plans } = await pool
    .query<{ trader: string; doc: unknown }>(
      `SELECT trader, doc FROM trader_plans WHERE date = $1 AND deleted_at IS NULL AND (doc ? 'maxLossUsd' OR doc ? 'maxTrades')`,
      [date],
    )
    .catch(() => ({ rows: [] as { trader: string; doc: unknown }[] }));
  const contracts = new Map(plans.map((p) => [String(p.trader), planContractOf(p.doc)]));
  const traders = [...contracts].filter(([, c]) => (c.maxLossUsd ?? 0) > 0 || c.maxTrades != null).map(([t]) => t);
  if (!traders.length) return [];
  const rows = await loadBehaviorRows(null, date, date, undefined, traders);
  const byTrader = new Map<string, ReturnType<typeof rowToBehaviorTrade>[]>();
  for (const r of rows) {
    const k = String(r.trader);
    (byTrader.get(k) ?? byTrader.set(k, []).get(k)!).push(rowToBehaviorTrade(r));
  }
  const out: { trader: string; kind: "max_loss" | "max_trades"; limit: number; actual: number }[] = [];
  for (const trader of traders) {
    const c = contracts.get(trader)!;
    const all = byTrader.get(trader) ?? [];
    if (c.maxLossUsd != null && c.maxLossUsd > 0) {
      const trough = dayPath(windowDays(all, date, date).get(date) ?? []).trough;
      if (trough <= -c.maxLossUsd) out.push({ trader, kind: "max_loss", limit: c.maxLossUsd, actual: trough });
    }
    if (c.maxTrades != null && c.maxTrades >= 0 && all.length >= c.maxTrades && all.length > 0) {
      out.push({ trader, kind: "max_trades", limit: c.maxTrades, actual: all.length });
    }
  }
  return out;
}
