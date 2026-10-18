/**
 * Pure helpers for event → notification producers (routes/discussions, risk, eod, scaling, ratings, weekly-review,
 * propreports). No DB queries / Express, so the dedup keys, recipient selection and texts can be checked offline and
 * by unit tests. Texts come from the server `risk` / `propreports` namespaces in the requested language (default RU,
 * the stored fallback); notifications store `params` and are rendered per reader (lib/notificationRenderers/risk.ts).
 * DB side lives in lib/notifyEvents.ts.
 */

import { riskT, propreportsT } from "../i18n/ns";
import { rulesT } from "./rulesI18n";
import type { Lang } from "../i18n";
import { personNameFor } from "./people/latinNames";

// ─── formatting ─────────────────────────────────────────────────────────────

/** "$1,234" (absolute, rounded to dollars). */
export function fmtUsd(v: number): string {
  return `$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
}

/** "+$340" / "−$162" / "$0"; null → "—". Uses the typographic minus. */
export function fmtSignedUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const r = Math.round(v);
  return `${r < 0 ? "−" : r > 0 ? "+" : ""}${fmtUsd(r)}`;
}

/** Loss limit written as a negative amount: 150 → "−$150". */
export function fmtLossLimit(v: number): string {
  return `−${fmtUsd(v)}`;
}

/** Russian plural: plural(3, "сделка", "сделки", "сделок") → "сделки". */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** One-line preview of free text (whitespace collapsed, ellipsis when cut). */
export function preview(text: string | null | undefined, max = 100): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// ─── recipients ─────────────────────────────────────────────────────────────

/**
 * De-duplicated, trimmed, non-empty recipients without the excluded names (usually the actor — nobody is
 * notified about their own action). Order of first appearance is kept.
 */
export function uniqueRecipients(
  names: Iterable<string | null | undefined>,
  exclude: string | null | undefined | ReadonlyArray<string | null | undefined> = null,
): string[] {
  const ex = new Set((Array.isArray(exclude) ? exclude : [exclude]).filter((x): x is string => !!x).map((x) => x.trim()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const n = (raw ?? "").trim();
    if (!n || ex.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// ─── dedup keys ─────────────────────────────────────────────────────────────

/** At most one risk notification per type per trader per (NY) trading day. */
export function riskDedupKey(type: "risk_warn" | "risk_breach", trader: string, date: string): string {
  return `risk:${type}:${trader}:${date}`;
}

/** One overdue alert per closed day; a re-close (new closed_at) may alert again. */
export function eodOverdueKey(dayId: number, closedAt: Date | string): string {
  const iso = closedAt instanceof Date ? closedAt.toISOString() : new Date(closedAt).toISOString();
  return `eod_overdue:${dayId}:${iso}`;
}

// ─── risk ───────────────────────────────────────────────────────────────────

export type RiskSnapshot = {
  trader: string;
  /** computeStop state (ok / no_limits produce no notice). */
  state: string;
  halted: boolean;
  /** Losses as positive numbers. */
  todayLoss: number;
  weekLoss: number;
  currentDd: number;
  dailyLimit: number | null;
  weeklyLimit: number | null;
  maxDrawdown: number | null;
  dailyPct: number | null;
  weeklyPct: number | null;
  drawdownPct: number | null;
  warnPct: number;
};

export type RiskNotice = {
  type: "risk_warn" | "risk_breach";
  /** «дневной лимит −$150 превышен (−$162)» — no subject, lower-case start. */
  core: string;
  traderTitle: string;
  traderBody: string;
  staffTitle: string;
  staffBody: string;
  /** Text as data: store with the notification (variant "trader" | "staff" is added per recipient). */
  params: RiskNoticeParams;
};

/** Params of risk_warn / risk_breach notifications: the snapshot numbers (renderer: lib/notificationRenderers/risk.ts). */
export type RiskNoticeParams = {
  trader: string; state: string; halted: number;
  todayLoss: number; weekLoss: number; currentDd: number;
  dailyLimit?: number; weeklyLimit?: number; maxDrawdown?: number;
  dailyPct?: number; weeklyPct?: number; drawdownPct?: number; warnPct: number;
};

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const opt = (v: number | null | undefined): number | undefined => (v == null || !Number.isFinite(v) ? undefined : v);

export function riskNoticeParams(s: RiskSnapshot): RiskNoticeParams {
  return {
    trader: s.trader, state: s.state, halted: s.halted ? 1 : 0,
    todayLoss: s.todayLoss, weekLoss: s.weekLoss, currentDd: s.currentDd,
    dailyLimit: opt(s.dailyLimit), weeklyLimit: opt(s.weeklyLimit), maxDrawdown: opt(s.maxDrawdown),
    dailyPct: opt(s.dailyPct), weeklyPct: opt(s.weeklyPct), drawdownPct: opt(s.drawdownPct), warnPct: s.warnPct,
  };
}

/** Snapshot back from stored params (null when they are not risk-notice params). */
export function riskSnapshotFromParams(p: Record<string, unknown>): RiskSnapshot | null {
  const n = (k: string): number | null => (typeof p[k] === "number" && Number.isFinite(p[k] as number) ? (p[k] as number) : null);
  if (typeof p.trader !== "string" || typeof p.state !== "string") return null;
  return {
    trader: p.trader, state: p.state, halted: n("halted") === 1,
    todayLoss: n("todayLoss") ?? 0, weekLoss: n("weekLoss") ?? 0, currentDd: n("currentDd") ?? 0,
    dailyLimit: n("dailyLimit"), weeklyLimit: n("weeklyLimit"), maxDrawdown: n("maxDrawdown"),
    dailyPct: n("dailyPct"), weeklyPct: n("weeklyPct"), drawdownPct: n("drawdownPct"), warnPct: n("warnPct") ?? 70,
  };
}

/** Notice with exact numbers for a stop/warn state in `lang` (default RU = stored fallback); null when nothing to say. */
export function riskNotice(s: RiskSnapshot, lang: Lang = "ru"): RiskNotice | null {
  const t = riskT.tFor(lang);
  let core: string;
  let bodyKey: "drawdown" | "weekly" | "stop" | "warn";
  if (s.state === "drawdown" && s.maxDrawdown != null) {
    core = t("notify.core.drawdown", { limit: fmtUsd(s.maxDrawdown), used: fmtUsd(s.currentDd) });
    bodyKey = "drawdown";
  } else if (s.state === "weekly" && s.weeklyLimit != null) {
    core = t("notify.core.weekly", { limit: fmtLossLimit(s.weeklyLimit), used: fmtSignedUsd(-s.weekLoss) });
    bodyKey = "weekly";
  } else if (s.state === "stop" && s.dailyLimit != null) {
    core = t("notify.core.stop", { limit: fmtLossLimit(s.dailyLimit), used: fmtSignedUsd(-s.todayLoss) });
    bodyKey = "stop";
  } else if (s.state === "warn") {
    const parts: string[] = [];
    if (s.dailyLimit != null && s.dailyPct != null && s.dailyPct >= s.warnPct) parts.push(t("notify.warnPart.daily", { used: fmtSignedUsd(-s.todayLoss), limit: fmtLossLimit(s.dailyLimit), pct: Math.round(s.dailyPct) }));
    if (s.weeklyLimit != null && s.weeklyPct != null && s.weeklyPct >= s.warnPct) parts.push(t("notify.warnPart.weekly", { used: fmtSignedUsd(-s.weekLoss), limit: fmtLossLimit(s.weeklyLimit), pct: Math.round(s.weeklyPct) }));
    if (s.maxDrawdown != null && s.drawdownPct != null && s.drawdownPct >= s.warnPct) parts.push(t("notify.warnPart.drawdown", { used: fmtUsd(s.currentDd), limit: fmtUsd(s.maxDrawdown), pct: Math.round(s.drawdownPct) }));
    if (!parts.length) return null;
    core = parts.join("; ");
    bodyKey = "warn";
  } else {
    return null;
  }
  const type = s.halted ? "risk_breach" : "risk_warn";
  const label = t(type === "risk_breach" ? "notify.label.risk_breach" : "notify.label.risk_warn");
  return {
    type,
    core,
    traderTitle: cap(label),
    traderBody: t(`notify.traderBody.${bodyKey}`, { core: cap(core) }),
    staffTitle: t("notify.staffTitle", { trader: personNameFor(s.trader, lang), label }),
    staffBody: t("notify.staffBody", { trader: personNameFor(s.trader, lang), core }),
    params: riskNoticeParams(s),
  };
}

/** Label + message of a halted stop state (drawdown / weekly / stop) in `lang`; null for other states. Amounts: positive. */
export function haltedStopText(state: string, used: number, limit: number, lang: Lang = "ru"): { label: string; message: string } | null {
  if (state !== "drawdown" && state !== "weekly" && state !== "stop") return null;
  const t = riskT.tFor(lang);
  return { label: t(`stop.${state}.label`), message: t(`stop.${state}.message`, { used: fmtUsd(used), limit: fmtUsd(limit) }) };
}

// ─── limits ─────────────────────────────────────────────────────────────────

export type LimitsLike = {
  dailyLossLimit?: number | null;
  weeklyLossLimit?: number | null;
  maxDrawdown?: number | null;
  maxRiskPerTrade?: number | null;
  maxPositionUsd?: number | null;
  maxOpenPositions?: number | null;
  tier?: string | null;
};

const LIMIT_FIELDS: ReadonlyArray<{ key: keyof LimitsLike; money: boolean }> = [
  { key: "dailyLossLimit", money: true },
  { key: "weeklyLossLimit", money: true },
  { key: "maxDrawdown", money: true },
  { key: "maxRiskPerTrade", money: true },
  { key: "maxPositionUsd", money: true },
  { key: "maxOpenPositions", money: false },
  { key: "tier", money: false },
];

/** «дневной $150 → $200» parts (in `lang`) for the fields that changed (null = «нет»). Tier keys → names. */
export function limitsDiff(before: LimitsLike | null | undefined, after: LimitsLike | null | undefined, lang: Lang = "ru"): string[] {
  const t = riskT.tFor(lang);
  const out: string[] = [];
  const show = (v: unknown, money: boolean, key?: string) =>
    v == null || v === "" ? t("diff.none") : money ? fmtUsd(Number(v)) : key === "tier" ? riskT.tryFor(lang, `tier.${String(v)}`) ?? String(v) : String(v);
  for (const f of LIMIT_FIELDS) {
    const a = before?.[f.key] ?? null;
    const b = after?.[f.key] ?? null;
    const same = f.money || f.key === "maxOpenPositions" ? (a == null ? null : Number(a)) === (b == null ? null : Number(b)) : a === b;
    if (!same) out.push(t("diff.change", { label: t(`diff.${f.key}`), from: show(a, f.money, f.key), to: show(b, f.money, f.key) }));
  }
  return out;
}

/** Changed limit fields as data `{ field, from, to }` (audit details; the admin UI renders this shape). */
export function limitsDiffItems(before: LimitsLike | null | undefined, after: LimitsLike | null | undefined): Array<{ field: keyof LimitsLike; from: number | string | null; to: number | string | null }> {
  const out: Array<{ field: keyof LimitsLike; from: number | string | null; to: number | string | null }> = [];
  for (const f of LIMIT_FIELDS) {
    const a = before?.[f.key] ?? null;
    const b = after?.[f.key] ?? null;
    const norm = (v: unknown) => (v == null || v === "" ? null : f.money || f.key === "maxOpenPositions" ? Number(v) : String(v));
    const same = f.money || f.key === "maxOpenPositions" ? norm(a) === norm(b) : a === b;
    if (!same) out.push({ field: f.key, from: norm(a), to: norm(b) });
  }
  return out;
}

/** Flat params of a before/after limits pair (b_* / a_*), for limit_change notifications rendered per reader. */
export function limitsDiffParams(before: LimitsLike | null | undefined, after: LimitsLike | null | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const f of LIMIT_FIELDS) {
    for (const [prefix, row] of [["b_", before], ["a_", after]] as const) {
      const v = row?.[f.key];
      if (v == null || v === "") continue;
      out[`${prefix}${f.key}`] = f.money || f.key === "maxOpenPositions" ? Number(v) : String(v);
    }
  }
  return out;
}

/** Inverse of limitsDiffParams. */
export function limitsFromParams(p: Record<string, unknown>, prefix: "b_" | "a_"): LimitsLike {
  const out: LimitsLike = {};
  for (const f of LIMIT_FIELDS) {
    const v = p[`${prefix}${f.key}`];
    if (v == null || v === "") continue;
    (out as Record<string, unknown>)[f.key] = f.money || f.key === "maxOpenPositions" ? Number(v) : String(v);
  }
  return out;
}

/** «дневной $300, недельный $900, просадка $2,000» for a tier / limits row (skips empty values), in `lang`. */
export function limitsSummary(l: LimitsLike | null | undefined, lang: Lang = "ru"): string {
  if (!l) return "";
  const t = riskT.tFor(lang);
  const parts: string[] = [];
  if (l.dailyLossLimit != null) parts.push(t("diff.summaryItem", { label: t("diff.dailyLossLimit"), value: fmtUsd(l.dailyLossLimit) }));
  if (l.weeklyLossLimit != null) parts.push(t("diff.summaryItem", { label: t("diff.weeklyLossLimit"), value: fmtUsd(l.weeklyLossLimit) }));
  if (l.maxDrawdown != null) parts.push(t("diff.summaryItem", { label: t("diff.maxDrawdown"), value: fmtUsd(l.maxDrawdown) }));
  return parts.join(", ");
}

// ─── eod ────────────────────────────────────────────────────────────────────

/** Closed-and-unreviewed days waiting longer than the SLA, oldest first, with whole hours waited. */
export function selectOverdue<T extends { id: number; closedAt: Date | string | null; reviewedAt?: Date | string | null }>(
  rows: readonly T[],
  now: Date,
  slaHours: number,
): Array<T & { hoursWaiting: number }> {
  const out: Array<T & { hoursWaiting: number }> = [];
  for (const r of rows) {
    if (!r.closedAt || r.reviewedAt) continue;
    const ms = (r.closedAt instanceof Date ? r.closedAt : new Date(r.closedAt)).getTime();
    if (!Number.isFinite(ms)) continue;
    const hours = (now.getTime() - ms) / 3_600_000;
    if (hours > slaHours) out.push({ ...r, hoursWaiting: Math.floor(hours) });
  }
  return out.sort((a, b) => b.hoursWaiting - a.hoursWaiting);
}

// ─── scaling ────────────────────────────────────────────────────────────────

/** "promote" | "demote" | other → action code (texts: scaling namespace `action.*`). */
export function scalingActionCode(action: string): "promote" | "demote" | "assign" {
  return action === "promote" ? "promote" : action === "demote" ? "demote" : "assign";
}

// ─── propreports sync ───────────────────────────────────────────────────────

export type SyncCounts = {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  conflicts: number;
  errors: number;
  errorText?: string | null;
};

/** Params of a `sync` notification (renderer: lib/notificationRenderers/risk.ts → syncText). */
export type SyncNoticeParams = {
  kind: "import" | "sync"; context?: string;
  inserted: number; updated: number; unchanged: number; skipped: number; conflicts: number; errors: number; errorText?: string;
};

export function syncNoticeParams(r: SyncCounts, kind: "import" | "sync", context?: string | null): SyncNoticeParams {
  return {
    kind, ...(context ? { context } : {}),
    inserted: r.inserted, updated: r.updated, unchanged: r.unchanged, skipped: r.skipped, conflicts: r.conflicts, errors: r.errors,
    ...(r.errorText ? { errorText: preview(r.errorText, 80) } : {}),
  };
}

/** Title / body of a sync result in `lang`: «Импорт PropReports: +12 новых, обновлено 3». */
export function syncText(p: SyncNoticeParams, lang: Lang = "ru"): { title: string; message: string } {
  const t = propreportsT.tFor(lang);
  const sep = t("notify.listSep");
  const head: string[] = [];
  head.push(p.inserted ? t("notify.inserted", { count: p.inserted }) : t("notify.noneNew"));
  if (p.updated) head.push(t("notify.updated", { count: p.updated }));
  const tail: string[] = [];
  if (p.unchanged) tail.push(t("notify.unchanged", { count: p.unchanged }));
  if (p.skipped) tail.push(t("notify.skipped", { count: p.skipped }));
  if (p.conflicts) tail.push(t("notify.conflicts", { count: p.conflicts }));
  if (p.errors) tail.push(p.errorText ? t("notify.errorsWithText", { count: p.errors, text: p.errorText }) : t("notify.errors", { count: p.errors }));
  const body = [cap(tail.join(sep)), p.context ?? ""].filter(Boolean).join(t("notify.bodySep"));
  const kind = t(p.kind === "import" ? "notify.kind.import" : "notify.kind.sync");
  return {
    // EN/UZ put the product name first ("PropReports import: …"), so they also get the lower-case kind.
    title: propreportsT.tryFor(lang, "notify.title", { kind, kindLower: kind.toLowerCase(), head: head.join(sep) }) ?? head.join(sep),
    message: body || t("notify.done"),
  };
}

/** Result of a sync / import run (RU fallback + params). warn when any row failed. */
export function syncNotice(r: SyncCounts, kind: "import" | "sync", context?: string | null): { title: string; message: string; severity: "info" | "warn"; params: SyncNoticeParams } {
  const params = syncNoticeParams(r, kind, context);
  return { ...syncText(params, "ru"), severity: r.errors > 0 ? "warn" : "info", params };
}

/** sync_unmatched notice for broker accounts that are not mapped to a trader (RU fallback + params); null when none. */
export function unmatchedNotice(accounts: readonly string[]): { title: string; message: string; params: { count: number; accounts: string; more?: number; variant?: string } } | null {
  const list = [...new Set(accounts.filter(Boolean))];
  if (!list.length) return null;
  const params = {
    count: list.length,
    accounts: list.slice(0, 5).join(", "),
    ...(list.length > 5 ? { more: list.length - 5 } : {}),
  };
  return { ...unmatchedText(params, "ru"), params };
}

export function unmatchedText(p: { count: number; accounts: string; more?: number }, lang: Lang = "ru"): { title: string; message: string } {
  const t = propreportsT.tFor(lang);
  const accounts = p.more ? t("notify.unmatchedMore", { accounts: p.accounts, more: p.more }) : p.accounts;
  return { title: t("notify.unmatchedTitle", { count: p.count }), message: t("notify.unmatchedBody", { accounts }) };
}

// ─── rule violations ────────────────────────────────────────────────────────

/** One notification per violation row ever (rule + its stable scan key), even if a re-scan drops and recreates it. */
export function violationDedupKey(ruleId: number, key: string): string {
  return `rule_violation:${ruleId}:${key}`;
}

/** Old trading days are history, not news: only today / yesterday (NY) violations notify. */
export function isNotifiableViolationDay(day: string | null | undefined, since: string): boolean {
  return !!day && day >= since;
}

export type ViolationItem = { ruleName: string; message: string; severity: string };

/**
 * rule_violation text for the new violations of one trader found in one scan; null when none.
 * `forStaff` writes it about the trader (curator inbox) instead of to them.
 */
export function violationNotice(
  trader: string,
  items: readonly ViolationItem[],
  forStaff: boolean,
  lang: Lang = "ru",
): { title: string; message: string; severity: "warn" | "critical" } | null {
  if (!items.length) return null;
  const t = rulesT.tFor(lang);
  const q = (x: string) => (lang === "en" ? `“${x}”` : `«${x}»`);
  const who = personNameFor(trader, lang);
  const severity = items.some((v) => v.severity === "high" || v.severity === "critical") ? "critical" : "warn";
  if (items.length === 1) {
    const v = items[0];
    const rule = preview(v.ruleName, 60);
    return { title: forStaff ? t("notify.oneStaff", { rule, trader: who }) : t("notify.one", { rule }), message: preview(v.message, 160), severity };
  }
  const rules = [...new Set(items.map((v) => v.ruleName))];
  const shown = rules.slice(0, 3).map((r) => q(preview(r, 40))).join(", ");
  const count = items.length;
  return {
    title: forStaff ? t("notify.manyStaff", { count, trader: who }) : t("notify.many", { count }),
    message: rules.length > 3 ? t("notify.rulesMore", { rules: shown, more: rules.length - 3 }) : shown,
    severity,
  };
}
