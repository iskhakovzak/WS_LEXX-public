import * as React from "react";
import { ArrowDown, ArrowUp, Minus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { toneOf, toneText, type Tone } from "@/components/ds";
import { fmtNum } from "@/lib/format";
import { ratingsI18n } from "@/i18n/ns/ratings";
import { personInitials } from "@/i18n";

// Money / R / percent / signed numbers: @/lib/format (fmtUsd, fmtR, fmtPct, fmtNum).

/** Glass tooltip style for recharts. */
export const CHART_TOOLTIP: React.CSSProperties = {
  backgroundColor: "hsl(var(--popover) / 0.92)",
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--popover-foreground))",
  borderRadius: 12,
  fontSize: 12,
  boxShadow: "0 8px 32px rgb(0 0 0 / 0.3)",
  backdropFilter: "blur(24px)",
};
export const CHART_CURSOR = { fill: "hsl(var(--muted-foreground) / 0.1)" };

/** localStorage-backed state (never throws). */
export function useStoredState<T extends string>(key: string, initial: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = React.useState<T>(() => {
    try {
      const s = localStorage.getItem(key) as T | null;
      if (s != null && (!allowed || allowed.includes(s))) return s;
    } catch { /* storage unavailable */ }
    return initial;
  });
  const set = React.useCallback((nv: T) => {
    setV(nv);
    try { localStorage.setItem(key, nv); } catch { /* ignore */ }
  }, [key]);
  return [v, set];
}

/** Tiny inline SVG trend line. Tone follows last vs first value unless given. */
export function Sparkline({
  values,
  width = 88,
  height = 28,
  tone,
  className,
  domain,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: Tone;
  className?: string;
  /** fixed y-domain, e.g. [1, 10] for scores */
  domain?: [number, number];
  label?: string;
}) {
  const gid = `spark${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  if (values.length < 2) {
    return (
      <span className={cn("inline-flex items-center text-2xs text-muted-foreground", className)} style={{ width, height }}>
        {values.length === 1 ? ratingsI18n.t("shared.onePoint") : "—"}
      </span>
    );
  }
  const min = domain ? domain[0] : Math.min(...values);
  const max = domain ? domain[1] : Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const t = tone ?? toneOf(values[values.length - 1] - values[0]);
  const color = t === "up" ? "hsl(var(--up))" : t === "down" ? "hsl(var(--down))" : "hsl(var(--chart-1))";
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${d} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("shrink-0 overflow-visible", className)}
      role="img"
      aria-label={label ?? ratingsI18n.t("shared.trendAria", { values: values.map((v) => fmtNum(v, 1)).join(", ") })}
    >
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2.25} fill={color} />
    </svg>
  );
}

/** Rank movement vs previous period: ▲2 / ▼1 / new / —. */
export function RankDelta({ delta, isNew }: { delta: number | null; isNew?: boolean }) {
  if (isNew) {
    return (
      <span className="inline-flex items-center gap-0.5 text-2xs font-medium text-primary" title={ratingsI18n.t("shared.newInRating")}>
        <Sparkles className="h-3 w-3" aria-hidden="true" />
        new
      </span>
    );
  }
  if (delta == null || delta === 0) {
    return (
      <span className="inline-flex items-center text-muted-foreground" aria-label={ratingsI18n.t("shared.noChange")} title={ratingsI18n.t("shared.noChange")}>
        <Minus className="h-3 w-3" aria-hidden="true" />
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 text-2xs font-semibold tabular-nums", up ? "text-up" : "text-down")}
      aria-label={up ? ratingsI18n.t("shared.rankUp", { count: delta }) : ratingsI18n.t("shared.rankDown", { count: -delta })}
      title={up ? ratingsI18n.t("shared.rankUpTitle", { count: delta }) : ratingsI18n.t("shared.rankDownTitle", { count: -delta })}
    >
      {up ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : <ArrowDown className="h-3 w-3" aria-hidden="true" />}
      {Math.abs(delta)}
    </span>
  );
}

/** W3 / L2 streak pill with sign + colour. */
export function StreakBadge({ value, className }: { value: number; className?: string }) {
  if (!value) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const win = value > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
        win ? "bg-up/15 text-up" : "bg-down/15 text-down",
        className,
      )}
      title={win ? ratingsI18n.t("shared.winStreak", { count: value }) : ratingsI18n.t("shared.lossStreak", { count: -value })}
    >
      {win ? `W${value}` : `L${-value}`}
    </span>
  );
}

/** Horizontal score bar 1..10 using chart tokens (≥8 up, ≥5 warn, else down). */
export function ScoreBar({ value, max = 10, showValue = true, className }: { value: number; max?: number; showValue?: boolean; className?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const tone: Tone = value >= 8 ? "up" : value >= 5 ? "warn" : "down";
  const bg = tone === "up" ? "bg-up" : tone === "down" ? "bg-down" : "bg-[hsl(var(--chart-3))]";
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--glass-hover-bg)]" role="presentation">
        <div className={cn("h-full rounded-full transition-[width] duration-200", bg)} style={{ width: `${pct}%` }} />
      </div>
      {showValue && <span className={cn("w-7 text-right text-xs font-semibold tabular-nums", toneText(tone))}>{fmtNum(value, 1)}</span>}
    </div>
  );
}

/** Stacked W/L/BE/open outcome bar. */
export function OutcomeBar({ wins, losses, be, open = 0, className }: { wins: number; losses: number; be: number; open?: number; className?: string }) {
  const total = wins + losses + be + open;
  if (total === 0) return <div className={cn("h-1.5 rounded-full bg-[var(--glass-hover-bg)]", className)} role="presentation" />;
  const seg = (n: number) => `${(n / total) * 100}%`;
  return (
    <div
      className={cn("flex h-1.5 overflow-hidden rounded-full bg-[var(--glass-hover-bg)]", className)}
      role="img"
      aria-label={open
        ? ratingsI18n.t("shared.outcomeAriaOpen", { wins, losses, be, open })
        : ratingsI18n.t("shared.outcomeAria", { wins, losses, be })}
    >
      <div className="bg-up" style={{ width: seg(wins) }} />
      <div className="bg-[hsl(var(--chart-3))]" style={{ width: seg(be) }} />
      <div className="bg-down" style={{ width: seg(losses) }} />
      <div className="bg-[hsl(var(--chart-1)/0.5)]" style={{ width: seg(open) }} />
    </div>
  );
}

/** Two-letter avatar circle. */
export function Avatar({ name, className, highlight }: { name: string; className?: string; highlight?: boolean }) {
  return (
    <span
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold",
        highlight ? "bg-primary text-primary-foreground" : "bg-[var(--glass-hover-bg)] text-foreground",
        className,
      )}
      aria-hidden="true"
    >
      {personInitials(name)}
    </span>
  );
}

/** CSV download helper (client-side). */
export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "﻿" + [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
