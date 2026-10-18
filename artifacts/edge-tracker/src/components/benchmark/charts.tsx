/**
 * Plain-SVG charts of the benchmark (no chart lib): multi-series equity lines and a percentile radar.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { PERIOD_HINT, dayHref, usePeriodNav } from "@/lib/period-links";
import type { DayPoint } from "./api";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";
import { benchmarkI18n } from "@/i18n/ns/benchmark";
import { personName } from "@/i18n";

/** `name` is the stored trader name (keys, day links); labels show it through personName(). */
export type EquitySeries = { name: string; color: string; unit: "usd" | "r" | null; points: DayPoint[] };

/**
 * Cumulative equity of one or more traders on a shared day axis (union of their trading days). Hover shows values;
 * click a day (or focus + ←/→ + Enter) opens that trader's «Разбор дня» — with several lines, of the nearest one.
 */
export function EquityLines({ series, height = 260, className }: { series: EquitySeries[]; height?: number; className?: string }) {
  const W = 760, H = height, PL = 64, PR = 12, PT = 12, PB = 26;
  const [hover, setHover] = useState<number | null>(null);
  const model = useMemo(() => {
    const days = [...new Set(series.flatMap((s) => s.points.map((p) => p.day)))].sort();
    const idx = new Map(days.map((d, i) => [d, i]));
    const lines = series.map((s) => {
      // carry the last cum forward on days the trader did not trade
      const byDay = new Map(s.points.map((p) => [p.day, p.cum]));
      let last: number | null = null;
      const vals = days.map((d) => {
        if (byDay.has(d)) last = byDay.get(d)!;
        return last;
      });
      return { ...s, vals };
    });
    const all = lines.flatMap((l) => l.vals.filter((v): v is number => v != null));
    let min = Math.min(0, ...all), max = Math.max(0, ...all);
    if (min === max) { min -= 1; max += 1; }
    return { days, idx, lines, min, max };
  }, [series]);
  const { days, lines, min, max } = model;
  const [, navigate] = useLocation();
  const nav = usePeriodNav({
    kind: "day",
    dates: days,
    trader: series.length === 1 ? series[0].name : null,
    label: benchmarkI18n.t("charts.equityAria", { names: series.map((s) => personName(s.name)).join(", ") }),
    describe: (i) => fmtDate(days[i], "shortYY"),
  });
  if (days.length < 2) {
    return <div className={cn("grid h-40 place-items-center text-sm text-muted-foreground", className)}>{benchmarkI18n.t("charts.tooFewDays")}</div>;
  }
  const x = (i: number) => PL + (i / (days.length - 1)) * (W - PL - PR);
  const y = (v: number) => PT + (1 - (v - min) / (max - min)) * (H - PT - PB);
  const unit = series[0]?.unit ?? "usd";
  const fmt = (v: number) => (unit === "r" ? fmtR(v) : fmtUsd(v, { signed: true, decimals: "auto" }));
  const ticks = [min, (min + max) / 2, max];
  const xTicks = [0, Math.floor((days.length - 1) / 2), days.length - 1];
  const pointAt = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * (H - PT - PB) + PT;
    const i = Math.max(0, Math.min(days.length - 1, Math.round(((px - PL) / (W - PL - PR)) * (days.length - 1))));
    return { i, py };
  };
  const onMove = (e: React.MouseEvent<SVGRectElement>) => setHover(pointAt(e).i);
  const onClick = (e: React.MouseEvent<SVGRectElement>) => {
    const { i, py } = pointAt(e);
    // Several traders: open the line closest to the pointer.
    let best: string | null = null, bestD = Infinity;
    for (const l of lines) {
      const v = l.vals[i];
      if (v == null) continue;
      const d = Math.abs(y(v) - py);
      if (d < bestD) { bestD = d; best = l.name; }
    }
    if (best == null) return;
    navigate(dayHref(days[i], best));
  };
  const shown = hover ?? (nav.active >= 0 ? nav.active : null);
  return (
    <div {...nav.wrapperProps} className={cn("relative", nav.wrapperProps.className, className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={benchmarkI18n.t("charts.equityAria", { names: series.map((s) => personName(s.name)).join(", ") })}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="hsl(var(--border))" strokeDasharray={t === 0 ? undefined : "2 4"} strokeWidth={1} />
            <text x={PL - 6} y={y(t) + 4} textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">{fmt(t)}</text>
          </g>
        ))}
        {min < 0 && max > 0 && <line x1={PL} x2={W - PR} y1={y(0)} y2={y(0)} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.5} strokeWidth={1} />}
        {xTicks.map((i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"} className="fill-muted-foreground text-[10px] tabular-nums">{fmtDate(days[i], "shortYY")}</text>
        ))}
        {lines.map((l) => {
          let d = "";
          l.vals.forEach((v, i) => { if (v == null) return; d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
          return <path key={l.name} d={d} fill="none" stroke={l.color} strokeWidth={1.8} strokeLinejoin="round" />;
        })}
        {shown != null && (
          <g>
            <line x1={x(shown)} x2={x(shown)} y1={PT} y2={H - PB} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.5} />
            {lines.map((l) => (l.vals[shown] != null ? <circle key={l.name} cx={x(shown)} cy={y(l.vals[shown] as number)} r={3} fill={l.color} /> : null))}
          </g>
        )}
        <rect
          x={PL} y={PT} width={W - PL - PR} height={H - PT - PB} fill="transparent" className="cursor-pointer"
          onMouseMove={onMove} onMouseLeave={() => setHover(null)} onClick={onClick}
        />
      </svg>
      {shown != null && (
        <div className="glass-panel pointer-events-none absolute right-2 top-2 rounded-lg px-2.5 py-1.5 text-xs tabular-nums">
          <div className="font-medium text-foreground">{fmtDate(days[shown], "shortYY")}</div>
          {lines.map((l) => (
            <div key={l.name} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: l.color }} aria-hidden="true" />
              <span className="text-muted-foreground">{personName(l.name)}</span>
              <span className="ml-auto pl-2 text-foreground">{l.vals[shown] == null ? "—" : fmt(l.vals[shown] as number)}</span>
            </div>
          ))}
          <div className="mt-1 text-2xs font-medium text-primary">{hover != null ? benchmarkI18n.t("charts.click") : benchmarkI18n.t("charts.enter")} — {PERIOD_HINT.day.toLowerCase()} →</div>
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: s.color }} aria-hidden="true" />{personName(s.name)}
          </span>
        ))}
      </div>
    </div>
  );
}

export type RadarAxis = { key: string; label: string };
export type RadarSeries = { name: string; color: string; values: Record<string, number | null> };

const RADAR_PAD_X = 64;

/** Radar of desk percentiles (0..1 per axis, 1 = best). Missing values are drawn at the centre and marked «—». */
export function Radar({ axes, series, size = 320, className }: { axes: RadarAxis[]; series: RadarSeries[]; size?: number; className?: string }) {
  const c = size / 2, R = size / 2 - 52;
  const n = axes.length;
  if (n < 3) return <div className="text-sm text-muted-foreground">{benchmarkI18n.t("charts.needAxes")}</div>;
  const ang = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const pt = (i: number, v: number) => [c + Math.cos(ang(i)) * R * v, c + Math.sin(ang(i)) * R * v] as const;
  return (
    // Side padding: the axis labels («Лучший день / прибыль») run outward from the circle and must not be clipped.
    <svg viewBox={`${-RADAR_PAD_X} 0 ${size + RADAR_PAD_X * 2} ${size}`} className={cn("h-auto w-full max-w-[440px] overflow-visible", className)} role="img"
      aria-label={benchmarkI18n.t("charts.radarAria", { names: series.map((s) => personName(s.name)).join(" vs ") })}>
      {[0.25, 0.5, 0.75, 1].map((g) => (
        <polygon key={g} points={axes.map((_, i) => pt(i, g).join(",")).join(" ")} fill="none" stroke="hsl(var(--border))" strokeDasharray={g === 0.5 ? undefined : "2 3"} />
      ))}
      {axes.map((a, i) => {
        const [x2, y2] = pt(i, 1);
        const [lx, ly] = pt(i, 1.18);
        return (
          <g key={a.key}>
            <line x1={c} y1={c} x2={x2} y2={y2} stroke="hsl(var(--border))" />
            <text x={lx} y={ly} textAnchor={Math.abs(lx - c) < 8 ? "middle" : lx > c ? "start" : "end"} dominantBaseline="middle" className="fill-muted-foreground text-[10px]">{a.label}</text>
          </g>
        );
      })}
      {series.map((s) => (
        <polygon key={s.name} points={axes.map((a, i) => pt(i, s.values[a.key] ?? 0).join(",")).join(" ")}
          fill={s.color} fillOpacity={0.14} stroke={s.color} strokeWidth={1.8} strokeLinejoin="round" />
      ))}
      {series.map((s) => axes.map((a, i) => {
        const v = s.values[a.key];
        if (v == null) return null;
        const [px, py] = pt(i, v);
        return <circle key={`${s.name}-${a.key}`} cx={px} cy={py} r={2.6} fill={s.color}><title>{benchmarkI18n.t("charts.percentile", { name: personName(s.name), axis: a.label, value: Math.round(v * 100) })}</title>
</circle>;
      }))}
    </svg>
  );
}
