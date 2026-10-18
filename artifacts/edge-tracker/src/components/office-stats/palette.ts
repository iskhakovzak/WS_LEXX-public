/**
 * Colours of «Статистика офиса». Strategies get fixed categorical slots (validated reference palette: adjacent
 * pairs clear CVD ΔE ≥ 8 and normal-vision ΔE ≥ 15 in both modes) — the colour follows the strategy, never its
 * rank. Years are focus + context: the latest year wears the accent, earlier years step down to greys.
 * P&L polarity uses the app's own --up / --down tokens (see chart-engine/theme).
 */
import * as React from "react";
import { useThemeVersion } from "@/components/chart-engine/hooks/useThemeVersion";
import type { Strategy } from "./api";

const SLOTS: Record<Strategy, { light: string; dark: string }> = {
  OPG: { light: "#2a78d6", dark: "#3987e5" },          // blue
  OPGtoDAY: { light: "#eb6834", dark: "#d95926" },     // orange
  Day: { light: "#1baf7a", dark: "#199e70" },          // aqua
  MOC: { light: "#eda100", dark: "#c98500" },          // yellow
  AfterMarket: { light: "#e87ba4", dark: "#d55181" },  // magenta
  Overnight: { light: "#008300", dark: "#008300" },    // green
  OPT: { light: "#6250d6", dark: "#9085e9" },          // violet
};

export function isDarkTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

export function strategyColor(s: Strategy, dark = isDarkTheme()): string {
  return dark ? SLOTS[s].dark : SLOTS[s].light;
}

/** Year line colour: rank 0 = the latest (accent), 1 = previous, 2+ = older. */
export function yearColor(rank: number, dark = isDarkTheme()): string {
  if (rank <= 0) return dark ? "#3987e5" : "#2a78d6";
  if (rank === 1) return dark ? "rgba(200, 202, 208, 0.62)" : "rgba(82, 81, 78, 0.55)";
  return dark ? "rgba(200, 202, 208, 0.32)" : "rgba(82, 81, 78, 0.3)";
}

/** Re-renders on theme switches; returns the current dark flag. */
export function useDark(): boolean {
  const v = useThemeVersion();
  return React.useMemo(() => isDarkTheme(), [v]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Diverging cell colour for a signed value (heatmaps): --up / --down tint whose strength grows with |v| / max,
 * a neutral surface at zero. Returns a CSS colour.
 */
export function divergingCell(v: number | null | undefined, max: number): string {
  if (v == null || !Number.isFinite(v) || max <= 0) return "var(--glass-bg)";
  if (Math.abs(v) < 1e-12) return "hsl(var(--muted-foreground) / 0.18)";
  const k = Math.min(1, Math.abs(v) / max);
  const a = 0.16 + 0.74 * Math.sqrt(k);
  return v > 0 ? `hsl(var(--up) / ${a.toFixed(3)})` : `hsl(var(--down) / ${a.toFixed(3)})`;
}

/** Resolves an HSL-triplet design token (e.g. "--down") to a canvas-usable colour string. */
export function tokenColor(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : fallback;
}
