import type { CSSProperties } from "react";
import type { MetricDef, MetricUnit } from "./api";
import { fmtNum, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { benchmarkI18n } from "@/i18n/ns/benchmark";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Metric label / hint in the UI language by the server metric key; unknown keys keep the server text. */
export function metricLabel(m: Pick<MetricDef, "key" | "label">): string {
  return benchmarkI18n.tryT(`metric.${m.key}.label`) ?? m.label;
}
export function metricHint(m: Pick<MetricDef, "key" | "hint">): string {
  return benchmarkI18n.tryT(`metric.${m.key}.hint`) ?? m.hint;
}

/** 75 → «1 ч 15 мин», 4.5 → «4.5 мин», 0.4 → «24 с». */
export function fmtMinutes(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  const t = benchmarkI18n.t;
  if (v < 1) return t("unit.seconds", { count: Math.round(v * 60) });
  if (v < 60) return t("unit.minutes", { count: v < 10 ? fmtNum(v, 1) : Math.round(v) });
  const h = Math.floor(v / 60);
  const m = Math.round(v - h * 60);
  return m ? t("unit.hoursMinutes", { h, m }) : t("unit.hours", { count: h });
}

/** NY minutes since midnight → «09:31». */
export function fmtClock(min: number | null | undefined): string {
  if (!isNum(min)) return "—";
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function fmtByUnit(unit: MetricUnit, v: number | null | undefined): string {
  switch (unit) {
    case "usd": return fmtUsd(v, { signed: true, decimals: "auto" });
    case "pct": return fmtRate(v);
    case "ratio": return fmtNum(v);
    case "count": return isNum(v) ? (Number.isInteger(v) ? String(v) : fmtNum(v, 1)) : "—";
    case "min": return fmtMinutes(v);
    case "days": return isNum(v) ? benchmarkI18n.t("unit.days", { count: v }) : "—";

    case "r": return fmtR(v);
  }
}

export function fmtMetric(def: Pick<MetricDef, "unit" | "key">, v: number | null | undefined): string {
  // Drawdown and volatility are depths — no sign.
  if (def.key === "maxDd" || def.key === "dailyVol") return isNum(v) ? fmtUsd(v, { decimals: "auto" }) : "—";
  return fmtByUnit(def.unit, v);
}

/**
 * Heatmap cell colour for a desk percentile (1 = best): red → neutral → green, as an inline style using the theme tokens.
 * Neutral (style) metrics use the accent hue instead of good/bad colours.
 */
export function heatStyle(p: number | null | undefined, neutral = false): CSSProperties {
  if (!isNum(p)) return {};
  if (neutral) return { backgroundColor: `hsl(var(--chart-1) / ${(0.06 + p * 0.3).toFixed(3)})` };
  const d = p - 0.5;
  const a = (Math.abs(d) * 2 * 0.42 + 0.04).toFixed(3);
  return { backgroundColor: d >= 0 ? `hsl(var(--up) / ${a})` : `hsl(var(--down) / ${a})` };
}

/** Stable per-trader colour for lines (chart tokens). */
export const SERIES_COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-5))", "hsl(var(--chart-3))", "hsl(var(--chart-2))", "hsl(var(--chart-4))"];
