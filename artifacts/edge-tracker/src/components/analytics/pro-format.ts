import { useEffect, useState } from "react";
import type { Metric } from "@/lib/analytics-pro";
import { fmtR, fmtUsd } from "@/lib/format";

/**
 * Format a value in the active metric: R ("+2.50R", compact "+2.5R" / "+12R") or money ("+$1,234.50", compact
 * "$12.3K"). `sign`: "+" on positives (R: default on, money: default off).
 */
export function fmtVal(metric: Metric, v: number | null | undefined, opts: { compact?: boolean; sign?: boolean } = {}): string {
  if (metric === "r") return fmtR(v, { decimals: opts.compact ? (Math.abs(v ?? 0) >= 10 ? 0 : 1) : 2, signed: opts.sign !== false });
  return fmtUsd(v, { signed: !!opts.sign, compact: !!opts.compact });
}

export const METRIC_LABEL: Record<Metric, string> = { pnl: "P&L, $", r: "R" };

/* ── Theme-aware colours for canvas charts ─────────────────────────────── */

/** Read an HSL triplet CSS variable (e.g. `--up: 151 50% 53%`) and return an rgba() string. */
export function cssVarColor(name: string, alpha = 1): string {
  if (typeof window === "undefined") return `rgba(128,128,128,${alpha})`;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = raw.match(/^(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (!m) return `rgba(128,128,128,${alpha})`;
  const h = ((Number(m[1]) % 360) + 360) % 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to255 = (x: number) => Math.round(x * 255);
  return `rgba(${to255(f(0))},${to255(f(8))},${to255(f(4))},${alpha})`;
}

/** Bumps whenever the <html> theme class changes (dark / dim / light). */
export function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => setV((x) => x + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    return () => mo.disconnect();
  }, []);
  return v;
}

/** localStorage read/write that never throws. */
export function loadPref<T extends string>(key: string, allowed: readonly T[]): T | null {
  try {
    const v = window.localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

export function savePref(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

/** Heat-cell background by sign and relative magnitude (0..1). Static class names for Tailwind. */
const UP_STEPS = ["bg-up/10", "bg-up/20", "bg-up/30", "bg-up/45"];
const DOWN_STEPS = ["bg-down/10", "bg-down/20", "bg-down/30", "bg-down/45"];
export function heatClass(net: number, max: number): string {
  if (!net || !max) return "";
  const ratio = Math.min(1, Math.abs(net) / max);
  const idx = ratio > 0.75 ? 3 : ratio > 0.45 ? 2 : ratio > 0.18 ? 1 : 0;
  return net > 0 ? UP_STEPS[idx] : DOWN_STEPS[idx];
}
