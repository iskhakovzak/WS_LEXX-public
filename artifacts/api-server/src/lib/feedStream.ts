/**
 * Auto feed («Лента деска») — assembled on read from events that already live in the DB; nothing is written by a cron.
 *
 *   day results (net, trades, best trade)         own + staff        trades (PropReports round trips), shared trade math
 *   achievements: green streak, best day / week   own + staff        derived from the same per-day series
 *   academy: exam / challenge passed, promotion   own + staff        academy_* / scaling_history (if the tables exist)
 *   discipline: clean streak, rule violations     own + staff        trading_rules / rule_violations
 *   risk-limit breach                             staff (risk team)  trader_risk_limits.daily_loss_limit + risk_alert_log
 *   curator feedback: trade review, day/week      own + staff        trade_reviews / eod_days / weekly_reviews / trader_ratings
 *   desk: published ideas, playbook, threads      everyone (threads: their audience, lib/discussionAudience)
 *   announcements: premarket game plan            everyone           game_plans (manual posts stay in daily_feed)
 *   market: catalysts logged for the day          everyone           market_events (flag: one of «my» tickers)
 *   weekly summary (Friday after the close)       own (+ desk: staff)
 *
 * Every source is optional: a missing table/column (42P01 / 42703) just drops that source. Results are cached per
 * viewer scope + window + language for CACHE_TTL_MS (titles are rendered in the reader's language, `feed` namespace). Money is NET (pnl − |fees|) from lib/tradeMath; dates are NY trading dates.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { closeDateSql, netPnlSql, resultSql } from "./tradeMath";
import { addDays, nyDate, nyMinutes } from "./tradingDate";
import { ANONYMOUS_VIEWER, audienceSql, audienceViewerByName } from "./discussionAudience";
import { spaceSql, visibleSql, type PlaybookViewer } from "./playbookAccess";
import { feedT } from "../i18n/ns";
import { fmtDateFor } from "../i18n/format";
import type { Lang } from "../i18n";
import { violationMessage } from "./rulesI18n";
import { personNameFor } from "./people/latinNames";

export type FeedTone = "up" | "down" | "warn" | "accent" | "purple" | "neutral";
export type FeedCategory = "mine" | "desk" | "achievement" | "market" | "announcement";
export type FeedKind =
  | "day_result" | "streak" | "best_day" | "best_week" | "exam" | "promotion" | "clean_streak"
  | "violations" | "risk_breach" | "review" | "idea" | "playbook" | "thread" | "game_plan" | "event" | "weekly_summary";
export type FeedVisibility = "own" | "staff" | "public";
export type ValueFmt = "usd" | "pct" | "int";

export type FeedItem = {
  /** Stable id (kind + subject + date …) — the client uses it for «new since last visit» and React keys. */
  id: string;
  kind: FeedKind;
  cats: FeedCategory[];
  /** NY trading date the item belongs to. */
  date: string;
  /** ISO instant used for ordering inside the day and for «new since last visit». */
  at: string;
  /** Whose item it is (trader), null for desk-wide items. */
  trader: string | null;
  /** Who did it (curator, author), when different from the subject. */
  actor: string | null;
  title: string;
  subtitle: string | null;
  tone: FeedTone;
  /** Headline number shown on the right (formatted on the client). */
  value: number | null;
  valueFmt: ValueFmt | null;
  ticker: string | null;
  href: string | null;
  /** Items sharing a group key on the same day collapse into one card («3 новых идеи»). */
  group: string | null;
  visibility: FeedVisibility;
  meta?: Record<string, unknown>;
};

export type FeedViewer = {
  /** Signed-in name (null for guests). */
  name: string | null;
  /** Traders whose private items the viewer may read: null = whole desk, [] = nobody (guest). */
  traders: string[] | null;
  /** Desk staff (sees other traders' day results / reviews). */
  staff: boolean;
  /** May see risk-limit breaches. */
  riskTeam: boolean;
};

export type FeedStreamResult = {
  from: string;
  to: string;
  today: string;
  items: FeedItem[];
  /** Tickers the viewer traded recently / holds / has in play — the client highlights market items for them. */
  myTickers: string[];
  /** Earliest date with any data in scope (the client stops paging there). */
  earliest: string | null;
};

// ─── helpers ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; value: FeedStreamResult }>();

const STREAK_MILESTONES = [3, 5, 7, 10, 15, 20, 30, 50];
const CLEAN_MILESTONES = [5, 10, 20, 40, 60, 100];
const MIN_DAYS_FOR_BEST_DAY = 5;
const MIN_WEEKS_FOR_BEST_WEEK = 3;
const NY = "America/New_York";

/** NY calendar date of a timestamptz column, as text (for window filters / grouping). */
const nyDay = (col: string) => `to_char((${col}) AT TIME ZONE '${NY}', 'YYYY-MM-DD')`;

/** Runs a query; a missing table / column (optional module not deployed) yields no rows instead of failing the feed. */
/** Feed audience of a playbook row: «Офис» / opened to everyone → public; otherwise the owner's own or staff-only. */
function setupFeedVis(row: Record<string, unknown>, mine: boolean): FeedItem["visibility"] {
  if (row.space === "office" || row.vis === "all") return "public";
  return mine ? "own" : "staff";
}

async function safe<T extends Record<string, unknown>>(label: string, sql: string, params: unknown[]): Promise<T[]> {
  try {
    return (await pool.query<T>(sql, params)).rows;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "42P01" || code === "42703") return [];
    logger.warn({ err, source: label }, "feedStream: source failed");
    return [];
  }
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Instant of hh:mm New York time on a YYYY-MM-DD date (DST-aware without a tz library). */
export function nyInstant(date: string, hh: number, mm = 0): string {
  const [y, mo, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, hh + 5, mm); // EST guess
  const ny = new Intl.DateTimeFormat("en-GB", { timeZone: NY, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(guess));
  const [h, m] = ny.split(":").map(Number);
  const drift = (h * 60 + m) - (hh * 60 + mm); // +60 during EDT
  return new Date(guess - drift * 60_000).toISOString();
}

/** ISO week key "YYYY-Www" (same as routes/weekly-review). */
export function isoWeek(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return addDays(ymd, -((d.getUTCDay() + 6) % 7));
}

export function usd(v: number | null): string {
  if (v == null) return "—";
  const abs = Math.abs(v);
  const s = abs >= 1000 ? Math.round(abs).toLocaleString("en-US") : abs.toFixed(abs < 100 ? 2 : 0).replace(/\.00$/, "");
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}$${s}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const weekdayShort = (ymd: string, lang: Lang) =>
  new Intl.DateTimeFormat(lang === "uz" ? "uz-Latn-UZ" : lang === "en" ? "en-US" : "ru-RU", { weekday: "short", timeZone: "UTC" }).format(new Date(`${ymd}T12:00:00Z`));

const q = (params: Record<string, string | number | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};
const href = {
  trade: (id: number) => `/trades${q({ highlight: id })}`,
  dayReport: (date: string, trader?: string | null) => `/day-report${q({ date, trader })}`,
  journal: (date: string, trader?: string | null) => `/journal${q({ date, trader })}`,
  idea: (id: number) => `/trade-ideas${q({ idea: id })}`,
  setup: (id: number) => `/playbook${q({ id })}`,
  thread: (id: number) => `/discussions${q({ thread: id })}`,
  events: (ticker?: string | null) => `/events${q({ ticker })}`,
  gamePlan: (date: string) => `/game-plan${q({ date })}`,
  weekly: (week: string, trader?: string | null) => `/weekly-review${q({ trader, week })}`,
  risk: (trader?: string | null) => `/risk${q({ trader })}`,
  scaling: (trader?: string | null) => `/scaling${q({ trader })}`,
  /** Staff reading someone else's violations land on that trader's error tracker, not their own. */
  errors: (trader?: string | null) => `/error-tracker${q({ trader })}`,
};

// ─── per-day series (one query, whole history ≤ to) ─────────────────────────

type DayRow = { trader: string; d: string; n: number; wins: number; losses: number; priced: number; net: number | null; at: string | null };

async function loadDays(traders: string[] | null, to: string): Promise<DayRow[]> {
  if (traders && traders.length === 0) return [];
  const D = `substring(${closeDateSql("t")}, 1, 10)`;
  const rows = await safe<Record<string, unknown>>(
    "days",
    `SELECT t.trader, ${D} AS d, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE ${resultSql("t")} = 'win')::int AS wins,
            COUNT(*) FILTER (WHERE ${resultSql("t")} = 'loss')::int AS losses,
            COUNT(t.pnl)::int AS priced,
            SUM(${netPnlSql("t")})::float8 AS net,
            MAX(t.created_at) AS at
       FROM trades t
      WHERE t.deleted_at IS NULL AND t.trader IS NOT NULL AND ${D} <= $1 AND ($2::text[] IS NULL OR t.trader = ANY($2))
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [to, traders],
  );
  return rows.map((r) => ({
    trader: String(r.trader), d: String(r.d), n: Number(r.n), wins: Number(r.wins), losses: Number(r.losses),
    priced: Number(r.priced), net: num(r.net) == null ? null : r2(num(r.net)!), at: iso(r.at),
  }));
}

// ─── builder ────────────────────────────────────────────────────────────────

export async function buildFeedStream(viewer: FeedViewer, from: string, to: string, now: Date = new Date(), lang: Lang = "ru"): Promise<FeedStreamResult> {
  const key = JSON.stringify([lang, viewer.name, viewer.traders, viewer.staff, viewer.riskTeam, from, to, nyDate(now), nyMinutes(now) >= 960]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await compute(viewer, from, to, now, lang);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearFeedStreamCache(): void {
  cache.clear();
}

async function compute(viewer: FeedViewer, from: string, to: string, now: Date, lang: Lang): Promise<FeedStreamResult> {
  const t = feedT.tFor(lang);
  /** A person's name as this reader sees it (Latin for EN/UZ); `trader` / `actor` fields keep the stored name. */
  const pn = (n: string | null | undefined) => personNameFor(n, lang);
  const SEP = t("sep");
  const today = nyDate(now);
  const afterClose = nyMinutes(now) >= 960;
  const me = viewer.name;
  const scope = viewer.traders; // null = all
  const noPrivate = !!scope && scope.length === 0;
  const items: FeedItem[] = [];
  const inWindow = (d: string) => d >= from && d <= to;
  const isMine = (trader: string | null) => !!me && trader === me;
  const ownCats = (trader: string | null, ...extra: FeedCategory[]): FeedCategory[] => [isMine(trader) ? "mine" : "desk", ...extra];
  const D = `substring(${closeDateSql("t")}, 1, 10)`;
  // Threads with a restricted audience reach only that audience (+ author, moderators); the cache key has the name.
  const threadViewer = await audienceViewerByName(me).catch((err) => {
    logger.warn({ err }, "feedStream: discussion audience viewer failed");
    return ANONYMOUS_VIEWER;
  });
  const threadParams: unknown[] = [from, to];
  const threadVis = audienceSql(threadViewer, (v) => { threadParams.push(v); return `$${threadParams.length}`; });
  // Personal setups are private unless shared: the feed shows «Офис», setups opened to everyone, and the viewer's own /
  // team-scope ones (same rule as /playbook — lib/playbookAccess.visibleSql). Cohort shares are left out here.
  const pbViewer: PlaybookViewer = {
    name: me, guest: !me, teamScope: scope, editOwn: false, editAny: false, review: false, stage: null, cohorts: [],
  };
  const setupParams: unknown[] = [from, to];
  const setupVis = visibleSql(pbViewer, setupParams, "p");
  const exampleParams: unknown[] = [from, to];
  const exampleVis = visibleSql(pbViewer, exampleParams, "p");

  const [
    days, bestTrades, violations, rulesFor, limits, alerts,
    quizzes, challenges, stageMoves, submissions, scalingMoves,
    tradeReviews, dayReviews, weekReviews, ratings,
    ideas, setups, examples, threads, plans, events, myTraded, inPlay, held, earliestRows,
  ] = await Promise.all([
    loadDays(scope, to),
    noPrivate ? [] : safe<Record<string, unknown>>(
      "best-trade",
      `SELECT DISTINCT ON (t.trader, ${D}) t.trader, ${D} AS d, t.id, UPPER(t.ticker) AS ticker, t.side, ${netPnlSql("t")}::float8 AS net
         FROM trades t
        WHERE t.deleted_at IS NULL AND t.trader IS NOT NULL AND t.pnl IS NOT NULL AND ${D} BETWEEN $1 AND $2
          AND ($3::text[] IS NULL OR t.trader = ANY($3))
        ORDER BY t.trader, ${D}, ${netPnlSql("t")} DESC`, [from, to, scope]),
    noPrivate ? [] : safe<Record<string, unknown>>(
      "violations",
      `SELECT trader, COALESCE(day, ${nyDay("occurred_at")}) AS d, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE severity IN ('high', 'critical'))::int AS severe,
              SUM(cost_net)::float8 AS cost, MAX(occurred_at) AS at,
              (ARRAY_AGG(message ORDER BY occurred_at DESC))[1] AS last_message,
              (ARRAY_AGG(details ORDER BY occurred_at DESC))[1] AS last_details
         FROM rule_violations
        WHERE archived_at IS NULL AND COALESCE(day, ${nyDay("occurred_at")}) <= $1 AND ($2::text[] IS NULL OR trader = ANY($2))
        GROUP BY 1, 2`, [to, scope]),
    noPrivate ? [] : safe<{ trader: string | null }>("rules", `SELECT DISTINCT trader FROM trading_rules WHERE enabled IS DISTINCT FROM false`, []),
    noPrivate ? [] : safe<Record<string, unknown>>(
      "limits", `SELECT trader, daily_loss_limit::float8 AS dll FROM trader_risk_limits WHERE ($1::text[] IS NULL OR trader = ANY($1))`, [scope]),
    viewer.riskTeam ? safe<Record<string, unknown>>(
      "risk-alerts",
      `SELECT trader, date AS d, kind, message, used::float8 AS used, "limit"::float8 AS lim, created_at AS at
         FROM risk_alert_log WHERE level = 'breach' AND date BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR trader = ANY($3))
        ORDER BY created_at`, [from, to, scope]) : [],
    noPrivate ? [] : safe<Record<string, unknown>>(
      "quiz",
      `SELECT a.id, a.user_name, q.title, a.pct::float8 AS pct, a.submitted_at AS at, ${nyDay("a.submitted_at")} AS d
         FROM academy_quiz_attempts a LEFT JOIN academy_quizzes q ON q.id = a.quiz_id
        WHERE a.passed = true AND ${nyDay("a.submitted_at")} BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR a.user_name = ANY($3))`,
      [from, to, scope]),
    noPrivate ? [] : safe<Record<string, unknown>>(
      "challenge",
      `SELECT id, user_name, name, COALESCE(summary->>'passedOn', ${nyDay("updated_at")}) AS d, updated_at AS at
         FROM academy_challenges
        WHERE status = 'passed' AND archived_at IS NULL AND COALESCE(summary->>'passedOn', ${nyDay("updated_at")}) BETWEEN $1 AND $2
          AND ($3::text[] IS NULL OR user_name = ANY($3))`, [from, to, scope]),
    noPrivate ? [] : safe<Record<string, unknown>>(
      "stage",
      `SELECT h.id, h.user_name, h.from_stage, h.to_stage, h.actor, h.created_at AS at, ${nyDay("h.created_at")} AS d,
              fs.name AS from_name, ts.name AS to_name
         FROM academy_stage_history h
         LEFT JOIN academy_stages fs ON fs.key = h.from_stage LEFT JOIN academy_stages ts ON ts.key = h.to_stage
        WHERE h.action = 'promote' AND ${nyDay("h.created_at")} BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR h.user_name = ANY($3))`,
      [from, to, scope]),
    noPrivate ? [] : safe<Record<string, unknown>>(
      "submission",
      `SELECT s.id, s.user_name, a.title, s.pct::float8 AS pct, s.graded_by, s.graded_at AS at, ${nyDay("s.graded_at")} AS d
         FROM academy_submissions s LEFT JOIN academy_assignments a ON a.id = s.assignment_id
        WHERE s.passed = true AND s.graded_at IS NOT NULL AND s.archived_at IS NULL AND ${nyDay("s.graded_at")} BETWEEN $1 AND $2
          AND ($3::text[] IS NULL OR s.user_name = ANY($3))`, [from, to, scope]),
    noPrivate ? [] : safe<Record<string, unknown>>(
      "scaling",
      `SELECT id, trader, from_tier, to_tier, actor, created_at AS at, ${nyDay("created_at")} AS d
         FROM scaling_history
        WHERE action = 'promote' AND ${nyDay("created_at")} BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR trader = ANY($3))`,
      [from, to, scope]),
    noPrivate ? [] : safe<Record<string, unknown>>(
      "trade-reviews",
      `SELECT r.id, r.trade_id, r.curator, r.comment, r.rating, r.created_at AS at, ${nyDay("r.created_at")} AS d,
              t.trader, UPPER(t.ticker) AS ticker
         FROM trade_reviews r JOIN trades t ON t.id = r.trade_id AND t.deleted_at IS NULL
        WHERE ${nyDay("r.created_at")} BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR t.trader = ANY($3))`, [from, to, scope]),
    noPrivate ? [] : safe<Record<string, unknown>>(
      "day-reviews",
      `SELECT id, trader, date, reviewed_by, curator_comment, curator_score, reviewed_at AS at, ${nyDay("reviewed_at")} AS d
         FROM eod_days
        WHERE reviewed_at IS NOT NULL AND ${nyDay("reviewed_at")} BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR trader = ANY($3))`,
      [from, to, scope]),
    noPrivate ? [] : safe<Record<string, unknown>>(
      "week-reviews",
      `SELECT id, trader, week, curator_review, reviewed_at AS at, ${nyDay("reviewed_at")} AS d
         FROM weekly_reviews
        WHERE reviewed_at IS NOT NULL AND ${nyDay("reviewed_at")} BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR trader = ANY($3))`,
      [from, to, scope]),
    noPrivate ? [] : safe<Record<string, unknown>>(
      "ratings",
      `SELECT id, trader, curator, week, overall, comment, created_at AS at, ${nyDay("created_at")} AS d
         FROM trader_ratings
        WHERE ${nyDay("created_at")} BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR trader = ANY($3))`, [from, to, scope]),
    safe<Record<string, unknown>>(
      "ideas",
      `SELECT id, UPPER(ticker) AS ticker, side, setup, trader, score, horizon, status,
              COALESCE(published_at, created_at) AS at, ${nyDay("COALESCE(published_at, created_at)")} AS d
         FROM trade_ideas
        WHERE deleted_at IS NULL AND status IN ('published', 'converted')
          AND ${nyDay("COALESCE(published_at, created_at)")} BETWEEN $1 AND $2`, [from, to]),
    safe<Record<string, unknown>>(
      "playbook",
      `SELECT p.id, p.name, p.folder, p.trader, p.confidence_level, ${spaceSql("p")} AS space, COALESCE(p.visibility, 'private') AS vis, p.created_at AS at, ${nyDay("p.created_at")} AS d
         FROM playbook p
        WHERE p.deleted_at IS NULL AND ${nyDay("p.created_at")} BETWEEN $1 AND $2 AND ${setupVis}`, setupParams),
    safe<Record<string, unknown>>(
      "playbook-examples",
      `SELECT i.id, UPPER(i.ticker) AS ticker, i.status, i.playbook_id, p.name AS setup, i.trader, ${spaceSql("p")} AS space, COALESCE(p.visibility, 'private') AS vis, i.created_at AS at, ${nyDay("i.created_at")} AS d
         FROM trade_ideas i JOIN playbook p ON p.id = i.playbook_id AND p.deleted_at IS NULL
        WHERE i.deleted_at IS NULL AND i.playbook_id IS NOT NULL AND i.published_at IS NULL
          AND i.status IN ('watching', 'worked', 'partial', 'failed', 'studying')
          AND ${nyDay("i.created_at")} BETWEEN $1 AND $2 AND ${exampleVis}`, exampleParams),
    safe<Record<string, unknown>>(
      "threads",
      `SELECT d.id, d.topic, d.type, d.trader, UPPER(d.ticker) AS ticker, d.created_at AS at, ${nyDay("d.created_at")} AS d,
              (SELECT COUNT(*)::int FROM comments c WHERE c.discussion_id = d.id) AS comments
         FROM discussions d
        WHERE d.deleted_at IS NULL AND ${nyDay("d.created_at")} BETWEEN $1 AND $2 AND ${threadVis}`, threadParams),
    safe<Record<string, unknown>>(
      "game-plans",
      `SELECT id, date AS d, author, market_view, bias, risk_mode, in_play, COALESCE(updated_at, created_at) AS at
         FROM game_plans WHERE deleted_at IS NULL AND date BETWEEN $1 AND $2`, [from, to]),
    safe<Record<string, unknown>>(
      "events",
      `SELECT id, UPPER(ticker) AS ticker, substring(date, 1, 10) AS d, event_type, headline, percent_move::float8 AS pm, session, created_at AS at
         FROM market_events WHERE deleted_at IS NULL AND substring(date, 1, 10) BETWEEN $1 AND $2`, [from, to]),
    me && !noPrivate ? safe<{ ticker: string }>(
      "my-tickers",
      `SELECT UPPER(t.ticker) AS ticker FROM trades t
        WHERE t.deleted_at IS NULL AND t.trader = $1 AND substring(t.date, 1, 10) >= $2 AND t.ticker IS NOT NULL
        GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 40`, [me, addDays(today, -30)]) : [],
    safe<{ ticker: string }>("in-play", `SELECT UPPER(ticker) AS ticker FROM watchlist WHERE deleted_at IS NULL AND in_play = true LIMIT 40`, []),
    me && !noPrivate ? safe<{ ticker: string }>(
      "held",
      `SELECT DISTINCT UPPER(t.ticker) AS ticker FROM trades t
        WHERE t.deleted_at IS NULL AND t.trader = $1 AND ${resultSql("t")} = 'open'`, [me]) : [],
    safe<{ d: string | null }>(
      "earliest",
      `SELECT LEAST(
          (SELECT MIN(substring(date, 1, 10)) FROM market_events WHERE deleted_at IS NULL),
          (SELECT MIN(${nyDay("created_at")}) FROM trade_ideas WHERE deleted_at IS NULL AND status IN ('published', 'converted')),
          (SELECT MIN(date) FROM game_plans WHERE deleted_at IS NULL)) AS d`, []),
  ]);

  // ── per-trader day series: results, streaks, records, discipline, risk ──
  const best = new Map<string, Record<string, unknown>>();
  for (const b of bestTrades) best.set(`${b.trader}|${b.d}`, b);
  const vio = new Map<string, Record<string, unknown>>();
  for (const v of violations) vio.set(`${v.trader}|${v.d}`, v);
  const rules: { trader: string | null }[] = rulesFor;
  const globalRules = rules.some((r) => r.trader == null);
  const ruleTraders = new Set(rules.map((r) => r.trader).filter((t): t is string => !!t));
  const dll = new Map<string, number>();
  for (const l of limits) { const v = num(l.dll); if (v != null && v > 0) dll.set(String(l.trader), v); }
  const alertsBy = new Map<string, Record<string, unknown>[]>();
  for (const a of alerts) {
    const k = `${a.trader}|${a.d}`;
    (alertsBy.get(k) ?? alertsBy.set(k, []).get(k)!).push(a);
  }

  const byTrader = new Map<string, DayRow[]>();
  for (const r of days) (byTrader.get(r.trader) ?? byTrader.set(r.trader, []).get(r.trader)!).push(r);

  const weekComplete = (monday: string) => {
    const friday = addDays(monday, 4);
    return friday < today || (friday === today && afterClose);
  };

  type WeekAgg = { week: string; monday: string; net: number | null; n: number; days: number; green: number; red: number; best: DayRow | null; last: string; at: string | null };
  const deskWeeks = new Map<string, { monday: string; week: string; net: number | null; n: number; traders: { trader: string; net: number | null }[]; at: string | null }>();

  for (const [trader, series] of byTrader) {
    const hasRules = globalRules || ruleTraders.has(trader);
    let streak = 0, maxNet = -Infinity, pricedDays = 0, clean = 0;
    const weeks = new Map<string, WeekAgg>();
    for (const r of series) {
      // When the day became known (first import), capped at the evening of that day: a re-sync or a late
      // history import must not re-date old days (that would flood «новое с последнего визита»).
      const dayEnd = nyInstant(r.d, 20);
      const at = r.at && r.at < dayEnd ? r.at : dayEnd;
      const v = vio.get(`${trader}|${r.d}`);
      const vioN = v ? Number(v.n) : 0;
      // week aggregate
      const monday = mondayOf(r.d);
      const w = weeks.get(monday) ?? { week: isoWeek(r.d), monday, net: null, n: 0, days: 0, green: 0, red: 0, best: null, last: r.d, at: null };
      w.n += r.n; w.days += 1; w.last = r.d > w.last ? r.d : w.last;
      if (r.net != null) {
        w.net = r2((w.net ?? 0) + r.net);
        if (r.net > 0) w.green += 1; else if (r.net < 0) w.red += 1;
        if (!w.best || (w.best.net ?? -Infinity) < r.net) w.best = r;
      }
      if (!w.at || at > w.at) w.at = at;
      weeks.set(monday, w);

      const show = inWindow(r.d);
      if (show) {
        const b = best.get(`${trader}|${r.d}`);
        const decided = r.wins + r.losses;
        const parts = [t("trades", { count: r.n })];
        if (decided) parts.push(t("winRate", { pct: Math.round((r.wins / decided) * 100) }));
        if (b && num(b.net) != null && num(b.net)! > 0) parts.push(t("bestTrade", { ticker: String(b.ticker), net: usd(num(b.net)) }));
        if (hasRules) parts.push(vioN ? t("violations", { count: vioN }) : t("noViolations"));
        items.push({
          id: `day:${trader}:${r.d}`, kind: "day_result", cats: ownCats(trader), date: r.d, at, trader, actor: null,
          title: isMine(trader)
            ? (r.net == null ? t("day.result") : r.net >= 0 ? t("day.green") : t("day.red"))
            : t("day.ofTrader", { trader: pn(trader) }),
          subtitle: parts.join(SEP),
          tone: r.net == null ? "neutral" : r.net > 0 ? "up" : r.net < 0 ? "down" : "neutral",
          value: r.net, valueFmt: r.net == null ? null : "usd", ticker: (b?.ticker as string) ?? null,
          href: href.dayReport(r.d, isMine(trader) ? null : trader),
          group: isMine(trader) ? null : `desk-day:${r.d}`, visibility: "own",
          meta: {
            n: r.n, wins: r.wins, losses: r.losses, net: r.net, violations: vioN, clean: hasRules ? vioN === 0 : null,
            bestTrade: b ? { id: Number(b.id), ticker: b.ticker, side: b.side, net: num(b.net) } : null,
          },
        });
      }

      // green streak + record day (priced days only)
      if (r.net != null) {
        streak = r.net > 0 ? streak + 1 : 0;
        if (show && r.net > 0 && STREAK_MILESTONES.includes(streak)) {
          items.push({
            id: `streak:${trader}:${r.d}`, kind: "streak", cats: ownCats(trader, "achievement"), date: r.d, at, trader, actor: null,
            title: t("streak.title", { count: streak }),
            subtitle: isMine(trader) ? t("streak.mine") : pn(trader),
            tone: "up", value: streak, valueFmt: "int", ticker: null, href: href.journal(r.d, isMine(trader) ? null : trader),
            group: null, visibility: "own", meta: { streak },
          });
        }
        if (show && r.net > 0 && pricedDays >= MIN_DAYS_FOR_BEST_DAY && r.net > maxNet) {
          items.push({
            id: `best-day:${trader}:${r.d}`, kind: "best_day", cats: ownCats(trader, "achievement"), date: r.d, at, trader, actor: null,
            title: t("bestDay.title"),
            subtitle: `${isMine(trader) ? "" : `${pn(trader)}${SEP}`}${t("bestDay.previous", { value: usd(Number.isFinite(maxNet) ? r2(maxNet) : null) })}`,
            tone: "up", value: r.net, valueFmt: "usd", ticker: null, href: href.dayReport(r.d, isMine(trader) ? null : trader),
            group: null, visibility: "own", meta: { previous: Number.isFinite(maxNet) ? r2(maxNet) : null },
          });
        }
        if (r.net > maxNet) maxNet = r.net;
        pricedDays += 1;
      }

      // discipline: clean streak (only when the trader has rules to break)
      if (hasRules) {
        clean = vioN === 0 ? clean + 1 : 0;
        if (show && vioN === 0 && CLEAN_MILESTONES.includes(clean)) {
          items.push({
            id: `clean:${trader}:${r.d}`, kind: "clean_streak", cats: ownCats(trader, "achievement"), date: r.d, at, trader, actor: null,
            title: t("clean.title", { count: clean }),
            subtitle: isMine(trader) ? t("clean.mine") : pn(trader), tone: "accent", value: clean, valueFmt: "int", ticker: null,
            href: href.errors(isMine(trader) ? null : trader), group: null, visibility: "own", meta: { clean },
          });
        }
      }
      if (show && vioN > 0 && v) {
        const cost = num(v.cost);
        items.push({
          id: `vio:${trader}:${r.d}`, kind: "violations", cats: ownCats(trader), date: r.d, at: iso(v.at) ?? at, trader, actor: null,
          title: `${t("vio.title", { count: vioN })}${isMine(trader) ? "" : `${SEP}${pn(trader)}`}`,
          subtitle: [v.last_message ? violationMessage(String(v.last_message), v.last_details, lang) : null, cost ? t("vio.cost", { value: usd(-Math.abs(cost)) }) : null].filter(Boolean).join(SEP) || null,
          tone: Number(v.severe) > 0 ? "down" : "warn", value: vioN, valueFmt: "int", ticker: null, href: href.errors(isMine(trader) ? null : trader),
          group: null, visibility: "own", meta: { severe: Number(v.severe), cost },
        });
      }

      // risk: daily loss limit (staff / risk team only) + logged breaches
      if (show && viewer.riskTeam) {
        const lim = dll.get(trader);
        const logged = alertsBy.get(`${trader}|${r.d}`) ?? [];
        const lossBreach = lim != null && r.net != null && r.net <= -lim;
        if (lossBreach || logged.length) {
          const kinds = Array.from(new Set(logged.map((a) => String(a.message ?? a.kind)))).slice(0, 3);
          items.push({
            id: `risk:${trader}:${r.d}`, kind: "risk_breach", cats: ["desk"], date: r.d, at, trader, actor: null,
            title: t("risk.title", { trader: pn(trader) }),
            subtitle: lossBreach ? [t("risk.dailyLimit", { value: usd(-lim!) }), ...kinds].join(SEP) : kinds.join(SEP) || null,
            tone: "down", value: r.net, valueFmt: r.net == null ? null : "usd", ticker: null, href: href.risk(trader),
            group: null, visibility: "staff", meta: { limit: lim ?? null, alerts: logged.length },
          });
        }
      }
    }

    // weekly: record week + summary (completed weeks only)
    let maxWeek = -Infinity, pricedWeeks = 0;
    for (const w of Array.from(weeks.values()).sort((a, b) => a.monday.localeCompare(b.monday))) {
      if (!weekComplete(w.monday)) continue;
      const friday = addDays(w.monday, 4);
      const at = nyInstant(friday, 16, 5);
      const show = inWindow(friday);
      if (show) {
        const parts = [t("trades", { count: w.n })];
        if (w.net != null) parts.push(t("week.greenDays", { green: w.green, count: w.days }));
        else parts.push(t("week.tradingDays", { count: w.days }));
        if (w.best?.net != null && w.best.net > 0) parts.push(t("week.bestDay", { weekday: weekdayShort(w.best.d, lang), net: usd(w.best.net) }));
        items.push({
          id: `week:${trader}:${w.week}`, kind: "weekly_summary", cats: ownCats(trader), date: friday, at, trader, actor: null,
          title: isMine(trader) ? t("week.mine", { week: w.week.slice(-3) }) : t("week.ofTrader", { trader: pn(trader), week: w.week.slice(-3) }),
          subtitle: parts.join(SEP), tone: w.net == null ? "neutral" : w.net >= 0 ? "up" : "down",
          value: w.net, valueFmt: w.net == null ? null : "usd", ticker: null, href: href.weekly(w.week, isMine(trader) ? null : trader),
          group: isMine(trader) ? null : `desk-week:${w.week}`, visibility: "own",
          meta: { week: w.week, n: w.n, days: w.days, green: w.green, red: w.red },
        });
        if (viewer.staff) {
          const dw = deskWeeks.get(w.week) ?? { monday: w.monday, week: w.week, net: null, n: 0, traders: [], at };
          dw.n += w.n; if (w.net != null) dw.net = r2((dw.net ?? 0) + w.net);
          dw.traders.push({ trader, net: w.net });
          deskWeeks.set(w.week, dw);
        }
      }
      if (w.net != null) {
        if (show && w.net > 0 && pricedWeeks >= MIN_WEEKS_FOR_BEST_WEEK && w.net > maxWeek) {
          items.push({
            id: `best-week:${trader}:${w.week}`, kind: "best_week", cats: ownCats(trader, "achievement"), date: friday, at, trader, actor: null,
            title: t("week.bestTitle"), subtitle: `${isMine(trader) ? "" : `${pn(trader)}${SEP}`}${t("week.previous", { week: w.week, value: usd(r2(maxWeek)) })}`,
            tone: "up", value: w.net, valueFmt: "usd", ticker: null, href: href.weekly(w.week, isMine(trader) ? null : trader),
            group: null, visibility: "own", meta: { previous: r2(maxWeek) },
          });
        }
        if (w.net > maxWeek) maxWeek = w.net;
        pricedWeeks += 1;
      }
    }
  }

  // desk weekly summary (staff, ≥2 traders traded)
  for (const dw of deskWeeks.values()) {
    if (dw.traders.length < 2) continue;
    const friday = addDays(dw.monday, 4);
    const top = [...dw.traders].sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity))[0];
    items.push({
      id: `desk-week:${dw.week}`, kind: "weekly_summary", cats: ["desk"], date: friday, at: nyInstant(friday, 16, 6), trader: null, actor: null,
      title: t("week.deskTitle", { week: dw.week.slice(-3) }),
      subtitle: [t("week.traders", { count: dw.traders.length }), t("trades", { count: dw.n }), top?.net != null ? t("week.bestTrader", { trader: pn(top.trader), net: usd(top.net) }) : null].filter(Boolean).join(SEP),
      tone: dw.net == null ? "neutral" : dw.net >= 0 ? "up" : "down", value: dw.net, valueFmt: dw.net == null ? null : "usd",
      ticker: null, href: href.weekly(dw.week), group: null, visibility: "staff", meta: { week: dw.week, traders: dw.traders.length },
    });
  }

  // ── academy / scaling achievements ──
  for (const a of quizzes) {
    const tr = String(a.user_name);
    items.push({
      id: `quiz:${a.id}`, kind: "exam", cats: ownCats(tr, "achievement"), date: String(a.d), at: iso(a.at)!, trader: tr, actor: null,
      title: a.title ? t("academy.quizWith", { title: String(a.title) }) : t("academy.quiz"), subtitle: isMine(tr) ? t("academy.label") : pn(tr), tone: "purple",
      value: num(a.pct), valueFmt: num(a.pct) == null ? null : "pct", ticker: null, href: "/academy/learn", group: null, visibility: "own",
    });
  }
  for (const s of submissions) {
    const tr = String(s.user_name);
    items.push({
      id: `sub:${s.id}`, kind: "exam", cats: ownCats(tr, "achievement"), date: String(s.d), at: iso(s.at)!, trader: tr, actor: s.graded_by ? String(s.graded_by) : null,
      title: s.title ? t("academy.assignmentWith", { title: String(s.title) }) : t("academy.assignment"), subtitle: [isMine(tr) ? null : pn(tr), s.graded_by ? t("academy.gradedBy", { name: pn(String(s.graded_by)) }) : null].filter(Boolean).join(SEP) || t("academy.label"),
      tone: "purple", value: num(s.pct), valueFmt: num(s.pct) == null ? null : "pct", ticker: null, href: "/academy/learn", group: null, visibility: "own",
    });
  }
  for (const c of challenges) {
    const tr = String(c.user_name);
    items.push({
      id: `challenge:${c.id}`, kind: "exam", cats: ownCats(tr, "achievement"), date: String(c.d).slice(0, 10), at: iso(c.at)!, trader: tr, actor: null,
      title: t("academy.exam", { name: c.name ? String(c.name) : t("academy.examDefault") }), subtitle: isMine(tr) ? t("academy.examMine") : pn(tr), tone: "purple",
      value: null, valueFmt: null, ticker: null, href: "/academy/challenges", group: null, visibility: "own",
    });
  }
  for (const h of stageMoves) {
    const tr = String(h.user_name);
    items.push({
      id: `stage:${h.id}`, kind: "promotion", cats: ownCats(tr, "achievement"), date: String(h.d), at: iso(h.at)!, trader: tr, actor: h.actor ? String(h.actor) : null,
      title: t("academy.stage", { stage: String(h.to_name ?? h.to_stage) }), subtitle: [isMine(tr) ? null : pn(tr), `${h.from_name ?? h.from_stage ?? "—"} → ${h.to_name ?? h.to_stage}`].filter(Boolean).join(SEP),
      tone: "purple", value: null, valueFmt: null, ticker: null, href: "/academy/path", group: null, visibility: "own",
    });
  }
  for (const h of scalingMoves) {
    const tr = String(h.trader);
    items.push({
      id: `tier:${h.id}`, kind: "promotion", cats: ownCats(tr, "achievement"), date: String(h.d), at: iso(h.at)!, trader: tr, actor: h.actor ? String(h.actor) : null,
      title: t("academy.tier", { tier: String(h.to_tier) }), subtitle: [isMine(tr) ? null : pn(tr), h.from_tier ? `${h.from_tier} → ${h.to_tier}` : null, t("academy.moreBp")].filter(Boolean).join(SEP),
      tone: "purple", value: null, valueFmt: null, ticker: null, href: href.scaling(isMine(tr) ? null : tr), group: null, visibility: "own",
    });
  }

  // ── curator feedback (owner + staff) ──
  for (const r of tradeReviews) {
    const tr = String(r.trader);
    const curator = r.curator ? String(r.curator) : t("review.curator");
    items.push({
      id: `trade-review:${r.id}`, kind: "review", cats: ownCats(tr), date: String(r.d), at: iso(r.at)!, trader: tr, actor: curator,
      title: t("review.trade", { curator: pn(curator), ticker: String(r.ticker ?? "") }).trim() + (isMine(tr) ? "" : `${SEP}${pn(tr)}`),
      subtitle: r.comment ? String(r.comment).slice(0, 160) : r.rating ? t("review.rating", { value: String(r.rating) }) : null,
      tone: "accent", value: null, valueFmt: null, ticker: (r.ticker as string) ?? null, href: href.trade(Number(r.trade_id)),
      group: `reviews:${r.d}:${tr}`, visibility: "own",
    });
  }
  for (const r of dayReviews) {
    const tr = String(r.trader);
    const score = num(r.curator_score);
    items.push({
      id: `day-review:${r.id}`, kind: "review", cats: ownCats(tr), date: String(r.d), at: iso(r.at)!, trader: tr, actor: r.reviewed_by ? String(r.reviewed_by) : null,
      title: `${t("review.day", { curator: r.reviewed_by ? pn(String(r.reviewed_by)) : t("review.curator"), date: fmtDateFor(lang, String(r.date).slice(0, 10), "dayMonthNumeric") })}${isMine(tr) ? "" : `${SEP}${pn(tr)}`}`,
      subtitle: r.curator_comment ? String(r.curator_comment).slice(0, 160) : null,
      tone: "accent", value: score, valueFmt: score == null ? null : "int", ticker: null, href: href.dayReport(String(r.date), isMine(tr) ? null : tr),
      group: null, visibility: "own", meta: { score },
    });
  }
  for (const r of weekReviews) {
    const tr = String(r.trader);
    const cr = (r.curator_review ?? {}) as Record<string, unknown>;
    const score = num(cr.score);
    items.push({
      id: `week-review:${r.id}`, kind: "review", cats: ownCats(tr), date: String(r.d), at: iso(r.at)!, trader: tr, actor: (cr.by as string) ?? (cr.curator as string) ?? null,
      title: `${t("review.week", { week: String(r.week).slice(-3) })}${isMine(tr) ? "" : `${SEP}${pn(tr)}`}`,
      subtitle: typeof cr.comment === "string" ? cr.comment.slice(0, 160) : null,
      tone: "accent", value: score, valueFmt: score == null ? null : "int", ticker: null, href: href.weekly(String(r.week), isMine(tr) ? null : tr),
      group: null, visibility: "own",
    });
  }
  /** "2026-10-12" → "12.10" in the reader's language (gender-neutral title, no raw ISO in the feed). */
  const weekShort = (w: unknown): string | null => {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(w ?? ""));
    return m ? fmtDateFor(lang, m[1], "dayMonthNumeric") : null;
  };
  for (const r of ratings) {
    const tr = String(r.trader);
    const overall = num(r.overall);
    items.push({
      id: `rating:${r.id}`, kind: "review", cats: ownCats(tr), date: String(r.d), at: iso(r.at)!, trader: tr, actor: r.curator ? String(r.curator) : null,
      title: `${(() => { const c = r.curator ? pn(String(r.curator)) : t("review.curator"); const d = weekShort(r.week); return d ? t("review.weekRatingFrom", { curator: c, date: d }) : t("review.weekRating", { curator: c }); })()}${isMine(tr) ? "" : `${SEP}${pn(tr)}`}`,
      subtitle: r.comment ? String(r.comment).slice(0, 160) : null, tone: "accent", value: overall, valueFmt: overall == null ? null : "int",
      // Staff see a rating per trader every week: fold the day's ratings of others into one card.
      ticker: null, href: "/ratings", group: isMine(tr) ? null : `ratings:${r.d}`, visibility: "own",
    });
  }

  // ── desk publications (public) ──
  for (const i of ideas) {
    const author = i.trader ? String(i.trader) : null;
    const side = String(i.side ?? "").toLowerCase().startsWith("s") ? t("idea.short") : i.side ? t("idea.long") : null;
    items.push({
      id: `idea:${i.id}`, kind: "idea", cats: isMine(author) ? ["desk", "mine"] : ["desk"], date: String(i.d), at: iso(i.at)!, trader: author, actor: author,
      title: `${t("idea.title", { ticker: String(i.ticker) })}${side ? ` ${side}` : ""}${i.setup ? `${SEP}${i.setup}` : ""}`,
      subtitle: [author ? (isMine(author) ? t("idea.mine") : pn(author)) : null, i.horizon && i.horizon !== "intraday" ? String(i.horizon) : null, i.status === "converted" ? t("idea.traded") : null].filter(Boolean).join(SEP) || null,
      tone: "accent", value: num(i.score), valueFmt: num(i.score) == null ? null : "int", ticker: (i.ticker as string) ?? null, href: href.idea(Number(i.id)),
      group: `ideas:${i.d}`, visibility: "public",
    });
  }
  for (const p of setups) {
    const author = p.trader ? String(p.trader) : null;
    items.push({
      id: `setup:${p.id}`, kind: "playbook", cats: isMine(author) ? ["desk", "mine"] : ["desk"], date: String(p.d), at: iso(p.at)!, trader: author, actor: author,
      title: t("setup.new", { name: String(p.name) }), subtitle: [p.folder ? String(p.folder) : null, author ? (isMine(author) ? t("setup.you") : pn(author)) : null].filter(Boolean).join(SEP) || null,
      tone: "neutral", value: null, valueFmt: null, ticker: null, href: href.setup(Number(p.id)), group: `playbook:${p.d}`, visibility: setupFeedVis(p, isMine(author)),
    });
  }
  for (const e of examples) {
    const author = e.trader ? String(e.trader) : null;
    const worked = e.status === "worked";
    items.push({
      id: `example:${e.id}`, kind: "playbook", cats: isMine(author) ? ["desk", "mine", ...(worked ? ["achievement" as const] : [])] : ["desk"],
      date: String(e.d), at: iso(e.at)!, trader: author, actor: author,
      title: t(worked ? "setup.exampleWorked" : "setup.example", { ticker: String(e.ticker) }), subtitle: `${e.setup}${author ? `${SEP}${isMine(author) ? t("setup.you") : pn(author)}` : ""}`,
      tone: worked ? "up" : "neutral", value: null, valueFmt: null, ticker: (e.ticker as string) ?? null, href: href.setup(Number(e.playbook_id)),
      group: `playbook:${e.d}`, visibility: setupFeedVis(e, isMine(author)),
    });
  }
  for (const d of threads) {
    const author = d.trader ? String(d.trader) : null;
    const n = Number(d.comments ?? 0);
    items.push({
      id: `thread:${d.id}`, kind: "thread", cats: isMine(author) ? ["desk", "mine"] : ["desk"], date: String(d.d), at: iso(d.at)!, trader: author, actor: author,
      title: t("thread.title", { topic: String(d.topic) }), subtitle: [pn(author), d.ticker ? String(d.ticker) : null, n ? t("thread.replies", { count: n }) : null].filter(Boolean).join(SEP) || null,
      tone: "neutral", value: null, valueFmt: null, ticker: (d.ticker as string) ?? null, href: href.thread(Number(d.id)), group: `threads:${d.d}`, visibility: "public",
    });
  }
  for (const g of plans) {
    const inPlayN = Array.isArray(g.in_play) ? g.in_play.length : 0;
    const bias = g.bias ? String(g.bias) : null;
    items.push({
      id: `plan:${g.id}`, kind: "game_plan", cats: ["announcement"], date: String(g.d), at: iso(g.at) ?? nyInstant(String(g.d), 9), trader: null, actor: g.author ? String(g.author) : null,
      title: t("plan.title"), subtitle: [bias ? t("plan.bias", { value: bias }) : null, g.risk_mode ? t("plan.risk", { value: String(g.risk_mode) }) : null, inPlayN ? t("plan.inPlay", { count: inPlayN }) : null, g.market_view ? String(g.market_view).slice(0, 120) : null].filter(Boolean).join(SEP) || null,
      tone: "accent", value: null, valueFmt: null, ticker: null, href: href.gamePlan(String(g.d)), group: null, visibility: "public",
    });
  }

  // ── market ──
  const myTickers = Array.from(new Set([...held, ...myTraded, ...inPlay].map((r) => String(r.ticker)).filter(Boolean))).slice(0, 60);
  const mySet = new Set(myTickers);
  for (const e of events) {
    const tickers = String(e.ticker ?? "").split(/[,\s;/]+/).map((t) => t.trim()).filter(Boolean);
    const mine = tickers.filter((t) => mySet.has(t));
    const pm = num(e.pm);
    items.push({
      id: `event:${e.id}`, kind: "event", cats: mine.length ? ["market", "mine"] : ["market"], date: String(e.d),
      at: iso(e.at) ?? nyInstant(String(e.d), 8), trader: null, actor: null,
      title: `${tickers.slice(0, 3).join(", ")}${tickers.length > 3 ? ` +${tickers.length - 3}` : ""} · ${e.headline}`,
      subtitle: [String(e.event_type ?? ""), e.session ? String(e.session) : null, mine.length ? t("event.myTicker", { tickers: mine.slice(0, 3).join(", ") }) : null].filter(Boolean).join(SEP) || null,
      tone: pm == null ? (mine.length ? "accent" : "neutral") : pm >= 0 ? "up" : "down", value: pm, valueFmt: pm == null ? null : "pct",
      ticker: tickers[0] ?? null, href: href.events(tickers[0] ?? null), group: mine.length ? null : `events:${e.d}`, visibility: "public",
      meta: { mine: mine.length > 0 },
    });
  }

  items.sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id));

  const earliestTrade = days.length ? days.reduce((m, r) => (r.d < m ? r.d : m), days[0].d) : null;
  const earliestOther = earliestRows[0]?.d ? String(earliestRows[0].d) : null;
  const earliest = [earliestTrade, earliestOther].filter((x): x is string => !!x).sort()[0] ?? null;

  return { from, to, today, items, myTickers, earliest };
}

// ─── «new since last visit» (per member, server-side so it follows the user across devices) ──

let visitsEnsured: Promise<void> | null = null;
export function ensureFeedVisits(): Promise<void> {
  if (!visitsEnsured) {
    visitsEnsured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS feed_visits (
           user_name TEXT PRIMARY KEY,
           seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           prev_seen_at TIMESTAMPTZ
         )`,
      )
      .then(() => undefined)
      .catch((err) => {
        visitsEnsured = null;
        throw err;
      });
  }
  return visitsEnsured;
}

export async function getLastSeen(user: string): Promise<string | null> {
  await ensureFeedVisits();
  const { rows } = await pool.query<{ seen_at: Date }>(`SELECT seen_at FROM feed_visits WHERE user_name = $1`, [user]);
  return rows[0] ? rows[0].seen_at.toISOString() : null;
}

/** Moves the viewer's «last visit» to now; returns the previous value. */
export async function markSeen(user: string): Promise<{ seenAt: string; previous: string | null }> {
  await ensureFeedVisits();
  const { rows } = await pool.query<{ seen_at: Date; prev_seen_at: Date | null }>(
    `INSERT INTO feed_visits (user_name, seen_at) VALUES ($1, NOW())
     ON CONFLICT (user_name) DO UPDATE SET prev_seen_at = feed_visits.seen_at, seen_at = NOW()
     RETURNING seen_at, prev_seen_at`,
    [user],
  );
  return { seenAt: rows[0].seen_at.toISOString(), previous: rows[0].prev_seen_at ? rows[0].prev_seen_at.toISOString() : null };
}
