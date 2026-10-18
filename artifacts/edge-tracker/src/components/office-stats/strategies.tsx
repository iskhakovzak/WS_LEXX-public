/**
 * «Стратегии» blocks: Total Net by Strategy (ranked contribution per year), Net by Strategy small multiples,
 * volume share by year (stacked 100%), strategy × month matrix and the period table with YoY.
 */
import * as React from "react";
import { BarChart3, Download, Grid3x3, Layers, ListOrdered, Rows3 } from "lucide-react";
import { DataTable, EmptyState, Panel, SortableTh, useTableSort } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { downloadCsv } from "./csv";
import {
  STRATEGIES, monthShort, fmtAxis, fmtDay, fmtParen, fmtShare, fmtV,
  type PeriodView, type PrevPeriod, type Strategy, type Unit, type YearView,
} from "./api";
import { LineCanvas, monthTicks, type LineSeries } from "./line-canvas";
import { divergingCell, strategyColor, useDark, yearColor } from "./palette";
import type { Ctx } from "./overview";
import { fmtCount } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { officeI18n } from "@/i18n/ns/officeStats";

function Swatch({ s, dark }: { s: Strategy; dark: boolean }) {
  return <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: strategyColor(s, dark) }} aria-hidden="true" />;
}

export function StrategyLegend({ className }: { className?: string }) {
  const dark = useDark();
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", className)}>
      {STRATEGIES.map((s) => <span key={s} className="inline-flex items-center gap-1.5"><Swatch s={s} dark={dark} />{s}</span>)}
    </div>
  );
}

/** Ranked contribution of each strategy per year — negatives in parentheses, like the partners' sheet. */
export function TotalNetByStrategy({ ctx, years }: { ctx: Ctx; years: YearView[] }) {
  const { unit } = ctx;
  const { t } = officeI18n.useT();
  const dark = useDark();
  const shown = [...years].filter((y) => y.hasData).sort((a, b) => b.year - a.year);
  // Shared domain across years: zero sits where the most negative / most positive values leave it room.
  const nets = shown.flatMap((y) => y.strategies.filter((s) => s.trades > 0).map((s) => s.net));
  const lo = Math.min(0, ...nets);
  const hi = Math.max(0, ...nets);
  const span = Math.max(1e-9, hi - lo);
  const zero = (-lo / span) * 100;
  return (
    <Panel title={t("strategies.totalTitle")} description={t("strategies.totalDesc")} icon={ListOrdered} fill className="lg:col-span-6">
      {!shown.length ? <EmptyState compact icon={ListOrdered} title={t("strategies.noTradesYears")} /> : (
        // Split years side by side only when the panel itself is wide enough — a row needs ~13rem.
        <div className="@container">
        <div className={cn("grid gap-5", shown.length > 1 && "@md:grid-cols-2")}>
          {shown.map((y, rank) => {
            const rows = y.strategies.filter((s) => s.trades > 0).sort((a, b) => b.net - a.net);
            return (
              <div key={y.year} className="min-w-0">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <span className="h-0.5 w-3 rounded-full" style={{ background: yearColor(rank, dark) }} aria-hidden="true" />{y.year}
                  </span>
                  <span className={cn("text-sm font-semibold tabular-nums", y.totals.net >= 0 ? "text-up" : "text-down")}>{fmtParen(y.totals.net, unit)}</span>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {rows.map((s) => {
                    const w = (Math.abs(s.net) / span) * 100;
                    return (
                      <li key={s.key} className="grid grid-cols-[5.5rem_minmax(2.5rem,1fr)_4rem] items-center gap-2 text-xs" title={`${s.key}: ${fmtV(s.net, unit)} · ${commonI18n.t("units.trades", { count: s.trades })} · WR ${fmtShare(s.winRate)}`}>
                        <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground"><Swatch s={s.key} dark={dark} />{s.key}</span>
                        <span className="relative h-3">
                          {zero > 0.5 && <span className="absolute inset-y-0 w-px bg-border" style={{ left: `${zero}%` }} aria-hidden="true" />}
                          <span
                            className={cn("absolute inset-y-0.5 rounded-[3px]", s.net >= 0 ? "bg-up/80" : "bg-down/80")}
                            style={s.net >= 0 ? { left: `${zero}%`, width: `${Math.max(0.8, w)}%` } : { right: `${100 - zero}%`, width: `${Math.max(0.8, w)}%` }}
                          />
                        </span>
                        <span className={cn("text-right font-medium tabular-nums", s.net >= 0 ? "text-foreground" : "text-down")}>{fmtParen(s.net, unit)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
        </div>
      )}
    </Panel>
  );
}

/** Net by Strategy — one small multiple per strategy, shared x (day of year), own y. */
export function StrategyMultiples({ ctx }: { ctx: Ctx }) {
  const { view, focus, unit } = ctx;
  const { t } = officeI18n.useT();
  const dark = useDark();
  const years = React.useMemo(() => [...view.years].filter((y) => y.year <= focus.year && y.hasData).sort((a, b) => b.year - a.year), [view, focus.year]);
  const fmtY = React.useCallback((v: number) => fmtAxis(v, unit), [unit]);
  return (
    <Panel
      title={t("strategies.multiplesTitle")}
      description={t("strategies.multiplesDesc", { years: years.map((y) => y.year).join(t("chart.yearsJoin")) || "—" })}
      icon={BarChart3}
    >
      {!years.length ? <EmptyState compact icon={BarChart3} title={t("states.noTrades")} /> : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {years.map((y, rank) => (
              <span key={y.year} className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full" style={{ background: yearColor(rank, dark) }} aria-hidden="true" />{y.year}</span>
            ))}
          </div>
          <div className="grid gap-[var(--grid-gap)] sm:grid-cols-2 xl:grid-cols-4">
            {STRATEGIES.map((k) => {
              const rowF = focus.strategies.find((s) => s.key === k);
              const series: LineSeries[] = years.map((y, rank) => {
                const r = y.strategies.find((s) => s.key === k);
                return {
                  key: String(y.year), label: String(y.year), color: rank === 0 ? strategyColor(k, dark) : yearColor(rank, dark),
                  width: rank === 0 ? 2 : 1.5, fromZero: true, area: rank === 0,
                  points: r && r.trades > 0 ? y.days.map((d, i) => ({ x: d.doy, y: r.cum[i], date: d.date })) : [],
                };
              }).filter((s) => s.points.length > 0);
              const net = rowF?.net ?? 0;
              return (
                <div key={k} className="tile flex min-w-0 flex-col gap-1.5 p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><Swatch s={k} dark={dark} />{k}</span>
                    <span className={cn("text-sm font-semibold tabular-nums", net > 0 ? "text-up" : net < 0 ? "text-down" : "text-muted-foreground")}>{rowF?.trades ? fmtParen(net, unit) : "—"}</span>
                  </div>
                  {series.length ? (
                    <LineCanvas
                      series={series}
                      xMin={0}
                      xMax={366}
                      xTicks={monthTicks()}
                      fmtY={fmtY}
                      height={96}
                      compact
                      ariaLabel={t("strategies.multiplesAria", { strategy: k })}
                      renderTooltip={(_x, rows) => (
                        <div className="flex flex-col gap-0.5">
                          {rows[0]?.point && <p className="text-muted-foreground">{fmtDay(rows[0].point.date)}</p>}
                          {rows.map((r) => (
                            <p key={r.key} className="flex items-center justify-between gap-3">
                              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: r.color }} aria-hidden="true" />{r.label}</span>
                              <b className="tabular-nums text-foreground">{fmtV(r.point!.y, unit)}</b>
                            </p>
                          ))}
                        </div>
                      )}
                    />
                  ) : (
                    <div className="grid h-[96px] place-items-center text-xs text-muted-foreground">{t("states.noTradesShort")}</div>
                  )}
                  <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                    <span className="shrink-0 whitespace-nowrap">{t("strategies.volumeShort", { share: fmtShare(rowF?.volumeShare) })}</span>
                    <span className="relative h-1.5 flex-1 rounded-full bg-[var(--glass-bg)]">
                      <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, (rowF?.volumeShare ?? 0) * 100)}%`, background: strategyColor(k, dark) }} />
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-2xs tabular-nums text-muted-foreground">
                    <span>{commonI18n.t("units.trades", { count: rowF?.trades ?? 0 })}</span>
                    <span>WR {fmtShare(rowF?.winRate)}</span>
                    <span>PF {rowF?.profitFactor != null ? rowF.profitFactor.toFixed(2) : "—"}</span>
                    {rowF?.avgR != null && <span>{rowF.avgR >= 0 ? "+" : "−"}{Math.abs(rowF.avgR).toFixed(2)}R</span>}
                  </div>
                </div>
              );
            })}
            <div className="tile flex min-w-0 flex-col justify-center gap-2 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{t("strategies.howToRead")}</p>
              <p>{t("strategies.howToReadText", { year: focus.year })}</p>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

/** Share of volume by strategy per year — 100% stacked bars. */
export function VolumeShare({ years }: { years: YearView[] }) {
  const { t } = officeI18n.useT();
  const dark = useDark();
  const shown = [...years].filter((y) => y.hasData).sort((a, b) => b.year - a.year);
  const [hover, setHover] = React.useState<string | null>(null);
  return (
    <Panel title={t("strategies.volumeTitle")} description={t("strategies.volumeDesc")} icon={Layers} fill className="lg:col-span-6">
      {!shown.length ? <EmptyState compact icon={Layers} title={t("states.noTrades")} /> : (
        <div className="flex flex-col gap-4">
          {shown.map((y) => {
            const parts = y.strategies.filter((s) => (s.volumeShare ?? 0) > 0);
            return (
              <div key={y.year} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-semibold text-foreground">{y.year}</span>
                  <span className="text-muted-foreground">{commonI18n.t("units.trades", { count: y.totals.trades })}</span>
                </div>
                <div className="flex h-7 w-full gap-[2px] overflow-hidden rounded-md" role="img" aria-label={`${y.year}: ${parts.map((p) => `${p.key} ${fmtShare(p.volumeShare)}`).join(", ")}`}>
                  {parts.map((p) => {
                    const id = `${y.year}-${p.key}`;
                    const w = (p.volumeShare ?? 0) * 100;
                    return (
                      <span
                        key={p.key}
                        onMouseEnter={() => setHover(id)}
                        onMouseLeave={() => setHover(null)}
                        title={t("strategies.volumeTip", { strategy: p.key, share: fmtShare(p.volumeShare, 1), trades: commonI18n.t("units.trades", { count: p.trades }) })}
                        className={cn("relative grid min-w-[3px] place-items-center overflow-hidden text-2xs font-semibold text-white transition-opacity first:rounded-l-md last:rounded-r-md", hover && hover !== id && "opacity-50")}
                        style={{ width: `${w}%`, background: strategyColor(p.key, dark) }}
                      >
                        {w >= 9 ? <span className="truncate px-1 [text-shadow:0_1px_2px_rgb(0_0_0/0.35)]">{fmtShare(p.volumeShare)}</span> : null}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <StrategyLegend />
        </div>
      )}
    </Panel>
  );
}

/** Strategy × month matrix of the focus year. */
export function StrategyMonthMatrix({ ctx, onPickMonth }: { ctx: Ctx; onPickMonth: (m: number) => void }) {
  const { focus, unit } = ctx;
  const { t } = officeI18n.useT();
  const dark = useDark();
  const rows = focus.strategies.filter((s) => s.trades > 0);
  const max = Math.max(1e-9, ...rows.flatMap((r) => r.monthly.map((v) => Math.abs(v ?? 0))));
  const lastMonth = focus.months.reduce((a, m) => (m.days ? m.month : a), 0);
  const cols = Math.max(1, lastMonth);
  return (
    <Panel title={t("strategies.matrixTitle", { year: focus.year })} description={t("strategies.matrixDesc")} icon={Grid3x3}>
      {!rows.length ? <EmptyState compact icon={Grid3x3} title={t("states.noTrades")} /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-separate border-spacing-[3px] text-xs tabular-nums">
            <thead>
              <tr>
                <th className="w-24 text-left font-medium text-muted-foreground" />
                {Array.from({ length: cols }, (_, i) => (
                  <th key={i} className="font-medium text-muted-foreground">
                    <button type="button" onClick={() => onPickMonth(i + 1)} className="rounded px-1 hover:text-foreground">{monthShort(i)}</button>
                  </th>
                ))}
                <th className="pl-2 text-right font-medium text-muted-foreground">{t("strategies.year")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="pr-2"><span className="flex items-center gap-1.5 text-muted-foreground"><Swatch s={r.key} dark={dark} />{r.key}</span></td>
                  {Array.from({ length: cols }, (_, i) => {
                    const v = r.monthly[i];
                    return (
                      <td
                        key={i}
                        className="h-8 rounded-md text-center font-medium text-foreground"
                        style={{ background: v == null ? "transparent" : divergingCell(v, max) }}
                        title={`${r.key} · ${monthShort(i)}: ${v == null ? t("states.noTradesShort") : fmtV(v, unit)}`}
                      >
                        {v == null ? <span className="text-muted-foreground/50">·</span> : fmtAxis(v, unit)}
                      </td>
                    );
                  })}
                  <td className={cn("pl-2 text-right font-semibold", r.net >= 0 ? "text-up" : "text-down")}>{fmtParen(r.net, unit)}</td>
                </tr>
              ))}
              <tr>
                <td className="pr-2 pt-1 font-medium text-foreground">{t("strategies.office")}</td>
                {Array.from({ length: cols }, (_, i) => {
                  const v = focus.months[i]?.v;
                  return <td key={i} className={cn("pt-1 text-center font-semibold", (v ?? 0) > 0 ? "text-up" : (v ?? 0) < 0 ? "text-down" : "text-muted-foreground")}>{v == null ? "—" : fmtAxis(v, unit)}</td>;
                })}
                <td className={cn("pl-2 pt-1 text-right font-semibold", focus.totals.net >= 0 ? "text-up" : "text-down")}>{fmtParen(focus.totals.net, unit)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Period table per strategy (WR / PF / avg R / shares) with the same period a year earlier. */
type StrategyRowT = PeriodView["strategies"][number];

export function StrategyTable({ period, prev, unit, periodLabel }: { period: PeriodView; prev: PrevPeriod | null; unit: Unit; periodLabel: string }) {
  const { t } = officeI18n.useT();
  const dark = useDark();
  const prevBy = React.useMemo(() => new Map((prev?.strategies ?? []).map((s) => [s.key, s.net])), [prev]);
  const hasPrev = !!prev && prev.totals.trades > 0;
  const accessors = React.useMemo(() => ({
    key: (s: StrategyRowT) => s.key,
    trades: (s: StrategyRowT) => s.trades,
    wr: (s: StrategyRowT) => s.winRate,
    pf: (s: StrategyRowT) => s.profitFactor,
    r: (s: StrategyRowT) => s.avgR,
    net: (s: StrategyRowT) => s.net,
    delta: (s: StrategyRowT) => { const p = prevBy.get(s.key); return p == null ? null : s.net - p; },
    netShare: (s: StrategyRowT) => s.netShare,
    volShare: (s: StrategyRowT) => s.volumeShare,
  }), [prevBy]);
  const { rows, thProps } = useTableSort(period.strategies, accessors, "net", "desc", { key: "asc" });
  const exportCsv = () => {
    const u = unit === "usd" ? "$" : "%";
    downloadCsv(`office-strategies-${period.from}_${period.to}-${unit}.csv`, [
      [t("cols.strategy"), t("cols.trades"), "WR", "PF", commonI18n.t("trading.avgR"), t("cols.netUnit", { unit: u }), ...(hasPrev ? [t("cols.deltaPrevYearUnit", { unit: u })] : []), t("cols.netShare"), t("cols.volShare")],
      ...rows.map((s) => [s.key, s.trades, s.winRate, s.profitFactor, s.avgR, s.net, ...(hasPrev ? [accessors.delta(s)] : []), s.netShare, s.volumeShare]),
    ]);
  };
  return (
    <Panel
      title={t("strategies.qualityTitle")}
      description={t(hasPrev ? "strategies.qualityDescPrev" : "strategies.qualityDesc", { period: periodLabel })}
      icon={Rows3}
      actions={<Button variant="ghost" size="sm" onClick={exportCsv} aria-label={t("strategies.csvAria")}><Download className="h-4 w-4" /> CSV</Button>}
    >
      <DataTable ariaLabel={t("strategies.tableAria")}>
        <table>
          <thead>
            <tr>
              <SortableTh {...thProps("key")}>{t("cols.strategy")}</SortableTh>
              <SortableTh {...thProps("trades")} align="right">{t("cols.trades")}</SortableTh>
              <SortableTh {...thProps("wr")} align="right">WR</SortableTh>
              <SortableTh {...thProps("pf")} align="right">PF</SortableTh>
              <SortableTh {...thProps("r")} align="right">{commonI18n.t("trading.avgR")}</SortableTh>
              <SortableTh {...thProps("net")} align="right">{t("cols.net")}</SortableTh>
              {hasPrev && <SortableTh {...thProps("delta")} align="right">{t("cols.deltaPrevYear")}</SortableTh>}
              <SortableTh {...thProps("netShare")} align="right">{t("cols.netShare")}</SortableTh>
              <SortableTh {...thProps("volShare")} align="right">{t("cols.volShare")}</SortableTh>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const p = prevBy.get(s.key);
              const d = p != null && hasPrev ? s.net - p : null;
              return (
                <tr key={s.key} className={cn(!s.trades && "opacity-50")}>
                  <td><span className="flex items-center gap-1.5 font-medium text-foreground"><Swatch s={s.key} dark={dark} />{s.key}</span></td>
                  <td className="text-right">{fmtCount(s.trades)}</td>
                  <td className="text-right">{fmtShare(s.winRate)}</td>
                  <td className={cn("text-right", s.profitFactor != null && (s.profitFactor >= 1 ? "text-up" : "text-down"))}>{s.profitFactor != null ? s.profitFactor.toFixed(2) : "—"}</td>
                  <td className="text-right">{s.avgR != null ? `${s.avgR >= 0 ? "+" : "−"}${Math.abs(s.avgR).toFixed(2)}R` : "—"}</td>
                  <td className={cn("text-right font-semibold", s.net > 0 ? "text-up" : s.net < 0 ? "text-down" : "")}>{s.trades ? fmtParen(s.net, unit) : "—"}</td>
                  {hasPrev && <td className={cn("text-right", d == null ? "" : d >= 0 ? "text-up" : "text-down")}>{d == null ? "—" : fmtV(d, unit)}</td>}
                  <td className="text-right">{fmtShare(s.netShare)}</td>
                  <td className="text-right">{fmtShare(s.volumeShare)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataTable>
    </Panel>
  );
}
