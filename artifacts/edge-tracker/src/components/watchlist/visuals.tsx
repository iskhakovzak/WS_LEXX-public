import * as React from "react";
import { cn } from "@/lib/utils";
import { toneText } from "@/components/ds";
import { scoreTone, type Plan } from "./lib";
import { fmtPct, fmtPrice } from "@/lib/format";
import { watchlistI18n } from "@/i18n/ns/watchlist";

/** Circular 0–100 score gauge. */
export function ScoreRing({ score, size = 36, className, pending }: { score: number | null; size?: number; className?: string; pending?: boolean }) {
  const stroke = size >= 48 ? 4 : 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const tone = scoreTone(score);
  return (
    <span
      className={cn("relative inline-grid shrink-0 place-items-center", toneText(tone), className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={pending ? watchlistI18n.t("score.pending") : score == null ? watchlistI18n.t("score.none") : watchlistI18n.t("score.of100", { score })}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn("-rotate-90", pending && "animate-spin motion-reduce:animate-none")} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={pending ? `${c * 0.25} ${c}` : `${c * pct} ${c}`}
          style={{ transition: "stroke-dasharray 400ms cubic-bezier(.2,.8,.2,1)" }}
        />
      </svg>
      <span className={cn("absolute font-semibold tabular-nums", size >= 48 ? "text-base" : "text-xs", score == null && "text-muted-foreground")}>
        {pending ? "" : score ?? "—"}
      </span>
    </span>
  );
}

/**
 * Tiny line chart of recent closes. Neutral by default: the colour must not contradict the day % shown next to it
 * (a 22-day uptrend drawn green beside a −9% day reads as a lie). Pass `tone` to colour it deliberately.
 */
export function Sparkline({ data, width = 88, height = 28, className, tone = "neutral" }: { data?: number[]; width?: number; height?: number; className?: string; tone?: "up" | "down" | "neutral" }) {
  const id = React.useId();
  if (!data || data.length < 2) {
    return <span className={cn("inline-block", className)} style={{ width, height }} aria-hidden="true" />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => [i * step, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const change = ((data[data.length - 1] - data[0]) / data[0]) * 100;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("shrink-0 overflow-visible", tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-muted-foreground", className)}
      role="img"
      aria-label={watchlistI18n.t("spark.aria", { count: data.length, change: fmtPct(change, 1) })}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2" fill="currentColor" />
    </svg>
  );
}

/** Stop → price → target ladder. Shows where the live price sits inside the plan. */
export function LevelLadder({ plan, compact = false }: { plan: Plan; compact?: boolean }) {
  const { stop, target, price, progress, side } = plan;
  if (stop == null && target == null) {
    return compact ? <span className="text-xs text-muted-foreground">{watchlistI18n.t("ladder.none")}</span> : null;
  }
  if (stop == null || target == null || side == null) {
    return (
      <div className="flex items-center gap-2 text-xs tabular-nums">
        {stop != null && <span className="text-down">{watchlistI18n.t("ladder.stop", { price: fmtPrice(stop) })}</span>}
        {target != null && <span className="text-up">{watchlistI18n.t("ladder.target", { price: fmtPrice(target) })}</span>}
      </div>
    );
  }
  const pct = progress != null ? progress * 100 : null;
  // Always stop on the left, target on the right: the marker shows progress of the plan (works for longs and shorts).
  return (
    <div className={cn("w-full", compact ? "min-w-[120px]" : "")}>
      <div className="relative h-1.5 rounded-full bg-gradient-to-r from-down/40 via-[hsl(var(--border))] to-up/40">
        {pct != null && (
          <span
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow"
            style={{ left: `${pct}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      <div className={cn("mt-1.5 flex items-center justify-between gap-2 tabular-nums", compact ? "text-2xs" : "text-xs")}>
        <span className="text-down">{watchlistI18n.t("ladder.stop", { price: fmtPrice(stop) })}</span>
        {price != null && !compact && <span className="font-medium text-foreground">{fmtPrice(price)}</span>}
        <span className="text-up">{watchlistI18n.t("ladder.target", { price: fmtPrice(target) })}</span>
      </div>
    </div>
  );
}
