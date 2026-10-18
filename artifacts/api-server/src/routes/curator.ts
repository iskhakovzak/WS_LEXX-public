/**
 * «Кабинет куратора» — агрегирующие эндпоинты (только чтение чужих таблиц) + приватные заметки персонала.
 *
 *   GET  /curator/today                 ?scope=mine|desk&date=&old=1 — фаза дня, кто торгует, риск, нет плана / не закрыт день,
 *                                       общая очередь разборов (EOD + недельные + задания Академии + нарушения;
 *                                       по умолчанию за последние 14 дн., old=1 — со старыми; важное и свежее сверху),
 *                                       просроченные договорённости 1:1, приоритетные «следующие шаги», byCost (lib/daily/costQueue)
 *   GET  /curator/traders               ?scope=mine|desk — карточка на трейдера: тренд 4 нед., дисциплина, риск, тир/ступень,
 *                                       последний разбор, 1:1, нарушения, последняя заметка, следующий шаг
 *   GET  /curator/trader/:name          профиль: карточка + лимиты/метрики, нарушения с разбором, дни EOD, недели,
 *                                       Академия (договорённости, 1:1 без приватных заметок, цели ИПР), заметки, focus (lib/daily/curatorFocus)
 *   GET  /curator/notes?trader=         заметки о трейдере (персонал; трейдер не видит)
 *   POST /curator/notes                 {trader, body, kind?, pinned?}
 *   PATCH /curator/notes/:id            {body?, kind?, pinned?}
 *   POST /curator/notes/:id/archive     мягкое удаление
 *   POST /curator/notes/:id/restore     отмена архивации (в течение суток)
 *   POST /curator/queue/restore         {ids} — вернуть элементы, убранные «архивировать старые»
 *   POST /curator/queue/archive-old     {scope?, olderThanDays?} — мягко скрыть из очереди элементы старше N дн. (curator_queue_acks)
 *
 * Доступ: journal.review (куратор / админ); ?scope=mine — подопечные (assigned_*), иначе весь деск в пределах readScope.
 * Необязательные таблицы (планы, EOD, недельные, Академия) читаются с catch → пустые данные, если модуль ещё не создан.
 */
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { nyDate, nyMinutes, addDays } from "../lib/tradingDate";
import { can, readScope, requireCap } from "../lib/permissions";
import { logAudit } from "../lib/audit";
import { ensureCuratorTables, rowToBreachReview, rowToNote } from "../lib/curatorStore";
import {
  QUEUE_DEFAULT_DAYS, arrangeQueue, mondayOf, nextActionFor, prevTradingDay, stageLabel, staleQueueIds, tradingPhase,
  trendDirection, weeklyTrend, type NextAction, type QueueKind, type WeekPoint,
} from "../lib/curatorLogic";
import { breachKindLabel, deskSnapshot, templateStatus, type DeskSnapshotRow } from "./risk";
import { ensureNameLatin } from "../lib/peopleDirectory";
import { AppError, badRequest, forbidden, notFound } from "../lib/http";
import { langOf, type Lang } from "../i18n";
import { riskT } from "../i18n/ns";
import { fmtDateFor } from "../i18n/format";
import { buildCostQueue } from "../lib/daily/costQueue";
import { eveningFor } from "../lib/daily/service";
import { curatorFocusFor } from "../lib/daily/curatorFocus";

const router: IRouter = Router();

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function clientDate(raw: unknown): string {
  return typeof raw === "string" && YMD_RE.test(raw) ? raw : nyDate();
}

/** Read from an optional module's table: any SQL error (table not created yet) → no rows. */
async function safe<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    const { rows } = await pool.query(sql, params);
    return rows as T[];
  } catch {
    return [];
  }
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const hoursSince = (v: unknown, now: number): number | null => (v ? Math.max(0, Math.round(((now - new Date(v as string).getTime()) / 3_600_000) * 10) / 10) : null);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 10) / 10 : null);

// ─── roster ─────────────────────────────────────────────────────────────────

type Roster = { traders: string[]; scope: "mine" | "desk"; wards: string[] };

async function loadRoster(req: Request, wanted: unknown): Promise<Roster> {
  const me = req.authUser!.name;
  const [users, readable] = await Promise.all([
    safe<{ name: string; role: string; ac: string | null; am: string | null; ar: string | null }>(
      `SELECT name, role, assigned_curator AS ac, assigned_mentor AS am, assigned_risk_manager AS ar
         FROM users WHERE active = true AND COALESCE(banned, false) = false`,
    ),
    readScope(req, "journal.review"),
  ]);
  let traders = users.filter((u) => u.role === "trader").map((u) => u.name);
  if (readable !== null) traders = traders.filter((t) => readable.includes(t));
  const wards = traders.filter((t) => {
    const u = users.find((x) => x.name === t);
    return !!u && (u.ac === me || u.am === me || u.ar === me);
  });
  const scope: "mine" | "desk" = wanted === "desk" ? "desk" : wanted === "mine" ? "mine" : wards.length ? "mine" : "desk";
  const list = scope === "mine" && wards.length ? wards : scope === "mine" ? [] : traders;
  return { traders: list.sort((a, b) => a.localeCompare(b, "ru")), scope, wards };
}

// ─── per-trader signals ─────────────────────────────────────────────────────

export type TraderSignal = {
  trader: string;
  stage: { key: string | null; label: string | null; since: string | null };
  tier: string | null;
  tierName: string | null;
  risk: {
    status: string; state: string; label: string; message: string; halted: boolean; nearStop: boolean;
    dailyPct: number | null; weeklyPct: number | null; drawdownPct: number | null;
    todayPnl: number | null; todayTrades: number; weekPnl: number | null; openPositions: number;
    hasLimits: boolean; templateDrift: string[];
  };
  trend: WeekPoint[];
  trendDir: "up" | "down" | "flat" | "none";
  discipline: { value: number | null; eodAvg: number | null; ratingAvg: number | null; n: number };
  /** today: null = no plan; available=false — the game-plan module is not set up on this server (do not flag). */
  plan: { today: "ready" | "draft" | null; available: boolean };
  eod: { prevDay: string; prevTraded: boolean; prevClosed: boolean; todayTraded: boolean; todayClosed: boolean; pending: number; lastClosed: string | null; lastReviewedAt: string | null; lastScore: number | null };
  weekly: { currentStatus: string | null; submittedPending: boolean; lastReviewedWeek: string | null; lastReviewedAt: string | null };
  academy: { openActions: number; overdueActions: number; lastOneOnOne: string | null; daysSinceOneOnOne: number | null; pendingSubmissions: number; activeGoals: number };
  /** week — breach alerts since Monday (NY). */
  breaches: { unreviewed: number; last30: number; week: number; lastDate: string | null };
  lastNote: { body: string; author: string; createdAt: string } | null;
  lastTradeDate: string | null;
  nextAction: NextAction;
  /** users.assigned_curator — the trader's group («Группа» = traders of one curator); null = «Без куратора». */
  curator: string | null;
  /** users.name_latin — optional Latin alias for cross-script search. */
  nameLatin: string | null;
  /** Calendar month to date (NY trading days): net P&L (null = no $ data) and trades. */
  month: { pnl: number | null; trades: number };
  /** Latest sign of life: activity log, closed day, weekly report or trade day (ISO / YYYY-MM-DD). */
  lastActivityAt: string | null;
};

type Bulk = Awaited<ReturnType<typeof loadBulk>>;

/** `lang` = the reader's language of generated labels (stop texts, stage names, next steps, queue titles). */
async function loadBulk(traders: string[], today: string, lang: Lang = "ru") {
  await ensureCuratorTables();
  const prev = prevTradingDay(today);
  const from35 = addDays(today, -35);
  const from42 = addDays(today, -42);
  const from30 = addDays(today, -29);
  await ensureNameLatin().catch(() => undefined);
  const [plansTable, desk, tpl, plans, eodRows, eodPendingAll, weekly, subsAll, actions, meetings, stages, enrolls, ratings, breaches, notes, goals, ackRows, people, activity] = await Promise.all([
    safe<{ ok: boolean }>(`SELECT to_regclass('public.trader_plans') IS NOT NULL AS ok`),
    deskSnapshot(today, null, lang),
    templateStatus(traders, lang),
    safe(`SELECT trader, status FROM trader_plans WHERE date = $1 AND deleted_at IS NULL AND trader = ANY($2)`, [today, traders]),
    safe(`SELECT id, trader, date, closed_at, reviewed_at, discipline, curator_score FROM eod_days WHERE date >= $1 AND trader = ANY($2)`, [from35, traders]),
    safe(`SELECT id, trader, date, closed_at FROM eod_days WHERE closed_at IS NOT NULL AND reviewed_at IS NULL AND trader = ANY($1) ORDER BY closed_at DESC LIMIT 500`, [traders]),
    safe(`SELECT id, trader, week, TO_CHAR(week_start, 'YYYY-MM-DD') AS week_start, status, submitted_at, reviewed_at FROM weekly_reviews
           WHERE trader = ANY($1) AND (week_start >= $2::date OR status = 'submitted') ORDER BY week_start DESC`, [traders, from42]),
    safe(`SELECT s.id, s.user_name, s.created_at, a.title FROM academy_submissions s JOIN academy_assignments a ON a.id = s.assignment_id
           WHERE s.status = 'submitted' AND s.archived_at IS NULL AND s.user_name = ANY($1) ORDER BY s.created_at DESC LIMIT 500`, [traders]),
    safe(`SELECT id, student, owner, title, TO_CHAR(due_on, 'YYYY-MM-DD') AS due_on, status FROM academy_action_items
           WHERE archived_at IS NULL AND status = 'open' AND student = ANY($1) ORDER BY due_on ASC NULLS LAST`, [traders]),
    safe(`SELECT student, MAX(met_at) AS last FROM academy_one_on_ones WHERE archived_at IS NULL AND student = ANY($1) GROUP BY student`, [traders]),
    safe(`SELECT user_name, stage, since FROM academy_trader_stage WHERE user_name = ANY($1)`, [traders]),
    safe(`SELECT DISTINCT ON (user_name) user_name, stage FROM academy_enrollments WHERE archived_at IS NULL AND status = 'active' AND user_name = ANY($1) ORDER BY user_name, updated_at DESC`, [traders]),
    safe(`SELECT trader, discipline, overall FROM trader_ratings WHERE created_at >= NOW() - INTERVAL '42 days' AND trader = ANY($1)`, [traders]),
    safe(`SELECT a.id, a.trader, a.date, a.kind, a.message, a.created_at, r.id AS review_id FROM risk_alert_log a
           LEFT JOIN risk_breach_reviews r ON r.alert_id = a.id AND r.archived_at IS NULL
           WHERE a.level = 'breach' AND a.date >= $1 AND a.trader = ANY($2) ORDER BY a.date DESC`, [from30, traders]),
    safe(`SELECT DISTINCT ON (trader) trader, body, author, created_at FROM curator_notes WHERE archived_at IS NULL AND trader = ANY($1) ORDER BY trader, pinned DESC, created_at DESC`, [traders]),
    safe(`SELECT student, COUNT(*)::int AS n FROM academy_idp_goals WHERE archived_at IS NULL AND status = 'active' AND student = ANY($1) GROUP BY student`, [traders]),
    safe<{ item_id: string }>(`SELECT item_id FROM curator_queue_acks WHERE revoked_at IS NULL AND trader = ANY($1)`, [traders]),
    safe<{ name: string; ac: string | null; latin: string | null }>(`SELECT name, assigned_curator AS ac, name_latin AS latin FROM users WHERE name = ANY($1)`, [traders]),
    safe<{ trader: string; at: Date }>(`SELECT trader, MAX(created_at) AS at FROM activity_log WHERE trader = ANY($1) GROUP BY trader`, [traders]),
  ]);
  // Элементы, мягко убранные из очереди («архивировать старые»), не считаются ожидающими разбора.
  const acked = new Set(ackRows.map((r) => String(r.item_id)));
  const eodPending = eodPendingAll.filter((e: any) => !acked.has(`eod:${e.id}`));
  const subs = subsAll.filter((x: any) => !acked.has(`academy:${x.id}`));
  const peopleBy = new Map(people.map((p) => [p.name, p]));
  const activityBy = new Map(activity.map((a) => [a.trader, iso(a.at)]));
  return { lang, today, prev, plansAvailable: plansTable[0]?.ok === true, desk, tpl, plans, eodRows, eodPending, weekly, subs, actions, meetings, stages, enrolls, ratings, breaches, notes, goals, acked, peopleBy, activityBy };
}

function buildSignal(name: string, b: Bulk): TraderSignal {
  const { today, prev } = b;
  const row: DeskSnapshotRow | undefined = b.desk.rows.find((r) => r.trader === name);
  const m = row?.metrics;
  const tpl = b.tpl.get(name);
  const days = row?.days ?? [];
  const trend = weeklyTrend(days, today, 4);

  const eod = b.eodRows.filter((e: any) => e.trader === name);
  const closedEod = eod.filter((e: any) => e.closed_at);
  const eodDisc = closedEod.map((e: any) => (e.discipline == null ? null : Number(e.discipline) * 2)).filter((v): v is number => v != null);
  const ratingDisc = b.ratings.filter((r: any) => r.trader === name).map((r: any) => Number(r.discipline)).filter((v) => Number.isFinite(v));
  const lastReviewed = [...eod].filter((e: any) => e.reviewed_at).sort((x: any, y: any) => String(y.reviewed_at).localeCompare(String(x.reviewed_at)))[0];
  const lastClosed = [...closedEod].sort((x: any, y: any) => String(y.date).localeCompare(String(x.date)))[0];
  const traded = (d: string) => days.some((x) => x.date === d && x.trades > 0);
  const closed = (d: string) => eod.some((e: any) => e.date === d && e.closed_at);

  const wk = b.weekly.filter((w: any) => w.trader === name);
  const thisWeek = wk.find((w: any) => w.week_start === mondayOf(today));
  const lastRevWeek = wk.filter((w: any) => w.status === "reviewed").sort((x: any, y: any) => String(y.week_start).localeCompare(String(x.week_start)))[0];

  const acts = b.actions.filter((a: any) => a.student === name);
  const overdue = acts.filter((a: any) => a.due_on && a.due_on < today);
  const lastMeet = b.meetings.find((x: any) => x.student === name)?.last ?? null;
  const lastMeetDate = lastMeet ? nyDate(new Date(lastMeet)) : null;
  const daysSince1on1 = lastMeetDate ? daysBetween(lastMeetDate, today) : null;

  const br = b.breaches.filter((x: any) => x.trader === name);
  const unreviewed = br.filter((x: any) => x.review_id == null).length;
  const note = b.notes.find((n: any) => n.trader === name);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthDays = days.filter((d) => d.date >= monthStart && d.date <= today);
  const monthPriced = monthDays.filter((d) => d.pnl != null);
  const weekStart = mondayOf(today);
  const lastActivityAt = [
    b.activityBy.get(name) ?? null,
    maxIso(eod.map((e: any) => e.closed_at)),
    maxIso(wk.map((w: any) => w.submitted_at)),
    row?.lastTradeDate ? `${row.lastTradeDate}T21:00:00.000Z` : null,
  ].filter((v): v is string => !!v).sort().pop() ?? null;

  const st = b.stages.find((s: any) => s.user_name === name);
  const en = b.enrolls.find((s: any) => s.user_name === name);
  const stageKey: string | null = st?.stage ?? en?.stage ?? (tpl?.tier && stageLabel(tpl.tier) ? tpl.tier : null);

  const planRow = b.plans.find((p: any) => p.trader === name);
  const weekday = tradingPhase(today, 0) !== "weekend";
  const pendingEod = b.eodPending.filter((e: any) => e.trader === name).length;
  const hasLimits = tpl?.hasLimits ?? false;

  const signalBase = {
    trader: name,
    stage: { key: stageKey, label: stageKey ? stageLabel(stageKey, b.lang) ?? stageKey : null, since: st?.since ?? null },
    tier: tpl?.tier ?? null,
    tierName: tpl?.tierName ?? null,
    risk: {
      status: m?.status ?? "no_limits", state: m?.stop.state ?? "no_limits", label: m?.stop.label ?? riskT.tFor(b.lang)("stop.no_limits.label"), message: m?.stop.message ?? "",
      halted: m?.stop.halted ?? false, nearStop: m?.stop.state === "warn",
      dailyPct: m?.stop.dailyPct ?? null, weeklyPct: m?.stop.weeklyPct ?? null, drawdownPct: m?.stop.drawdownPct ?? null,
      todayPnl: m?.today.pnlNet ?? null, todayTrades: m?.today.trades ?? 0, weekPnl: m?.week.pnlNet ?? null, openPositions: m?.today.openPositions ?? 0,
      hasLimits, templateDrift: (tpl?.drift ?? []).map((d) => d.label),
    },
    trend,
    trendDir: trendDirection(trend),
    discipline: { value: avg([...eodDisc, ...ratingDisc]), eodAvg: avg(eodDisc.map((v) => v / 2)), ratingAvg: avg(ratingDisc), n: eodDisc.length + ratingDisc.length },
    plan: { today: planRow ? (planRow.status === "ready" ? "ready" as const : "draft" as const) : null, available: b.plansAvailable },
    eod: {
      prevDay: prev, prevTraded: traded(prev), prevClosed: closed(prev), todayTraded: traded(today), todayClosed: closed(today),
      pending: pendingEod, lastClosed: lastClosed?.date ?? null, lastReviewedAt: iso(lastReviewed?.reviewed_at), lastScore: lastReviewed?.curator_score ?? null,
    },
    weekly: {
      currentStatus: thisWeek?.status ?? null,
      submittedPending: wk.some((w: any) => w.status === "submitted"),
      lastReviewedWeek: lastRevWeek?.week ?? null,
      lastReviewedAt: iso(lastRevWeek?.reviewed_at),
    },
    academy: {
      openActions: acts.length, overdueActions: overdue.length, lastOneOnOne: lastMeetDate, daysSinceOneOnOne: daysSince1on1,
      pendingSubmissions: b.subs.filter((s: any) => s.user_name === name).length,
      activeGoals: Number(b.goals.find((g: any) => g.student === name)?.n ?? 0),
    },
    breaches: { unreviewed, last30: new Set(br.map((x: any) => x.date)).size, week: br.filter((x: any) => String(x.date) >= weekStart).length, lastDate: br[0]?.date ?? null },
    lastNote: note ? { body: String(note.body).slice(0, 280), author: String(note.author), createdAt: iso(note.created_at)! } : null,
    lastTradeDate: row?.lastTradeDate ?? null,
    curator: b.peopleBy.get(name)?.ac ?? null,
    nameLatin: b.peopleBy.get(name)?.latin ?? null,
    month: { pnl: monthPriced.length ? Math.round(monthPriced.reduce((a, d) => a + (d.pnl ?? 0), 0) * 100) / 100 : null, trades: monthDays.reduce((a, d) => a + d.trades, 0) },
    lastActivityAt,
  };
  const nextAction = nextActionFor({
    trader: name,
    halted: signalBase.risk.halted,
    nearStop: signalBase.risk.nearStop,
    unreviewedBreaches: unreviewed,
    eodPending: pendingEod,
    weeklySubmitted: signalBase.weekly.submittedPending,
    overdueActions: overdue.length,
    hasLimits,
    templateDrift: signalBase.risk.templateDrift.length,
    missingPlan: b.plansAvailable && weekday && !planRow && today === nyDate() && tradingPhase(today, nyMinutes()) !== "afterclose",
    missingEod: signalBase.eod.prevTraded && !signalBase.eod.prevClosed,
    daysSinceOneOnOne: daysSince1on1,
  }, b.lang);
  return { ...signalBase, nextAction };
}

/** Latest timestamp of a list (Date / ISO / null) as ISO. */
function maxIso(values: unknown[]): string | null {
  return values.map(iso).filter((v): v is string => !!v).sort().pop() ?? null;
}

// ─── очередь разборов ───────────────────────────────────────────────────────

/** `date` — торговый день / неделя элемента; `eodId` — id дня (eod_days) для разбора прямо в кабинете. */
type QueueRaw = { kind: QueueKind; id: string; trader: string; title: string; since: string | null; hoursWaiting: number | null; href: string; date?: string | null; eodId?: number };

function buildQueueItems(b: Bulk, now: number): QueueRaw[] {
  const t = riskT.tFor(b.lang);
  const day = (d: unknown) => fmtDateFor(b.lang, String(d), "dayMonth");
  return [
    ...b.eodPending.map((e: any) => ({
      kind: "eod" as const, id: `eod:${e.id}`, trader: String(e.trader), title: t("queue.eod", { date: day(e.date) }),
      since: iso(e.closed_at), hoursWaiting: hoursSince(e.closed_at, now),
      href: `/journal?date=${encodeURIComponent(String(e.date))}&trader=${encodeURIComponent(String(e.trader))}`,
      date: String(e.date), eodId: Number(e.id),
    })),
    ...b.weekly.filter((w: any) => w.status === "submitted").map((w: any) => ({
      kind: "weekly" as const, id: `weekly:${w.id}`, trader: String(w.trader), title: t("queue.weekly", { week: String(w.week) }),
      since: iso(w.submitted_at), hoursWaiting: hoursSince(w.submitted_at, now), date: w.week_start ? String(w.week_start) : null,
      href: `/weekly-review?view=curator&trader=${encodeURIComponent(String(w.trader))}&week=${encodeURIComponent(String(w.week))}`,
    })),
    ...b.subs.map((s: any) => ({
      kind: "academy" as const, id: `academy:${s.id}`, trader: String(s.user_name), title: t("queue.academy", { title: String(s.title).slice(0, 80) }),
      since: iso(s.created_at), hoursWaiting: hoursSince(s.created_at, now), href: "/academy/mentor",
    })),
    ...b.breaches.filter((x: any) => x.review_id == null).map((x: any) => ({
      // Тип «Нарушение» уже на плашке строки — в заголовке только что и когда.
      kind: "breach" as const, id: `breach:${x.id}`, trader: String(x.trader), title: t("queue.breach", { kind: breachKindLabel(String(x.kind), b.lang), date: day(x.date) }), date: String(x.date),
      since: iso(breachSince(x)), hoursWaiting: hoursSince(breachSince(x), now), href: `/curator?trader=${encodeURIComponent(String(x.trader))}&tab=risk`,
    })),
  ];
}

/** Нарушение ждёт разбора с конца своего торгового дня; created_at — время записи (у бэкфилла это «сейчас»). */
function breachSince(x: { date?: unknown; created_at?: unknown }): string | null {
  const created = x.created_at ? new Date(x.created_at as string).toISOString() : null;
  const day = typeof x.date === "string" && YMD_RE.test(x.date) ? `${x.date}T21:00:00.000Z` : null; // ~17:00 NY
  if (!created) return day;
  return day && day < created ? day : created;
}

// ─── today ──────────────────────────────────────────────────────────────────

router.get("/curator/today", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "journal.review"))) return;
  const today = clientDate(req.query.date);
  const roster = await loadRoster(req, req.query.scope);
  // byCost — the queue by money (lib/daily/costQueue), loaded alongside the bulk in one round.
  const [b, byCost] = await Promise.all([loadBulk(roster.traders, today, langOf(req)), buildCostQueue(roster.traders, today, { eveningFor })]);
  const signals = roster.traders.map((t) => buildSignal(t, b));
  const phase = tradingPhase(today, today === nyDate() ? nyMinutes() : today < nyDate() ? 17 * 60 : 0);
  const now = Date.now();
  const weekday = phase !== "weekend";

  const includeOld = req.query.old === "1" || req.query.old === "true";
  const arranged = arrangeQueue(buildQueueItems(b, now), { includeOld, acked: b.acked });
  const queue = arranged.items;

  const overdueActions = b.actions
    .filter((a: any) => a.due_on && a.due_on < today)
    .map((a: any) => ({ id: Number(a.id), trader: String(a.student), title: String(a.title), dueOn: String(a.due_on), owner: String(a.owner), daysOverdue: daysBetween(String(a.due_on), today) }))
    .sort((x, y) => y.daysOverdue - x.daysOverdue);

  const trading = signals
    .filter((s) => s.risk.todayTrades > 0 || s.risk.openPositions > 0)
    .map((s) => ({ trader: s.trader, trades: s.risk.todayTrades, pnlNet: s.risk.todayPnl, openPositions: s.risk.openPositions, state: s.risk.state, dailyPct: s.risk.dailyPct }))
    .sort((x, y) => (x.pnlNet ?? 0) - (y.pnlNet ?? 0));

  const riskBrief = (s: TraderSignal) => ({ trader: s.trader, state: s.risk.state, label: s.risk.label, message: s.risk.message, pnlNet: s.risk.todayPnl, dailyPct: s.risk.dailyPct, weeklyPct: s.risk.weeklyPct, drawdownPct: s.risk.drawdownPct });
  const missingPlan = weekday && b.plansAvailable ? signals.filter((s) => s.plan.today !== "ready").map((s) => ({ trader: s.trader, status: s.plan.today })) : [];
  const missingEod = signals.filter((s) => s.eod.prevTraded && !s.eod.prevClosed).map((s) => ({ trader: s.trader, date: s.eod.prevDay }));
  const openToday = phase === "afterclose" ? signals.filter((s) => s.eod.todayTraded && !s.eod.todayClosed).map((s) => ({ trader: s.trader, date: today })) : [];
  const nextActions = signals
    .filter((s) => s.nextAction.kind !== "none")
    .map((s) => ({ trader: s.trader, ...s.nextAction }))
    .sort((x, y) => y.priority - x.priority || x.trader.localeCompare(y.trader, "ru"));

  res.json({
    date: today,
    prevDay: b.prev,
    phase,
    nyMinutes: nyMinutes(),
    scope: roster.scope,
    wards: roster.wards.length,
    traders: roster.traders,
    plansAvailable: b.plansAvailable,
    counts: {
      traders: roster.traders.length,
      trading: trading.length,
      halted: signals.filter((s) => s.risk.halted).length,
      nearStop: signals.filter((s) => s.risk.nearStop).length,
      noLimits: signals.filter((s) => !s.risk.hasLimits).length,
      missingPlan: missingPlan.length,
      missingEod: missingEod.length,
      queue: queue.length,
      queueOverdue: queue.filter((q) => q.overdue).length,
      queueOld: arranged.old.count,
      queueOldOverdue: arranged.old.overdue,
      overdueActions: overdueActions.length,
    },
    trading,
    risk: {
      halted: signals.filter((s) => s.risk.halted).map(riskBrief),
      nearStop: signals.filter((s) => s.risk.nearStop).map(riskBrief),
      noLimits: signals.filter((s) => !s.risk.hasLimits).map((s) => s.trader),
    },
    missingPlan,
    missingEod,
    openToday,
    queue,
    queueWindow: { days: QUEUE_DEFAULT_DAYS, includeOld, old: arranged.old.count, oldOverdue: arranged.old.overdue },
    overdueActions,
    nextActions,
    byCost,
  });
}));

const archiveOldSchema = z.object({
  scope: z.enum(["mine", "desk"]).optional(),
  olderThanDays: z.number().int().min(1).max(365).optional(),
});

/** «Архивировать старые»: мягко скрыть из очереди всё старше N дней. Исходные дни/отчёты/задания не меняются. */
router.post("/curator/queue/archive-old", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "journal.review"))) return;
  const parsed = archiveOldSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest();
  const days = parsed.data.olderThanDays ?? QUEUE_DEFAULT_DAYS;
  const roster = await loadRoster(req, parsed.data.scope);
  const b = await loadBulk(roster.traders, nyDate(), langOf(req));
  const items = buildQueueItems(b, Date.now());
  const ids = new Set(staleQueueIds(items, days, b.acked));
  const stale = items.filter((q) => ids.has(q.id));
  if (stale.length) {
    await pool.query(
      `INSERT INTO curator_queue_acks (item_id, trader, kind, acked_by)
       SELECT t.item_id, t.trader, t.kind, $4::text FROM UNNEST($1::text[], $2::text[], $3::text[]) AS t(item_id, trader, kind)
       ON CONFLICT (item_id) DO UPDATE SET acked_by = EXCLUDED.acked_by, acked_at = NOW(), revoked_at = NULL`,
      [stale.map((q) => q.id), stale.map((q) => q.trader), stale.map((q) => q.kind), req.authUser!.name],
    );
  }
  const byKind: Record<string, number> = {};
  for (const q of stale) byKind[q.kind] = (byKind[q.kind] ?? 0) + 1;
  await logAudit({ actor: req.authUser!.name, action: "curator.queue.archive_old", targetType: "curator_queue_acks", details: { olderThanDays: days, archived: stale.length, byKind, scope: roster.scope } });
  res.json({ archived: stale.length, byKind, olderThanDays: days, ids: stale.map((q) => q.id) });
}));

const restoreSchema = z.object({ ids: z.array(z.string().regex(/^(eod|weekly|academy|breach):\d{1,12}$/)).min(1).max(5000) });

/** «Отменить» после «архивировать старые»: вернуть элементы в очередь (revoked_at), только в пределах доступных трейдеров. */
router.post("/curator/queue/restore", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "journal.review"))) return;
  const parsed = restoreSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest();
  await ensureCuratorTables();
  const readable = await readScope(req, "journal.review");
  const { rowCount } = await pool.query(
    `UPDATE curator_queue_acks SET revoked_at = NOW()
      WHERE item_id = ANY($1::text[]) AND revoked_at IS NULL AND ($2::text[] IS NULL OR trader = ANY($2::text[]))`,
    [parsed.data.ids, readable],
  );
  await logAudit({ actor: req.authUser!.name, action: "curator.queue.restore", targetType: "curator_queue_acks", details: { restored: rowCount ?? 0 } });
  res.json({ restored: rowCount ?? 0 });
}));

// ─── traders ────────────────────────────────────────────────────────────────

router.get("/curator/traders", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "journal.review"))) return;
  const today = clientDate(req.query.date);
  const roster = await loadRoster(req, req.query.scope);
  const b = await loadBulk(roster.traders, today, langOf(req));
  res.json({ date: today, scope: roster.scope, wards: roster.wards.length, traders: roster.traders.map((t) => buildSignal(t, b)) });
}));

router.get("/curator/trader/:name", asyncHandler(async (req, res): Promise<void> => {
  const name = String(req.params.name ?? "").trim();
  if (!name || name.length > 100) throw badRequest("INVALID_TRADER");
  if (!(await requireCap(req, res, "journal.review", { trader: name }))) return;
  const { rows: u } = await pool.query(`SELECT name, role, assigned_curator, assigned_mentor, assigned_risk_manager FROM users WHERE name = $1 LIMIT 1`, [name]);
  if (!u[0]) throw notFound("TRADER_NOT_FOUND");
  const today = clientDate(req.query.date);
  const b = await loadBulk([name], today, langOf(req));
  const signal = buildSignal(name, b);
  const row = b.desk.rows.find((r) => r.trader === name);
  const from90 = addDays(today, -89);
  const [breaches, eodDays, weeks, actions, meetings, goals, notes, limitEvents, focus] = await Promise.all([
    safe(`SELECT a.id, a.date, a.kind, a.used::float AS used, a."limit"::float AS "limit", a.message, a.created_at,
                 CASE WHEN r.id IS NULL THEN NULL ELSE row_to_json(r.*) END AS review
            FROM risk_alert_log a LEFT JOIN risk_breach_reviews r ON r.alert_id = a.id AND r.archived_at IS NULL
           WHERE a.level = 'breach' AND a.trader = $1 AND a.date >= $2 ORDER BY a.date DESC, a.created_at DESC`, [name, from90]),
    safe(`SELECT id, date, closed_at, reviewed_at, reviewed_by, discipline, curator_score, curator_comment FROM eod_days WHERE trader = $1 ORDER BY date DESC LIMIT 15`, [name]),
    safe(`SELECT id, week, TO_CHAR(week_start, 'YYYY-MM-DD') AS week_start, status, submitted_at, reviewed_at, curator_review ->> 'score' AS score
            FROM weekly_reviews WHERE trader = $1 ORDER BY week_start DESC LIMIT 8`, [name]),
    safe(`SELECT id, owner, title, TO_CHAR(due_on, 'YYYY-MM-DD') AS due_on, status, done_at FROM academy_action_items
           WHERE archived_at IS NULL AND student = $1 ORDER BY (status = 'open') DESC, due_on ASC NULLS LAST LIMIT 30`, [name]),
    // private_notes of a 1:1 are never selected here.
    safe(`SELECT id, mentor, met_at, format, agenda FROM academy_one_on_ones WHERE archived_at IS NULL AND student = $1 ORDER BY met_at DESC LIMIT 6`, [name]),
    safe(`SELECT id, title, metric, comparator, target::float AS target, TO_CHAR(due_on, 'YYYY-MM-DD') AS due_on, status, last_value::float AS last_value, last_progress::float AS last_progress
            FROM academy_idp_goals WHERE archived_at IS NULL AND student = $1 ORDER BY (status = 'active') DESC, created_at DESC LIMIT 10`, [name]),
    safe(`SELECT * FROM curator_notes WHERE archived_at IS NULL AND trader = $1 ORDER BY pinned DESC, created_at DESC LIMIT 100`, [name]),
    safe(`SELECT id, reason, changed_by, changed_at FROM trader_risk_limit_events WHERE trader = $1 ORDER BY changed_at DESC LIMIT 5`, [name]),
    curatorFocusFor(name, today), // the daily-loop focus: current, history, options to replace it (lib/daily/curatorFocus)
  ]);
  res.json({
    trader: name,
    role: u[0].role,
    assigned: { curator: u[0].assigned_curator ?? null, mentor: u[0].assigned_mentor ?? null, riskManager: u[0].assigned_risk_manager ?? null },
    signal,
    limits: row?.limits ?? null,
    metrics: row ? { today: row.metrics.today, week: row.metrics.week, drawdown: row.metrics.drawdown, stop: row.metrics.stop, alerts: row.metrics.alerts } : null,
    breaches: breaches.map((r: any) => ({
      id: Number(r.id), date: String(r.date), kind: String(r.kind), kindLabel: breachKindLabel(String(r.kind), b.lang),
      used: r.used == null ? null : Number(r.used), limit: r.limit == null ? null : Number(r.limit), message: String(r.message), createdAt: iso(r.created_at),
      review: r.review ? rowToBreachReview(r.review) : null,
    })),
    // Все закрытые и не разобранные дни (без архивированных) — для разбора прямо из профиля, свежие сверху (как в очереди).
    eodPending: b.eodPending
      .filter((e: any) => e.trader === name)
      .map((e: any) => ({ id: Number(e.id), date: String(e.date), closedAt: iso(e.closed_at), hoursWaiting: hoursSince(e.closed_at, Date.now()) ?? 0 }))
      .sort((x, y) => y.date.localeCompare(x.date)),
    eodDays: eodDays.map((e: any) => ({
      id: Number(e.id), date: String(e.date), closedAt: iso(e.closed_at), reviewedAt: iso(e.reviewed_at), reviewedBy: e.reviewed_by ?? null,
      discipline: e.discipline == null ? null : Number(e.discipline), curatorScore: e.curator_score == null ? null : Number(e.curator_score), curatorComment: e.curator_comment ?? null,
    })),
    weeks: weeks.map((w: any) => ({ id: Number(w.id), week: String(w.week), weekStart: String(w.week_start), status: String(w.status), submittedAt: iso(w.submitted_at), reviewedAt: iso(w.reviewed_at), score: w.score == null ? null : Number(w.score) })),
    actions: actions.map((a: any) => ({ id: Number(a.id), owner: String(a.owner), title: String(a.title), dueOn: a.due_on ?? null, status: String(a.status), overdue: a.status === "open" && !!a.due_on && a.due_on < today })),
    meetings: meetings.map((x: any) => ({ id: Number(x.id), mentor: String(x.mentor), metAt: iso(x.met_at), format: String(x.format), agenda: String(x.agenda ?? "").slice(0, 300) })),
    goals: goals.map((g: any) => ({ id: Number(g.id), title: String(g.title), metric: String(g.metric), comparator: String(g.comparator), target: g.target, dueOn: g.due_on ?? null, status: String(g.status), lastValue: g.last_value, lastProgress: g.last_progress })),
    notes: notes.map(rowToNote),
    limitEvents: limitEvents.map((e: any) => ({ id: Number(e.id), reason: e.reason ?? null, changedBy: e.changed_by ?? null, changedAt: iso(e.changed_at) })),
    focus,
    canEditLimits: await can(req, "risk.limits.edit", { trader: name }),
  });
}));

// ─── notes (private to staff) ───────────────────────────────────────────────

const NOTE_KINDS = ["note", "call", "concern", "praise"] as const;

router.get("/curator/notes", asyncHandler(async (req, res): Promise<void> => {
  const trader = typeof req.query.trader === "string" ? req.query.trader.trim() : "";
  if (!trader || trader.length > 100) throw badRequest("TRADER_REQUIRED");
  if (!(await requireCap(req, res, "journal.review", { trader }))) return;
  await ensureCuratorTables();
  const { rows } = await pool.query(`SELECT * FROM curator_notes WHERE archived_at IS NULL AND trader = $1 ORDER BY pinned DESC, created_at DESC LIMIT 200`, [trader]);
  res.json({ trader, notes: rows.map(rowToNote) });
}));

const NoteBody = z.object({
  trader: z.string().trim().min(1).max(100),
  body: z.string().trim().min(1).max(4000),
  kind: z.enum(NOTE_KINDS).default("note"),
  pinned: z.boolean().default(false),
}).strict();

router.post("/curator/notes", asyncHandler(async (req, res): Promise<void> => {
  const parsed = NoteBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error.issues[0]?.path[0] === "body" ? new AppError("NOTE_EMPTY", 400, undefined, parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))) : parsed.error;
  const b = parsed.data;
  if (!(await requireCap(req, res, "journal.review", { trader: b.trader }))) return;
  const { rows: exists } = await pool.query(`SELECT 1 FROM users WHERE name = $1 LIMIT 1`, [b.trader]);
  if (!exists.length) throw notFound("TRADER_NOT_FOUND");
  await ensureCuratorTables();
  const { rows } = await pool.query(
    `INSERT INTO curator_notes (trader, author, body, kind, pinned) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.trader, req.authUser!.name, b.body, b.kind, b.pinned],
  );
  res.status(201).json(rowToNote(rows[0]));
}));

const NotePatch = z.object({
  body: z.string().trim().min(1).max(4000).optional(),
  kind: z.enum(NOTE_KINDS).optional(),
  pinned: z.boolean().optional(),
}).strict();

/** Throws 404 NOTE_NOT_FOUND / 403 FORBIDDEN. */
async function loadNoteForEdit(req: Request, id: number): Promise<{ ok: true; row: any }> {
  await ensureCuratorTables();
  const { rows } = await pool.query(`SELECT * FROM curator_notes WHERE id = $1 AND archived_at IS NULL`, [id]);
  const row = rows[0];
  if (!row) throw notFound("NOTE_NOT_FOUND");
  if (!(await can(req, "journal.review", { trader: String(row.trader) }))) throw forbidden("journal.review");
  // Body is edited by its author only; pin / kind — by any staff member of the trader.
  return { ok: true, row };
}

router.patch("/curator/notes/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const parsed = NotePatch.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest("VALIDATION");
  const found = await loadNoteForEdit(req, id);
  const p = parsed.data;
  if (p.body !== undefined && found.row.author !== req.authUser!.name) throw new AppError("NOTE_AUTHOR_ONLY");
  const { rows } = await pool.query(
    `UPDATE curator_notes SET body = COALESCE($2, body), kind = COALESCE($3, kind), pinned = COALESCE($4, pinned), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, p.body ?? null, p.kind ?? null, p.pinned ?? null],
  );
  res.json(rowToNote(rows[0]));
}));

router.post("/curator/notes/:id/archive", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const found = await loadNoteForEdit(req, id);
  await pool.query(`UPDATE curator_notes SET archived_at = NOW(), archived_by = $2 WHERE id = $1`, [id, req.authUser!.name]);
  await logAudit({ actor: req.authUser!.name, action: "curator.note.archive", targetType: "curator_notes", targetId: String(id), details: { trader: found.row.trader, author: found.row.author } });
  res.json({ ok: true });
}));

/** «Отменить» после архивации заметки: вернуть её (только недавно архивированную — за последние сутки). */
router.post("/curator/notes/:id/restore", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  await ensureCuratorTables();
  const { rows } = await pool.query(`SELECT * FROM curator_notes WHERE id = $1 AND archived_at IS NOT NULL AND archived_at > NOW() - INTERVAL '1 day'`, [id]);
  const row = rows[0];
  if (!row) throw notFound("NOTE_NOT_FOUND");
  if (!(await can(req, "journal.review", { trader: String(row.trader) }))) throw forbidden();
  const { rows: out } = await pool.query(`UPDATE curator_notes SET archived_at = NULL, archived_by = NULL WHERE id = $1 RETURNING *`, [id]);
  await logAudit({ actor: req.authUser!.name, action: "curator.note.restore", targetType: "curator_notes", targetId: String(id), details: { trader: row.trader } });
  res.json(rowToNote(out[0]));
}));

export default router;
