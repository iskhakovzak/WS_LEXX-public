/**
 * Payoff diagram for any set of legs: P&L at expiry (filled green/red around zero) and
 * today's mark-to-model curve (B-S). Rendered by recharts in CSS pixels so labels stay
 * readable on phones (the old SVG scaled 10px text down to ~4px at 375px).
 */
import { useId, useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtStrike, pnlAtExpiry, pnlNow, TOOLTIP_STYLE, type Leg } from "./lib";
import { fmtNum, fmtUsd } from "@/lib/format";
import { calculatorI18n } from "@/i18n/ns/calculator";

export function PayoffChart({
  legs,
  spot,
  days,
  ivPct,
  ratePct,
  breakevens = [],
  height = 260,
}: {
  legs: Leg[];
  spot: number;
  days: number;
  ivPct: number;
  ratePct: number;
  breakevens?: number[];
  height?: number;
}) {
  const { t } = calculatorI18n.useT();
  const gid = useId().replace(/:/g, "");
  const T = Math.max(0, days) / 365;
  const r = ratePct / 100;
  const sigma = Math.max(0, ivPct) / 100;
  const showNow = T > 0 && sigma > 0 && legs.some((l) => l.kind !== "stock");

  const { data, minY, maxY, lo, hi, eMin, eMax } = useMemo(() => {
    const ks = legs.map((l) => l.strike).filter((k) => k > 0);
    const lo0 = Math.min(spot, ...ks, ...breakevens);
    const hi0 = Math.max(spot, ...ks, ...breakevens);
    const pad = Math.max((hi0 - lo0) * 0.6, spot * 0.15);
    const lo = Math.max(0, lo0 - pad);
    const hi = hi0 + pad;
    const N = 120;
    const rows: { x: number; exp: number; now?: number }[] = [];
    let minY = 0, maxY = 0, eMin = Infinity, eMax = -Infinity;
    for (let i = 0; i <= N; i++) {
      const x = lo + ((hi - lo) * i) / N;
      const exp = pnlAtExpiry(legs, x);
      const row: { x: number; exp: number; now?: number } = { x: +x.toFixed(4), exp: +exp.toFixed(2) };
      if (showNow) row.now = +pnlNow(legs, x, T, r, sigma).toFixed(2);
      eMin = Math.min(eMin, exp); eMax = Math.max(eMax, exp);
      minY = Math.min(minY, exp, row.now ?? 0);
      maxY = Math.max(maxY, exp, row.now ?? 0);
      rows.push(row);
    }
    return { data: rows, minY, maxY, lo, hi, eMin, eMax };
  }, [legs, spot, breakevens, showNow, T, r, sigma]);

  if (!(spot > 0) || !legs.length) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{t("payoff.empty")}</p>;
  }

  // Gradients use each path's own bounding box: split exactly at y = 0 so profit is green and loss is red.
  const range = maxY - minY || 1;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const fillOffset = clamp01(Math.max(0, eMax) / ((Math.max(0, eMax) - Math.min(0, eMin)) || 1));
  const lineOffset = eMax <= 0 ? 0 : eMin >= 0 ? 1 : clamp01(eMax / (eMax - eMin));
  const strikes = Array.from(new Set(legs.filter((l) => l.kind !== "stock").map((l) => l.strike)));

  return (
    <div className="flex flex-col gap-3">
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset={0} stopColor="hsl(var(--up))" stopOpacity={0.35} />
                <stop offset={fillOffset} stopColor="hsl(var(--up))" stopOpacity={0.08} />
                <stop offset={fillOffset} stopColor="hsl(var(--down))" stopOpacity={0.08} />
                <stop offset={1} stopColor="hsl(var(--down))" stopOpacity={0.35} />
              </linearGradient>
              <linearGradient id={`line-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset={lineOffset} stopColor="hsl(var(--up))" />
                <stop offset={lineOffset} stopColor="hsl(var(--down))" />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="x"
              type="number"
              domain={[lo, hi]}
              tickFormatter={(v: number) => `$${fmtStrike(v, v < 20 ? 1 : 0)}`}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(v: number) => fmtUsd(v, { compact: true, decimals: Math.abs(v) < 10 ? "trim" : 0, fallback: "" })}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              width={52}
              domain={[minY - range * 0.05, maxY + range * 0.05]}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(v) => t("payoff.tooltipPrice", { price: `$${fmtNum(Number(v), 2)}` })}
              formatter={(v: number, name: string) => [fmtUsd(v, { signed: true, decimals: 0 }), name === "exp" ? t("shared.atExpiry") : t("payoff.today")]}
              cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
            />
            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.5} />
            {strikes.map((k) => (
              <ReferenceLine key={`k${k}`} x={k} stroke="hsl(var(--chart-3))" strokeDasharray="3 3" strokeOpacity={0.7} />
            ))}
            {breakevens.map((b, i) => (
              <ReferenceLine key={`be${i}`} x={b} stroke="hsl(var(--chart-5))" strokeDasharray="2 4" />
            ))}
            <ReferenceLine x={spot} stroke="hsl(var(--chart-1))" strokeWidth={1.5} />
            <Area type="linear" dataKey="exp" stroke={`url(#line-${gid})`} strokeWidth={2} fill={`url(#fill-${gid})`} isAnimationActive={false} />
            {showNow && <Line type="monotone" dataKey="now" stroke="hsl(var(--chart-1))" strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label={t("payoff.legend")}>
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-up" aria-hidden="true" />{t("shared.atExpiry")}</li>
        {showNow && <li className="flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dashed border-[hsl(var(--chart-1))]" aria-hidden="true" />{t("payoff.todayDays", { days: t("shared.days", { count: Math.round(days) }) })}</li>}
        <li className="flex items-center gap-1.5"><span className="h-3 w-0.5 rounded bg-[hsl(var(--chart-1))]" aria-hidden="true" />{t("shared.spot")} <span className="tabular-nums text-foreground">${fmtNum(spot, 2)}</span></li>
        {strikes.length > 0 && (
          <li className="flex items-center gap-1.5"><span className="h-3 w-0 border-l-2 border-dashed border-[hsl(var(--chart-3))]" aria-hidden="true" />{t("shared.strike")} <span className="tabular-nums text-foreground">{strikes.map((k) => fmtStrike(k)).join(" / ")}</span></li>
        )}
        {breakevens.length > 0 && (
          <li className="flex items-center gap-1.5"><span className="h-3 w-0 border-l-2 border-dotted border-[hsl(var(--chart-5))]" aria-hidden="true" />{t("shared.breakeven")} <span className="tabular-nums text-foreground">{breakevens.map((b) => `$${fmtNum(b, 2)}`).join(" / ")}</span></li>
        )}
      </ul>
    </div>
  );
}
