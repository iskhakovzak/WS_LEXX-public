/**
 * «Группа» / «Группы» — pure model for the curator cabinet: a curator's group = traders whose users.assigned_curator
 * is that curator (the column stores the curator's NAME). Grouping, filters, totals, sorting keys and CSV rows.
 */
import { prepareQuery, searchItems, type MatchResult, type PreparedQuery } from "@workspace/text-search";
import type { TraderSignal } from "./api";
import { comparePersonNames, personName } from "@/i18n";
import { curatorI18n } from "@/i18n/ns/curator";

/** "all" — every group as sections; "none" — «Без куратора»; any other value — that curator's name. */
export type GroupKey = string;
export const ALL_GROUPS = "all";
export const NO_CURATOR = "none";

export type ActivityFilter = "all" | "active" | "idle";
export type GroupFilters = {
  risk: boolean;        // at risk right now: stopped or near the stop
  violations: boolean;  // breach alerts this week
  pending: boolean;     // something waits for the curator's review
  activity: ActivityFilter;
  idleDays: number;     // «no trades N days» threshold
  tier: string;         // "" = any; tier key
};
export const DEFAULT_FILTERS: GroupFilters = { risk: false, violations: false, pending: false, activity: "all", idleDays: 5, tier: "" };

export const pendingReviews = (s: TraderSignal) => s.eod.pending + (s.weekly.submittedPending ? 1 : 0) + s.academy.pendingSubmissions;
export const isRiskNow = (s: TraderSignal) => s.risk.halted || s.risk.nearStop;
export const breachesWeek = (s: TraderSignal) => s.breaches.week ?? 0;

/** Whole days between the last trade day and `today` (YYYY-MM-DD); null — never traded. */
export function daysSinceTrade(s: TraderSignal, today: string): number | null {
  if (!s.lastTradeDate) return null;
  const a = Date.parse(`${s.lastTradeDate.slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${today}T12:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86_400_000)) : null;
}

export function isIdle(s: TraderSignal, today: string, days: number): boolean {
  const d = daysSinceTrade(s, today);
  return d == null || d >= days;
}

export function applyFilters(list: readonly TraderSignal[], f: GroupFilters, today: string): TraderSignal[] {
  return list.filter((s) =>
    (!f.risk || isRiskNow(s))
    && (!f.violations || breachesWeek(s) > 0)
    && (!f.pending || pendingReviews(s) > 0)
    && (f.activity === "all" || (f.activity === "idle" ? isIdle(s, today, f.idleDays) : !isIdle(s, today, f.idleDays)))
    && (!f.tier || s.tier === f.tier),
  );
}

export function activeFilterCount(f: GroupFilters): number {
  return [f.risk, f.violations, f.pending, f.activity !== "all", !!f.tier].filter(Boolean).length;
}

export type SearchMark = Pick<MatchResult, "ranges"> & { field: number };

/**
 * Cross-script search over the trader's name, Latin alias (primary) and curator / stage / tier (secondary).
 * Fields hold the names as shown first, so the highlight lands on the displayed text: 0 the trader as shown
 * (personName: Latin in EN / UZ when set), 1 the other spelling (Latin alias in Russian, stored name otherwise),
 * 2 the curator as shown; 5 the stored curator name and 6 a differing Latin alias are searched without display.
 * Returns matching traders in input order plus the highlight info per trader.
 */
export function searchTraders(list: readonly TraderSignal[], query: string | PreparedQuery): { list: TraderSignal[]; marks: Map<string, SearchMark> } {
  const pq = typeof query === "string" ? prepareQuery(query) : query;
  const marks = new Map<string, SearchMark>();
  if (pq.empty) return { list: [...list], marks };
  const hits = searchItems(list, pq, (s) => {
    const shown = personName(s.trader);
    const other = shown === s.trader ? s.nameLatin ?? null : s.trader;
    return [
      shown, other,
      { text: s.curator ? personName(s.curator) : null, weight: 0.5 }, { text: s.stage.label, weight: 0.5 }, { text: s.tierName, weight: 0.5 },
      { text: s.curator && personName(s.curator) !== s.curator ? s.curator : null, weight: 0.5 },
      s.nameLatin && s.nameLatin !== shown && s.nameLatin !== other ? s.nameLatin : null,
    ];
  });
  for (const h of hits) marks.set(h.item.trader, { ranges: h.ranges, field: h.field });
  return { list: list.filter((s) => marks.has(s.trader)), marks };
}

export type GroupTotals = {
  traders: number; today: number | null; week: number | null; month: number | null;
  violations: number; pending: number; atRisk: number; idle: number;
};

const sumOrNull = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) * 100) / 100 : null;
};

export function groupTotals(list: readonly TraderSignal[], today: string, idleDays: number): GroupTotals {
  return {
    traders: list.length,
    today: sumOrNull(list.map((s) => (s.risk.todayTrades ? s.risk.todayPnl : null))),
    week: sumOrNull(list.map((s) => s.risk.weekPnl)),
    month: sumOrNull(list.map((s) => s.month?.pnl ?? null)),
    violations: list.reduce((a, s) => a + breachesWeek(s), 0),
    pending: list.reduce((a, s) => a + pendingReviews(s), 0),
    atRisk: list.filter(isRiskNow).length,
    idle: list.filter((s) => isIdle(s, today, idleDays)).length,
  };
}

export type Group = { key: GroupKey; curator: string | null; traders: TraderSignal[] };

/**
 * Sections for «Все группы»: one per curator (including curators with an empty group when `curators` lists them),
 * the viewer's own group first, then by name; «Без куратора» last.
 */
export function buildGroups(list: readonly TraderSignal[], curators: readonly string[], me: string | null): Group[] {
  const by = new Map<string, TraderSignal[]>();
  const none: TraderSignal[] = [];
  for (const s of list) {
    const c = s.curator ?? null;
    if (!c) { none.push(s); continue; }
    const arr = by.get(c);
    if (arr) arr.push(s); else by.set(c, [s]);
  }
  for (const c of curators) if (!by.has(c)) by.set(c, []);
  const names = [...by.keys()].sort((a, b) => (a === me ? -1 : b === me ? 1 : comparePersonNames(a, b)));
  const out: Group[] = names.map((c) => ({ key: c, curator: c, traders: by.get(c)! }));
  out.push({ key: NO_CURATOR, curator: null, traders: none });
  return out;
}

/** Traders of one group key (curator name / NO_CURATOR / ALL_GROUPS). */
export function tradersOf(list: readonly TraderSignal[], key: GroupKey): TraderSignal[] {
  if (key === ALL_GROUPS) return [...list];
  if (key === NO_CURATOR) return list.filter((s) => !s.curator);
  return list.filter((s) => s.curator === key);
}

/** Sort accessors for the group table (numbers ascend; null last). */
export const GROUP_SORT = {
  trader: (s: TraderSignal) => personName(s.trader),
  curator: (s: TraderSignal) => (s.curator ? personName(s.curator) : null),
  tier: (s: TraderSignal) => s.tierName ?? null,
  stage: (s: TraderSignal) => s.stage.label ?? null,
  today: (s: TraderSignal) => (s.risk.todayTrades ? s.risk.todayPnl : null),
  week: (s: TraderSignal) => s.risk.weekPnl,
  month: (s: TraderSignal) => s.month?.pnl ?? null,
  violations: (s: TraderSignal) => breachesWeek(s) * 1000 + s.breaches.unreviewed,
  pending: (s: TraderSignal) => pendingReviews(s),
  activity: (s: TraderSignal) => s.lastActivityAt ?? s.lastTradeDate ?? null,
  risk: (s: TraderSignal) => (s.risk.halted ? 3 : s.risk.nearStop ? 2 : s.risk.hasLimits ? 1 : 0),
  attention: (s: TraderSignal) => s.nextAction.priority,
} as const;
export type GroupSortKey = keyof typeof GROUP_SORT;

const CSV_COLS = ["trader", "latin", "curator", "tier", "stage", "today", "todayTrades", "week", "month", "monthTrades",
  "violationsWeek", "violationsUnreviewed", "pending", "lastTrade", "lastActivity", "risk", "next"] as const;
/** CSV header in the current language (call when exporting). */
export function csvHead(): string[] {
  return CSV_COLS.map((k) => curatorI18n.t(`group.csv.${k}`));
}

export function csvRow(s: TraderSignal): (string | number | null)[] {
  return [
    s.trader, s.nameLatin ?? "", personName(s.curator), s.tierName ?? "", s.stage.label ?? "",
    s.risk.todayTrades ? s.risk.todayPnl : null, s.risk.todayTrades, s.risk.weekPnl, s.month?.pnl ?? null, s.month?.trades ?? null,
    breachesWeek(s), s.breaches.unreviewed, pendingReviews(s), s.lastTradeDate ?? "", s.lastActivityAt ?? "",
    s.risk.hasLimits ? s.risk.label : curatorI18n.t("noLimits"), s.nextAction.label,
  ];
}
