/**
 * Junior summaries — reviewer scope and per-junior signals for the senior's desk (routes/junior-notes.ts).
 * Pure functions only (unit-tested in __tests__/juniorReview.test.ts); the DB lookups live in the route.
 *
 * Who reviews:
 *   - "desk"   — journal.review at desk scope (curator / admin by default): every junior.
 *   - "scoped" — journal.review at "assigned" scope (wards) and/or an academy mentor (users.assigned_mentor or the
 *                mentor of an active cohort the junior is enrolled in): only those juniors. A trader who mentors
 *                juniors reviews, scores and reminds their own mentees — nobody else.
 *   - "none"   — everyone else (reads only their own summaries — canReadJuniorNotes / juniorTeamFilter).
 * Nobody reviews their own summary.
 */
import { juniorReviewT } from "../i18n/ns";
import type { Lang } from "../i18n";

export type ReviewScope =
  | { kind: "desk"; mine: string[] }
  | { kind: "scoped"; via: "assigned" | "mentor"; traders: string[]; mine: string[] }
  | { kind: "none" };

export interface ReviewScopeInput {
  me: string;
  guest: boolean;
  /** journal.review grant of the actor's role. */
  capAllowed: boolean;
  capScope: "desk" | "assigned" | null;
  /** Wards under "assigned" scope (assigned_curator / risk manager / mentor = me). */
  wards: readonly string[];
  /** Academy mentees: users.assigned_mentor = me + live enrollments of cohorts I mentor. */
  mentees: readonly string[];
  /** users.assigned_curator = me (the curator's own juniors for the «Мои джуны» filter). */
  curated: readonly string[];
}

function uniq(list: Iterable<string>, me: string): string[] {
  return [...new Set([...list].map((s) => s.trim()).filter((s) => s && s !== me))].sort((a, b) => a.localeCompare(b, "ru"));
}

export function buildReviewScope(i: ReviewScopeInput): ReviewScope {
  if (i.guest || !i.me) return { kind: "none" };
  if (i.capAllowed && i.capScope !== "assigned") return { kind: "desk", mine: uniq([...i.curated, ...i.mentees], i.me) };
  if (i.capAllowed) {
    const traders = uniq([...i.wards, ...i.mentees], i.me);
    return { kind: "scoped", via: "assigned", traders, mine: traders };
  }
  const mentees = uniq(i.mentees, i.me);
  if (mentees.length) return { kind: "scoped", via: "mentor", traders: mentees, mine: mentees };
  return { kind: "none" };
}

export function canReviewTrader(scope: ReviewScope, trader: string | null | undefined, me: string): boolean {
  const t = trader?.trim();
  if (!t || t === me) return false;
  if (scope.kind === "desk") return true;
  if (scope.kind === "scoped") return scope.traders.includes(t);
  return false;
}

/**
 * Traders a reviewer list should contain: null = everyone (desk, all), string[] = only these names.
 * `mineOnly` narrows a desk reviewer to their own juniors; scoped reviewers are always narrowed.
 */
export function reviewTraderFilter(scope: ReviewScope, mineOnly: boolean): string[] | null {
  if (scope.kind === "desk") return mineOnly ? scope.mine : null;
  if (scope.kind === "scoped") return scope.traders;
  return [];
}

/* ─────────────────────────── Who may READ summaries ─────────────────────────── */

/**
 * The reader of junior summaries. `teamScope` = journal.read.team readable traders (lib/permissionsMatrix
 * readableTraders): null = the whole desk (curators/admins by default), string[] = only these names.
 */
export interface JuniorNotesViewer {
  me: string;
  guest: boolean;
  teamScope: readonly string[] | null;
}

/**
 * May the viewer read `trader`'s summaries (text, curator feedback, score)? The junior themself, a reviewer of
 * that junior (desk reviewer / assigned curator / academy mentor — `scope`), or a holder of journal.read.team that
 * covers the trader. Guests never.
 */
export function canReadJuniorNotes(viewer: JuniorNotesViewer, scope: ReviewScope, trader: string | null | undefined): boolean {
  const t = trader?.trim();
  if (viewer.guest || !viewer.me || !t) return false;
  if (t === viewer.me) return true;
  if (viewer.teamScope === null || viewer.teamScope.includes(t)) return true;
  return canReviewTrader(scope, t, viewer.me);
}

/**
 * Which juniors GET /junior-notes/team may list: null = everyone (desk reviewer or desk-wide journal.read.team),
 * string[] = only these names (always the viewer's own, plus wards / mentees). Guests: nobody.
 */
export function juniorTeamFilter(viewer: JuniorNotesViewer, scope: ReviewScope): string[] | null {
  if (viewer.guest || !viewer.me) return [];
  if (viewer.teamScope === null || scope.kind === "desk") return null;
  const names = new Set<string>([viewer.me, ...viewer.teamScope]);
  if (scope.kind === "scoped") scope.traders.forEach((t) => names.add(t));
  return [...names].sort((a, b) => a.localeCompare(b, "ru"));
}

/* ─────────────────────────── Trading-day helpers ─────────────────────────── */

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isWeekend(iso: string): boolean {
  const wd = new Date(iso + "T00:00:00Z").getUTCDay();
  return wd === 0 || wd === 6;
}
function prevTradingDay(iso: string): string {
  let d = addDays(iso, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

/**
 * Consecutive trading days without a summary, counting back from `date` (inclusive; a weekend `date` starts from
 * the Friday before). Capped at `max`. 0 when the junior wrote on `date`.
 */
export function missedRun(dates: ReadonlySet<string>, date: string, max = 10): number {
  let d = date;
  while (isWeekend(d)) d = addDays(d, -1);
  let n = 0;
  while (!dates.has(d) && n < max) { n++; d = prevTradingDay(d); }
  return n;
}

/* ─────────────────────────── Score trend ─────────────────────────── */

export interface ScoredNote { note_date: string; curator_score: number | null }

export interface ScoreTrend {
  /** Last `n` scored notes, oldest first. */
  scores: { date: string; score: number }[];
  avg: number | null;
  /** Mean of the last 3 scores. */
  recent: number | null;
  /** recent − mean of the 3 scores before them (null when fewer than 4 scores). */
  delta: number | null;
  direction: "up" | "down" | "flat" | null;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function scoreTrend(notes: readonly ScoredNote[], n = 10): ScoreTrend {
  const scored = notes
    .filter((x) => x.curator_score != null && Number.isFinite(x.curator_score))
    .map((x) => ({ date: x.note_date, score: Number(x.curator_score) }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-n);
  const vals = scored.map((s) => s.score);
  const avg = mean(vals);
  const recentVals = vals.slice(-3);
  const prevVals = vals.slice(-6, -3);
  const recent = mean(recentVals);
  const delta = recent != null && prevVals.length ? recent - mean(prevVals)! : null;
  const direction = delta == null ? null : delta >= 0.5 ? "up" : delta <= -0.5 ? "down" : "flat";
  return {
    scores: scored,
    avg: avg == null ? null : round1(avg),
    recent: recent == null ? null : round1(recent),
    delta: delta == null ? null : round1(delta),
    direction,
  };
}

/* ─────────────────────────── Repeated mistakes ─────────────────────────── */

/**
 * Mistake categories recognised in the «Ошибки» section (lower-cased, ё→е). Plain keyword stems — no AI.
 * Cyrillic needs explicit [а-я] classes: \w in JS regexps is ASCII only.
 */
/** Display label of a mistake category in `lang` (juniorReview namespace `mistake.*`). */
export function mistakeLabel(key: string, lang: Lang = "ru"): string {
  return juniorReviewT.tryFor(lang, `mistake.${key}`) ?? key;
}

export const MISTAKE_PATTERNS: readonly { key: string; label: string; re: RegExp }[] = [
  { key: "fomo", label: mistakeLabel("fomo"), re: /fomo|фомо|упустить|догон|погнал|погон[яе]|запрыгнул|впрыгнул/ },
  { key: "early_entry", label: mistakeLabel("early_entry"), re: /ран(ний|ние|него|о)\s+вх?о|рано\s+(за|во)[шй]|(вошел|зашел|вошла|зашла)\s+рано|не\s+дожд(ал|ался|алась)/ },
  { key: "moved_stop", label: mistakeLabel("moved_stop"), re: /(двинул|двигал|сдвинул|передвинул|отодвинул|убрал|перенес|расширил)[а-я]*\s+(свой\s+)?стоп|стоп[а-я]*\s+(двинул|сдвинул|убрал|отодвинул|передвинул)/ },
  { key: "no_stop", label: mistakeLabel("no_stop"), re: /без\s+стоп|не\s+(поставил|выставил|ставил)\s+стоп|стопа\s+не\s+было/ },
  { key: "overtrading", label: mistakeLabel("overtrading"), re: /переторг|овертрейд|overtrad|слишком\s+много\s+сделок|лишн[а-я]*\s+сделк/ },
  { key: "size", label: mistakeLabel("size"), re: /(завысил|превысил|увеличил)\s+размер|размер[а-я]*\s+(больше|выше|сверх|завыш)|большой\s+размер|оверсайз|oversiz/ },
  { key: "revenge", label: mistakeLabel("revenge"), re: /отыгр|отбить|ревендж|revenge/ },
  { key: "off_plan", label: mistakeLabel("off_plan"), re: /не\s+по\s+плану|вне\s+плана|без\s+плана|отош[а-я]*\s+от\s+плана|нарушил\s+план|не\s+по\s+сетапу|не\s+мой\s+сетап/ },
  { key: "early_exit", label: mistakeLabel("early_exit"), re: /рано\s+(вышел|закрыл|зафикс|скинул)|(вышел|закрыл|зафиксировал|скинул)\s+рано|раньше\s+времени|не\s+дал[а-я]*\s+(сделке\s+)?отработ/ },
  { key: "held_loser", label: mistakeLabel("held_loser"), re: /пересидел|передержал|держал\s+(лосс|убыт|минус)|поздно\s+(вышел|закрыл)|не\s+закрыл\s+вовремя/ },
  { key: "averaging", label: mistakeLabel("averaging"), re: /усредн|доливал(ся)?\s+в\s+минус/ },
  { key: "daily_limit", label: mistakeLabel("daily_limit"), re: /(нарушил|превысил|пробил|пробит)[а-я]*\s+(дневн[а-я]*\s+)?лимит|лимит[а-я]*\s+(дня|на\s+день)\s+(пробит|нарушен|превышен)/ },
  { key: "emotions", label: mistakeLabel("emotions"), re: /эмоци|тильт|tilt|импульсив|психанул|злил/ },
];

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е"); // i18n-ignore (RU input normalisation)
}

/** Category keys found in one text (each at most once). */
export function mistakeKeys(text: string | null | undefined): string[] {
  if (!text || !text.trim()) return [];
  const t = normalizeText(text);
  return MISTAKE_PATTERNS.filter((p) => p.re.test(t)).map((p) => p.key);
}

export interface RepeatedMistake { key: string; label: string; count: number; last: string }

/**
 * Categories that occur in at least `minNotes` different notes, most frequent first (ties → most recent).
 * `notes` carry the «Ошибки» text (fallback: whole note text when the junior writes free-form).
 */
export function repeatedMistakes(
  notes: readonly { note_date: string; text: string | null | undefined }[],
  opts: { minNotes?: number; top?: number; lang?: Lang } = {},
): RepeatedMistake[] {
  const minNotes = opts.minNotes ?? 2;
  const top = opts.top ?? 3;
  const acc = new Map<string, { count: number; last: string }>();
  for (const n of notes) {
    for (const k of mistakeKeys(n.text)) {
      const cur = acc.get(k) ?? { count: 0, last: "" };
      cur.count++;
      if (n.note_date > cur.last) cur.last = n.note_date;
      acc.set(k, cur);
    }
  }
  return [...acc.entries()]
    .filter(([, v]) => v.count >= minNotes)
    .map(([key, v]) => ({ key, label: mistakeLabel(key, opts.lang), count: v.count, last: v.last }))
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
    .slice(0, top);
}

/* ─────────────────────────── Attention («что требует внимания») ─────────────────────────── */

export type AttentionKind = "unanswered" | "missed" | "low_score" | "falling" | "repeat";

export interface AttentionFlag {
  kind: AttentionKind;
  label: string;
  tone: "down" | "warn" | "accent";
}

export interface AttentionInput {
  /** Wrote a summary for the day being viewed. */
  wrote: boolean;
  /** That summary already has a reviewer answer. */
  reviewed: boolean;
  /** Written summaries over the last 14 days without an answer (including the viewed day). */
  unreviewed14: number;
  /** Consecutive trading days without a summary up to the viewed day. */
  missed: number;
  /** Has written at least one summary in the window (new juniors are not «missing» forever). */
  everWrote: boolean;
  trend: Pick<ScoreTrend, "recent" | "direction" | "delta">;
  repeated: readonly (Pick<RepeatedMistake, "label" | "count"> & { key?: string })[];
}

/**
 * Flags for one junior + a sort priority (higher = look first). The senior's desk sorts juniors by it so the
 * people who need an answer, a nudge or a conversation are on top.
 */
export function attentionOf(i: AttentionInput, lang: Lang = "ru"): { flags: AttentionFlag[]; priority: number } {
  const t = juniorReviewT.tFor(lang);
  const flags: AttentionFlag[] = [];
  let p = 0;
  if (i.unreviewed14 > 0) {
    flags.push({
      kind: "unanswered",
      label: i.unreviewed14 === 1 ? t("attention.waiting") : t("attention.unanswered", { n: i.unreviewed14 }),
      tone: "accent",
    });
    p += 30 + Math.min(i.unreviewed14, 10) * 3;
  }
  if (i.missed >= 2 || (i.missed >= 1 && !i.everWrote)) {
    flags.push({
      kind: "missed",
      label: i.everWrote ? t("attention.missed", { n: i.missed >= 10 ? "10+" : i.missed }) : t("attention.never"),
      tone: i.missed >= 3 ? "down" : "warn",
    });
    p += i.everWrote ? 20 + Math.min(i.missed, 10) * 4 : 15;
  }
  if (i.trend.recent != null && i.trend.recent <= 2.5) {
    flags.push({ kind: "low_score", label: t("attention.low", { score: i.trend.recent.toFixed(1) }), tone: "down" });
    p += 25;
  } else if (i.trend.direction === "down") {
    flags.push({ kind: "falling", label: t("attention.falling", { delta: String(i.trend.delta?.toFixed(1)) }), tone: "warn" });
    p += 12;
  }
  const rep = i.repeated[0];
  if (rep && rep.count >= 3) {
    flags.push({ kind: "repeat", label: t("attention.repeat", { mistake: lowerFirst(rep.key ? mistakeLabel(rep.key, lang) : rep.label), count: rep.count }), tone: "warn" });
    p += 8 + Math.min(rep.count, 10);
  }
  return { flags, priority: p };
}

/* ─────────────────────────── Day trades for the review sheet ─────────────────────────── */

export interface ContextTradeRow {
  id: number;
  trader: string;
  ticker: string;
  side: string | null;
  setup: string | null;
  horizon: string;
  result: string | null;
  date: string;
  exit_date: string | null;
  r: number | null;
  pnl_net: number | null;
}

export interface ContextDayTrades {
  /** Opened on the summary day. */
  opened: ContextTradeRow[];
  /** Overnight / swing positions opened earlier and still held (or closed) on that day. */
  carried: ContextTradeRow[];
  totals: { count: number; wins: number; losses: number; r: number | null; pnl_net: number | null };
  /** false → every $ field is null (reviewer is a mentor-trader, not staff and not the owner). */
  money_visible: boolean;
}

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Splits a junior's trades around `date` and applies the money rule of lib/playbookPrivacy (owner or staff see $,
 * everyone else R only). R totals are always shown.
 */
export function buildDayTrades(
  rows: readonly ContextTradeRow[],
  date: string,
  owner: string,
  viewer: { name: string | null; staff: boolean },
  canSeeMoney: (v: { name: string | null; staff: boolean }, trader: string) => boolean,
): ContextDayTrades {
  const money = canSeeMoney(viewer, owner);
  const clean = (t: ContextTradeRow): ContextTradeRow => ({
    ...t,
    r: numOrNull(t.r),
    pnl_net: money ? numOrNull(t.pnl_net) : null,
  });
  const opened = rows.filter((t) => t.date === date).map(clean);
  const carried = rows
    .filter((t) => t.date < date && t.horizon !== "intraday" && (!t.exit_date || t.exit_date >= date))
    .map(clean);
  const rs = opened.map((t) => t.r).filter((v): v is number => v != null);
  const pnls = opened.map((t) => t.pnl_net).filter((v): v is number => v != null);
  return {
    opened,
    carried,
    totals: {
      count: opened.length,
      wins: opened.filter((t) => t.result === "win").length,
      losses: opened.filter((t) => t.result === "loss").length,
      r: rs.length ? Math.round(rs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
      pnl_net: money && pnls.length ? Math.round(pnls.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    },
    money_visible: money,
  };
}

/** «Early entry» → «early entry», but keeps acronyms such as «FOMO / chasing». */
function lowerFirst(s: string): string {
  return s.length > 1 && s[1] === s[1]!.toLowerCase() ? s[0]!.toLowerCase() + s.slice(1) : s;
}
