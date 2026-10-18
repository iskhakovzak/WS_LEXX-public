/**
 * Chart-lab «Тренировка» task settings — pure helpers for the task picker: where tasks come from (own trades, the
 * desk's trades, any ticker-day), the finest bars a task must have and the filters; the query for
 * GET /api/training/pool|task, the recently played keys (not repeated) and the chart-lab URL of a picked task.
 */

import { chartLabI18n } from "@/i18n/ns/chartLab";

export type TaskSource = "mine" | "desk" | "day";
/** Coarsest bars a task may have: "1m" — only days with 1-minute bars, "5m" — 1m or 5m, "any" — hourly too. */
export type TaskRes = "1m" | "5m" | "any";

export type TaskSettings = {
  source: TaskSource;
  res: TaskRes;
  side: "long" | "short" | null;
  result: "win" | "loss" | null;
  ticker: string;
  from: string;
  to: string;
};

export const DEFAULT_TASK_SETTINGS: TaskSettings = { source: "mine", res: "5m", side: null, result: null, ticker: "", from: "", to: "" };

/** Prefix of the stored settings; the full key is per viewer ({@link taskSettingsKey}). */
export const TASK_SETTINGS_KEY = "chart-lab:training-tasks:v2";

/**
 * Storage key of the task settings for this viewer (role + name), so what a guest picked (only «Любой тикер-день» is
 * open to guests) never carries over to a member signing in on the same browser, and two traders sharing a browser
 * keep their own filters.
 */
export function taskSettingsKey(role: string | null | undefined, name: string | null | undefined): string {
  const r = role || "anon";
  return r === "guest" || r === "anon" || !name ? `${TASK_SETTINGS_KEY}:${r}` : `${TASK_SETTINGS_KEY}:${r}:${name}`;
}

/** Settings valid for the viewer: guests / anonymous can only use ticker-days. */
export function settingsForRole(s: TaskSettings, member: boolean): TaskSettings {
  return !member && s.source !== "day" ? { ...s, source: "day" } : s;
}
export const TASK_RECENT_KEY = "chart-lab:training-recent:v1";
export const TASK_RECENT_MAX = 40;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const TICKER = /^[A-Z][A-Z0-9.\-]{0,10}$/;

/** Labels in the UI language (getters: every read follows the current language). */
export const SOURCE_LABEL: Readonly<Record<TaskSource, string>> = {
  get mine() { return chartLabI18n.t("tasks.source.mine"); },
  get desk() { return chartLabI18n.t("tasks.source.desk"); },
  get day() { return chartLabI18n.t("tasks.source.day"); },
};
export const RES_LABEL: Readonly<Record<TaskRes, string>> = {
  get "1m"() { return chartLabI18n.t("tasks.res.1m"); },
  get "5m"() { return chartLabI18n.t("tasks.res.5m"); },
  get any() { return chartLabI18n.t("tasks.res.any"); },
};

export function normTicker(v: string): string {
  return v.trim().toUpperCase();
}

/** Settings from storage / untrusted JSON; anything unknown falls back to the default. */
export function parseTaskSettings(raw: unknown): TaskSettings {
  let v: Record<string, unknown> = {};
  try { v = typeof raw === "string" ? (JSON.parse(raw) ?? {}) : (raw as Record<string, unknown>) ?? {}; } catch { v = {}; }
  if (!v || typeof v !== "object") v = {};
  const ticker = typeof v.ticker === "string" ? normTicker(v.ticker) : "";
  return {
    source: v.source === "desk" || v.source === "day" || v.source === "mine" ? v.source : DEFAULT_TASK_SETTINGS.source,
    res: v.res === "1m" || v.res === "any" || v.res === "5m" ? v.res : DEFAULT_TASK_SETTINGS.res,
    side: v.side === "long" || v.side === "short" ? v.side : null,
    result: v.result === "win" || v.result === "loss" ? v.result : null,
    ticker: TICKER.test(ticker) ? ticker : "",
    from: typeof v.from === "string" && YMD.test(v.from) ? v.from : "",
    to: typeof v.to === "string" && YMD.test(v.to) ? v.to : "",
  };
}

/** Query string for GET /api/training/pool (no `res` / `exclude`) or /task. Side / result do not apply to ticker-days. */
export function taskQuery(s: TaskSettings, opts: { forTask?: boolean; exclude?: readonly string[] } = {}): string {
  const p = new URLSearchParams({ source: s.source });
  if (s.source !== "day") {
    if (s.side) p.set("side", s.side);
    if (s.result) p.set("result", s.result);
  }
  const tk = normTicker(s.ticker);
  if (TICKER.test(tk)) p.set("ticker", tk);
  if (YMD.test(s.from)) p.set("from", s.from);
  if (YMD.test(s.to)) p.set("to", s.to);
  if (opts.forTask) {
    p.set("res", s.res);
    if (opts.exclude?.length) p.set("exclude", opts.exclude.slice(0, TASK_RECENT_MAX).join(","));
  }
  return p.toString();
}

/** Number of filters set besides the source and resolution (for the «Фильтры · 2» badge). */
export function activeFilterCount(s: TaskSettings): number {
  return [s.source !== "day" && s.side, s.source !== "day" && s.result, TICKER.test(normTicker(s.ticker)), YMD.test(s.from), YMD.test(s.to)].filter(Boolean).length;
}

export type PoolCounts = { total: number; "1m": number; "5m": number; "60m": number };

/** Tasks available with a resolution preference. */
export function countFor(c: PoolCounts | null | undefined, res: TaskRes): number {
  if (!c) return 0;
  return res === "1m" ? c["1m"] : res === "5m" ? c["1m"] + c["5m"] : c.total;
}

export type PickedTask = { kind: "trade" | "day"; tradeId: number | null; ticker: string; date: string; key: string; source: TaskSource; res: "1m" | "5m" | "60m" };

/** Newest first, unique, capped. */
export function pushRecent(list: readonly string[], key: string): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, TASK_RECENT_MAX);
}

export function parseRecent(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length < 64).slice(0, TASK_RECENT_MAX) : [];
  } catch { return []; }
}

/** Chart-lab URL that opens a picked task in training. */
export function taskUrl(t: Pick<PickedTask, "kind" | "tradeId" | "ticker" | "date" | "source">, tf: string | null): string {
  const p = new URLSearchParams();
  if (t.kind === "trade" && t.tradeId != null) {
    p.set("trade", String(t.tradeId));
    p.set("src", t.source);
  } else {
    p.set("ticker", t.ticker);
    p.set("date", t.date);
  }
  p.set("mode", "training");
  if (tf && tf !== "1m") p.set("tf", tf);
  return `/chart-lab?${p}`;
}

/** Message for an empty pool, in the words of the current settings. */
export function noTasksMessage(s: TaskSettings, c: PoolCounts | null | undefined): string {
  const total = c?.total ?? 0;
  const t = chartLabI18n.t;
  if (!total) {
    if (s.source === "mine") return activeFilterCount(s) ? t("tasks.none.mineFiltered") : t("tasks.none.mineEmpty");
    return t("tasks.none.filtered");
  }
  if (s.res === "1m") return t("tasks.none.only1m", { total, res: RES_LABEL["5m"] });
  return t("tasks.none.onlyHourly", { count: c?.["60m"] ?? 0, res: RES_LABEL.any });
}
