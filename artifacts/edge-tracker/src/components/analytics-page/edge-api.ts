/**
 * Data layer for the edge-finder tabs: server aggregates (/api/edge/*), risk limits (/api/risk/me),
 * filter → query-string mapping and the Trade → SimTrade adapter used by What-if and Monte Carlo.
 */
import { useQuery } from "@tanstack/react-query";
import type { Trade } from "@workspace/api-client-react";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { riskMeQuery } from "@/lib/api/queries";
import { signedR, netPnl, isOpen, horizonOf } from "@/lib/trade-math";
import { fmtDateCustom, fmtWeekday, localeTag } from "@/lib/format";
import { analyticsI18n } from "@/i18n/ns/analytics";
import { comparePersonNames, personName } from "@/i18n";
import { type AnalyticsFilters, NONE, periodRange, day, sortChrono } from "./metrics";
import type { SimTrade } from "./edge-stats";

/* ─── Types mirrored from api-server/src/routes/edge.ts ─────────────────── */

export const EDGE_DIMENSIONS = [
  "setup", "horizon", "tod", "hold", "catalyst", "cap", "float", "gap", "weekday", "grade", "conviction", "plan",
  "side", "trader", "account", "source", "month", "ticker",
] as const;
export type EdgeDimension = (typeof EDGE_DIMENSIONS)[number];

/** "Сетап" / "Setup" — read at call time. */
export const edgeDimLabel = (d: EdgeDimension): string => analyticsI18n.t(`edgeDim.${d}`);

export type EdgeCell = {
  row: string; col: string;
  n: number; closed: number; wins: number; losses: number; be: number;
  sumR: number; rN: number; posR: number; negR: number;
  gross: number; net: number; fees: number; pnlN: number; posNet: number; negNet: number;
  rValues: number[]; netValues: number[];
};

export type EdgeMatrix = {
  rows: EdgeDimension; cols: EdgeDimension; tod: number; scope: string | null;
  rowKeys: string[]; colKeys: string[]; cells: EdgeCell[]; total: number; hasJournal: boolean; generatedAt: string;
};

export type EdgeCostRow = {
  key: string;
  trades: number; closed: number; tradesWithPnl: number; tradesWithFees: number;
  gross: number; grossWins: number; fees: number; net: number;
  feePctOfGrossWins: number | null; feePctOfGross: number | null;
  shares: number; feePerShare: number | null; feePerTrade: number | null;
  slippageN: number; slippageSum: number; slippageAvg: number | null;
};
export type EdgeCostGroup = "trader" | "account" | "month" | "setup" | "horizon";
export type EdgeCosts = {
  group: EdgeCostGroup; scope: string | null; items: EdgeCostRow[];
  total: Omit<EdgeCostRow, "key" | "feePerShare" | "feePerTrade" | "slippageAvg" | "feePctOfGross" | "feePctOfGrossWins"> & {
    feePctOfGrossWins: number | null; feePctOfGross: number | null; feePerShare: number | null; feePerTrade: number | null; slippageAvg: number | null;
  };
  generatedAt: string;
};

export type RiskLimits = {
  accountSize: number | null; dailyLossLimit: number | null; weeklyLossLimit: number | null; maxDrawdown: number | null;
};
export type RiskMe = { limits: RiskLimits | null } & Record<string, unknown>;

/* ─── Filters → query string ─────────────────────────────────────────────── */

export function edgeParams(filters: AnalyticsFilters, extra: Record<string, string | number | undefined> = {}): string {
  const sp = new URLSearchParams();
  const range = periodRange(filters.period);
  if (range) { sp.set("from", range.from); sp.set("to", range.to); }
  if (filters.trader) sp.set("trader", filters.trader);
  if (filters.horizon) sp.set("horizon", filters.horizon);
  if (filters.side) sp.set("side", filters.side);
  if (filters.account) sp.set("account", filters.account);
  if (filters.source) sp.set("source", filters.source);
  if (filters.setup && filters.setup !== "__none__") sp.set("setup", filters.setup);
  if (filters.ticker) sp.set("ticker", filters.ticker);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") sp.set(k, String(v));
  return sp.toString();
}

export function useEdgeMatrix(filters: AnalyticsFilters, rows: EdgeDimension, cols: EdgeDimension, tod: 15 | 30, enabled = true) {
  const params = edgeParams(filters, { rows, cols, tod });
  return useQuery<EdgeMatrix>({
    queryKey: ["edge-matrix", params],
    enabled,
    staleTime: 60_000,
    queryFn: ({ signal }) => http.get<EdgeMatrix>(`/api/edge/matrix?${params}`, { signal }),
  });
}

export function useEdgeCosts(filters: AnalyticsFilters, group: EdgeCostGroup, enabled = true) {
  const params = edgeParams(filters, { group });
  return useQuery<EdgeCosts>({
    queryKey: ["edge-costs", params],
    enabled,
    staleTime: 60_000,
    queryFn: ({ signal }) => http.get<EdgeCosts>(`/api/edge/costs?${params}`, { signal }),
  });
}

/** Caller's risk limits; resolves to null when the risk desk is not installed (404) or the caller has no limits. */
export function useRiskLimits() {
  // A 404 (no risk desk) is an error state here; callers read `data ?? null`, so it still means «no limits».
  return useQuery({
    ...riskMeQuery<RiskMe | null>(),
    select: (me): RiskLimits | null => me?.limits ?? null,
    staleTime: STALE.long,
    retry: false,
  });
}

/* ─── Key labels for server dimensions ───────────────────────────────────── */

/*
 * api-server/src/routes/edge.ts returns bucket labels (Russian) as group keys. They are data here: each known key maps to
 * a stable id, and the display text comes from the analytics namespace. Codes (if the server switches to them) map too.
 */
type KeyId =
  | { k: "edgeKey"; id: "noDate" | "noSetup" | "noCatalyst" | "noGrade" | "noConviction" | "noSide" | "noTrader" | "noAccount" | "notSet" | "onPlan" | "offPlan" | "planNotMarked" | "gapLe10" | "gapM3_10" | "gapPm3" | "gapP3_10" | "gapP10_30" | "gapGt30" | "floatF10_50" | "floatF50_200" | "floatGt200" }
  | { k: "hold"; id: "lt5" | "m5_15" | "m15_60" | "h1_4" | "gt4h" | "gtDay" }
  | { k: "cap"; id: "nano" | "micro" | "small" | "mid" | "large" }
  | { k: "gap"; id: "up" | "down" | "other" | "none" }
  | { k: "side"; id: "long" | "short" }
  | { k: "weekday"; id: number }
  | { k: "bucket"; id: "noCap" | "noFloat" | "noTime" | "manual" }
  | { k: "floatLt10" };

const SERVER_KEYS: Record<string, KeyId> = {
  // i18n-ignore-next lines: server bucket keys (data), not UI text
  "Пн": { k: "weekday", id: 1 }, "Вт": { k: "weekday", id: 2 }, "Ср": { k: "weekday", id: 3 }, "Чт": { k: "weekday", id: 4 }, // i18n-ignore
  "Пт": { k: "weekday", id: 5 }, "Сб": { k: "weekday", id: 6 }, "Вс": { k: "weekday", id: 0 }, "Без даты": { k: "edgeKey", id: "noDate" }, // i18n-ignore
  "Без сетапа": { k: "edgeKey", id: "noSetup" }, "Без катализатора": { k: "edgeKey", id: "noCatalyst" }, "Без оценки": { k: "edgeKey", id: "noGrade" }, // i18n-ignore
  "Без уверенности": { k: "edgeKey", id: "noConviction" }, "Без стороны": { k: "edgeKey", id: "noSide" }, "Без трейдера": { k: "edgeKey", id: "noTrader" }, // i18n-ignore
  "Без счёта": { k: "edgeKey", id: "noAccount" }, "Не указано": { k: "edgeKey", id: "notSet" }, "Лонг": { k: "side", id: "long" }, "Шорт": { k: "side", id: "short" }, // i18n-ignore
  "По плану": { k: "edgeKey", id: "onPlan" }, "Не по плану": { k: "edgeKey", id: "offPlan" }, "Не отмечено": { k: "edgeKey", id: "planNotMarked" }, // i18n-ignore
  "До 5 мин": { k: "hold", id: "lt5" }, "5–15 мин": { k: "hold", id: "m5_15" }, "15–60 мин": { k: "hold", id: "m15_60" }, "1–4 ч": { k: "hold", id: "h1_4" }, // i18n-ignore
  "Больше 4 ч": { k: "hold", id: "gt4h" }, "Больше дня": { k: "hold", id: "gtDay" }, // i18n-ignore
  "Нано < $50M": { k: "cap", id: "nano" }, "Микро $50–300M": { k: "cap", id: "micro" }, "Малая $300M–2B": { k: "cap", id: "small" }, // i18n-ignore
  "Средняя $2–10B": { k: "cap", id: "mid" }, "Крупная > $10B": { k: "cap", id: "large" }, "Нет капитализации": { k: "bucket", id: "noCap" }, // i18n-ignore
  "Флоат < 10M": { k: "floatLt10" }, "Флоат 10–50M": { k: "edgeKey", id: "floatF10_50" }, "Флоат 50–200M": { k: "edgeKey", id: "floatF50_200" }, // i18n-ignore
  "Флоат > 200M": { k: "edgeKey", id: "floatGt200" }, "Нет флоата": { k: "bucket", id: "noFloat" }, // i18n-ignore
  "Гэп ≤ −10%": { k: "edgeKey", id: "gapLe10" }, "Гэп −3…−10%": { k: "edgeKey", id: "gapM3_10" }, "Гэп ±3%": { k: "edgeKey", id: "gapPm3" }, // i18n-ignore
  "Гэп +3…10%": { k: "edgeKey", id: "gapP3_10" }, "Гэп +10…30%": { k: "edgeKey", id: "gapP10_30" }, "Гэп > 30%": { k: "edgeKey", id: "gapGt30" }, // i18n-ignore
  "Гэп вверх": { k: "gap", id: "up" }, "Гэп вниз": { k: "gap", id: "down" }, "Другой гэп": { k: "gap", id: "other" }, "Без гэпа": { k: "gap", id: "none" }, // i18n-ignore
  "без времени": { k: "bucket", id: "noTime" }, "Вручную": { k: "bucket", id: "manual" }, // i18n-ignore
};

const weekdayShort = (d: number) => { const s = fmtWeekday(d, "short"); return s.charAt(0).toUpperCase() + s.slice(1); };

function keyIdLabel(id: KeyId): string {
  const t = analyticsI18n.t;
  switch (id.k) {
    case "edgeKey": return t(`edgeKey.${id.id}`);
    case "hold": return t(`bucket.hold.${id.id}`);
    case "cap": return t(`bucket.cap.${id.id}`);
    case "gap": return t(`bucket.gap.${id.id}`);
    case "side": return t(`bucket.side.${id.id}`);
    case "weekday": return weekdayShort(id.id);
    case "bucket": return t(`bucket.${id.id}`);
    case "floatLt10": return t("bucket.float.lt10");
  }
}

const SESSION_CODE: Record<string, "premarket" | "regular" | "afterhours"> = { premarket: "premarket", regular: "regular", rth: "regular", afterhours: "afterhours", postmarket: "afterhours" };

export function edgeKeyLabel(dim: EdgeDimension, key: string, tod: number): string {
  if (dim === "tod") {
    if (key.startsWith("m")) {
      const m = Number(key.slice(1));
      if (Number.isFinite(m)) {
        const to = m + tod;
        const f = (x: number) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
        return `${f(m)}–${f(to)}`;
      }
    }
    if (key.startsWith("s:")) { const s = key.slice(2); const c = SESSION_CODE[s.toLowerCase()]; return c ? analyticsI18n.t(`bucket.session.${c}`) : s; }
  }
  if (dim === "horizon") return key === "intraday" || key === "overnight" || key === "swing" ? analyticsI18n.t(`horizon.${key}`) : key;
  if (dim === "month" && /^\d{4}-\d{2}$/.test(key)) return fmtDateCustom(`${key}-01`, { month: "short", year: "numeric" });
  // Setup / ticker / account names are user data — only the server's own bucket labels are translated; a trader shows by display name.
  const id = SERVER_KEYS[key];
  return id ? keyIdLabel(id) : dim === "trader" ? personName(key) : key;
}

/* Fixed orders, as server keys (data). */
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс", "Без даты"]; // i18n-ignore
const GRADES = ["A+", "A", "B", "C", "Без оценки"]; // i18n-ignore
const HOLD = ["До 5 мин", "5–15 мин", "15–60 мин", "1–4 ч", "Больше 4 ч", "Больше дня", "Не указано"]; // i18n-ignore
const CAP = ["Нано < $50M", "Микро $50–300M", "Малая $300M–2B", "Средняя $2–10B", "Крупная > $10B", "Нет капитализации"]; // i18n-ignore
const FLOAT = ["Флоат < 10M", "Флоат 10–50M", "Флоат 50–200M", "Флоат > 200M", "Нет флоата"]; // i18n-ignore
const GAP = ["Гэп ≤ −10%", "Гэп −3…−10%", "Гэп ±3%", "Гэп +3…10%", "Гэп +10…30%", "Гэп > 30%", "Гэп вверх", "Гэп вниз", "Другой гэп", "Без гэпа"]; // i18n-ignore
const HORIZON = ["intraday", "overnight", "swing"];
const PLAN = ["По плану", "Не по плану", "Не отмечено"]; // i18n-ignore
/** "Nothing known" server buckets: listed last. */
const isEmptyServerKey = (k: string) => /^(Без|Нет |Не указан|без времени)/.test(k);

/** Natural ordering for a dimension's keys (time buckets numeric, known lists fixed, else alphabetical with "no …" last). */
export function sortEdgeKeys(dim: EdgeDimension, keys: string[]): string[] {
  const fixed =
    dim === "weekday" ? WEEKDAYS : dim === "grade" ? GRADES : dim === "hold" ? HOLD : dim === "cap" ? CAP : dim === "float" ? FLOAT
      : dim === "gap" ? GAP : dim === "horizon" ? HORIZON : dim === "plan" ? PLAN : null;
  const rank = (k: string) => {
    if (dim === "tod") return k.startsWith("m") ? Number(k.slice(1)) : k.startsWith("s:") ? 10_000 : 20_000;
    if (dim === "conviction") return isEmptyServerKey(k) ? 99 : Number(k.split("/")[0]) || 50;
    if (fixed) { const i = fixed.indexOf(k); return i < 0 ? fixed.length : i; }
    return isEmptyServerKey(k) ? 1 : 0;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || (dim === "trader" ? comparePersonNames(a, b) : a.localeCompare(b, localeTag())));
}

/* ─── Trade → SimTrade ───────────────────────────────────────────────────── */

/** Minutes since midnight of the entry when `date` carries a time (YYYY-MM-DDTHH:MM…), else null. */
export function entryMinutesOf(t: Trade): number | null {
  const raw = t.date ?? "";
  const m = raw.match(/^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Closed trades in chronological order as simulation inputs (open trades are skipped). */
export function toSimTrades(trades: Trade[]): SimTrade[] {
  return sortChrono(trades)
    .filter((t) => !isOpen(t))
    .map((t, i) => ({
      id: t.id,
      day: day(t),
      entryMin: entryMinutesOf(t),
      setup: (t.setup ?? "").trim() || NONE,
      grade: (t.confidenceGrade ?? "").trim() || null,
      horizon: horizonOf(t),
      r: signedR(t),
      net: netPnl(t),
      seq: i,
    }));
}
