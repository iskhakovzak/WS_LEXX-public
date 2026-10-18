import { useMemo } from "react";
import type { Trade } from "@workspace/api-client-react";
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { TrendingUp, TrendingDown, LineChart as LineIcon, BarChart3, ArrowRight, Clock, CandlestickChart } from "lucide-react";
import { EquityChart, buildDayCandles, soleTrader } from "@/components/equity-chart";
import { Panel, StatCard, StatGrid, EmptyState, Pill, toneOf, type Tone } from "@/components/ds";
import { type Unit, type DimensionKey, computeStats, equitySeries, maxDrawdown, rHistogram, streaks, realizedR, median, edgeLeaders, breakdown, reliability, horizonLabel, HORIZONS, CHART_TOOLTIP_STYLE, CHART_CURSOR, AXIS, GRID } from "./metrics";
import { commonI18n } from "@/i18n/ns/common";
import { analyticsI18n } from "@/i18n/ns/analytics";
import { fmtCount, fmtNum, fmtR, fmtRate, fmtRatio, fmtUsd } from "@/lib/format";

export function OverviewTab({
  trades,
  previous,
  unit,
  onOpenDimension,
}: {
  trades: Trade[];
  previous: Trade[] | null;
  unit: Unit | null;
  onOpenDimension: (d: DimensionKey) => void;
}) {
  const { t } = analyticsI18n.useT();
  const s = useMemo(() => computeStats(trades), [trades]);
  const p = useMemo(() => (previous && previous.length ? computeStats(previous) : null), [previous]);
  const series = useMemo(() => (unit ? equitySeries(trades, unit) : []), [trades, unit]);
  const equityDays = useMemo(() => (unit ? buildDayCandles(trades, unit === "r" ? "r" : "net") : []), [trades, unit]);
  const dd = useMemo(() => maxDrawdown(series), [series]);
  const st = useMemo(() => streaks(trades), [trades]);
  const hist = useMemo(() => rHistogram(trades), [trades]);
  const rValues = useMemo(() => trades.map(realizedR).filter((v): v is number => v != null), [trades]);
  const leaders = useMemo(() => edgeLeaders(trades, s.rN >= Math.max(3, s.n * 0.5)), [trades, s]);

  const isR = unit === "r";
  const fmt = (v: number | null | undefined) => (isR ? fmtR(v) : fmtUsd(v, { signed: true, decimals: "auto" }));
  const expectancy = isR ? s.avgR : s.avgPnl;
  const total = isR ? (s.rN ? s.totalR : null) : (s.pnlN ? s.totalPnl : null);
  const pf = isR ? s.pfR : s.pfPnl;
  const prevExp = p ? (isR ? p.avgR : p.avgPnl) : null;
  const rel = reliability(s.n);

  const delta = (cur: number | null | undefined, prev: number | null | undefined, kind: "pp" | "unit" | "count") => {
    if (cur == null || prev == null || !p) return {};
    const d = kind === "pp" ? Math.round((cur - prev) * 100) : cur - prev;
    if (kind !== "count" && Math.abs(d) < (kind === "pp" ? 1 : 0.01)) return { delta: t("overview.noChange"), deltaTone: "neutral" as Tone };
    const text = kind === "pp" ? commonI18n.t("units.percentPoints", { value: fmtNum(d, { decimals: 0, signed: true }) }) : kind === "count" ? fmtNum(d, { decimals: 0, signed: true }) : isR ? fmtR(d) : fmtUsd(d, { signed: true, decimals: "auto" });
    return { delta: text, deltaTone: (kind === "count" ? "neutral" : toneOf(d)) as Tone };
  };

  const payoff = s.avgWinR != null && s.avgLossR != null && s.avgLossR !== 0 ? s.avgWinR / Math.abs(s.avgLossR) : null;
  const rMean = rValues.length ? rValues.reduce((a, b) => a + b, 0) / rValues.length : null;
  const rMed = median(rValues);
  const bigWins = rValues.filter((v) => v >= 2).length;
  const be = s.be;
  const showGross = unit === "usd" && s.totalFees > 0;
  const avgWin = isR ? s.avgWinR : s.avgWinPnl;
  const avgLoss = isR ? s.avgLossR : s.avgLossPnl;
  const payoffUnit = avgWin != null && avgLoss != null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : payoff;
  const horizons = useMemo(() => breakdown(trades, "horizon"), [trades]);
  const unitText = isR ? t("unit.r") : t("unit.usd");
  const tradesHint = [
    t("overview.tradesHint", { wins: s.wins, losses: s.losses }),
    be ? t("overview.beHint", { count: be }) : "",
    s.open ? t("overview.openHint", { count: s.open }) : "",
  ].filter(Boolean).join(" · ");

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <StatGrid>
        <StatCard
          label={t("overview.trades")}
          value={fmtCount(s.n)}
          hint={tradesHint}
          {...delta(s.n, p?.n, "count")}
        />
        <StatCard
          label="Win rate"
          value={s.decided ? fmtRate(s.winRate) : "—"}
          tone={s.decided ? (s.winRate >= 0.5 ? "up" : "down") : "neutral"}
          hint={s.decided ? t("overview.winRateHint", { lo: fmtRate(s.wrLow), hi: fmtRate(s.wrHigh) }) : t("overview.noClosed")}
          {...delta(s.decided ? s.winRate : null, p?.decided ? p.winRate : null, "pp")}
        />
        <StatCard
          label={isR ? t("overview.expectancyR") : t("overview.expectancyUsd")}
          value={unit ? fmt(expectancy) : "—"}
          tone={toneOf(expectancy)}
          hint={!unit ? t("overview.noUnit") : t("overview.perTrade", { reliability: rel.label.toLowerCase() })}
          {...delta(expectancy, prevExp, "unit")}
        />
        <StatCard
          label="Profit factor"
          value={unit ? fmtRatio(pf) : "—"}
          tone={pf == null ? "neutral" : pf >= 1 ? "up" : "down"}
          hint={pf != null ? (pf >= 1.5 ? t("overview.pfStrong") : pf >= 1 ? t("overview.pfPositive") : t("overview.pfNegative")) : unit ? t("overview.pfUndefined") : undefined}
        />
        <StatCard
          label={t("overview.avgWinLoss")}
          value={
            <span>
              <span className="text-up">{avgWin != null ? (isR ? fmtNum(avgWin, { decimals: 1, signed: true }) : fmtUsd(avgWin, { signed: true, decimals: "auto" })) : "—"}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-down">{avgLoss != null ? (isR ? fmtNum(avgLoss, { decimals: 1, signed: true }) : fmtUsd(avgLoss, { signed: true, decimals: "auto" })) : "—"}</span>
            </span>
          }
          hint={payoffUnit != null ? t("overview.payoff", { unit: unitText, value: fmtNum(payoffUnit) }) : unitText}
        />
        <StatCard
          label={isR ? t("overview.totalR") : t("overview.totalUsd")}
          value={unit ? fmt(total) : "—"}
          tone={toneOf(total)}
          hint={unit ? t("overview.overTrades", { count: isR ? s.rN : s.pnlN }) : undefined}
        />
        <StatCard
          label={t("overview.maxDd")}
          value={series.length ? fmt(dd) : "—"}
          tone={dd < 0 ? "down" : "neutral"}
          hint={t("overview.fromPeak")}
        />
        <StatCard
          label={t("overview.streaks")}
          value={
            <span>
              <span className="text-up">{st.maxWin}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-down">{st.maxLoss}</span>
            </span>
          }
          hint={st.current === 0 ? t("overview.streaksHint") : st.current > 0 ? t("overview.streakNowWin", { count: st.current }) : t("overview.streakNowLoss", { count: Math.abs(st.current) })}
        />
      </StatGrid>

      <Panel
        icon={CandlestickChart}
        title={t("overview.equity")}
        description={unit ? t("overview.equityHint", { unit: unitText }) : undefined}
      >
        {unit ? (
          <div className="flex flex-col gap-2">
            <EquityChart days={equityDays} unit={isR ? "r" : "net"} trader={soleTrader(trades)} storageKey="analytics.equity" height={440} />
            {showGross && (
              <p className="px-1 text-xs text-muted-foreground tabular-nums">
                {t("overview.beforeFees", { gross: fmtUsd(s.grossPnl, { signed: true, decimals: "auto" }) })} <span className="text-down">{fmtUsd(-Math.abs(s.totalFees), { decimals: Math.abs(s.totalFees) >= 100 ? 0 : 2 })}</span>
                {s.grossPnl > 0 && ` ${t("overview.feesShareOfGross", { share: fmtRate(s.totalFees / s.grossPnl) })}`} {t("overview.afterFees", { net: fmtUsd(s.totalPnl, { signed: true, decimals: "auto" }) })}
              </p>
            )}
          </div>
        ) : (
          <EmptyState
            icon={LineIcon}
            title={t("overview.nothingToDraw")}
            description={t("overview.nothingToDrawHint")}
          />
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-3">
        <Panel icon={BarChart3} title={t("overview.rDist")} description={t("overview.rDistHint")}>
          {rValues.length > 0 ? (
            <div className="flex flex-col gap-3">
              <div className="h-[190px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hist} margin={{ top: 8, right: 4, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
                    <XAxis dataKey="label" {...AXIS} fontSize={10} interval={0} angle={-35} textAnchor="end" height={40} />
                    <YAxis {...AXIS} allowDecimals={false} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={CHART_CURSOR} formatter={(v: number) => [commonI18n.t("units.trades", { count: v }), t("overview.tradesCol")]} labelFormatter={(l) => `${l}R`} />
                    <Bar dataKey="count" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                      {hist.map((b) => <Cell key={b.label} fill={b.tone === "up" ? "hsl(var(--up))" : "hsl(var(--down))"} fillOpacity={0.85} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <MiniStat label={t("overview.mean")} value={fmtR(rMean)} tone={toneOf(rMean)} />
                <MiniStat label={t("overview.median")} value={fmtR(rMed)} tone={toneOf(rMed)} />
                <MiniStat label="≥ +2R" value={fmtRate(rValues.length ? bigWins / rValues.length : null)} />
              </div>
            </div>
          ) : (
            <EmptyState icon={BarChart3} title={t("overview.noR")} description={t("overview.noRHint")} className="py-8" />
          )}
          <OutcomeBar wins={s.wins} losses={s.losses} be={be} />
        </Panel>
        <Panel
          className="lg:col-span-2"
          icon={Clock}
          title={t("overview.byHorizon")}
          description={t("overview.byHorizonHint")}
          actions={
            <button type="button" onClick={() => onOpenDimension("horizon")} className="text-xs text-primary hover:underline">
              {t("overview.more")}
            </button>
          }
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {HORIZONS.map((h) => {
              const r = horizons.find((x) => x.key === h);
              const rel = reliability(r?.n ?? 0);
              return (
                <div key={h} className="rounded-xl bg-[var(--glass-bg)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{horizonLabel(h)}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{r ? commonI18n.t("units.trades", { count: r.n }) : t("overview.noTrades")}</span>
                  </div>
                  {r ? (
                    <>
                      <div className="mt-2 grid grid-cols-3 gap-2 text-xs tabular-nums">
                        <div>
                          <div className="text-muted-foreground">Win rate</div>
                          <div className={`text-sm font-semibold ${r.winRate >= 0.5 ? "text-up" : "text-down"}`}>{fmtRate(r.winRate)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">{t("overview.expectancy")}</div>
                          <div className={`text-sm font-semibold ${toneCls(r.avgR)}`}>{fmtR(r.avgR)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">{t("overview.netPnl")}</div>
                          <div className={`text-sm font-semibold ${toneCls(r.pnlN ? r.totalPnl : null)}`} title={r.totalFees ? t("overview.feesTitle", { value: fmtUsd(-Math.abs(r.totalFees)) }) : undefined}>
                            {r.pnlN ? fmtUsd(r.totalPnl, { signed: true, decimals: "auto" }) : "—"}
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 text-2xs text-muted-foreground">{rel.label}{r.totalFees ? ` · ${t("overview.feesLower", { value: fmtUsd(-Math.abs(r.totalFees), { decimals: Math.abs(r.totalFees) >= 100 ? 0 : 2 }) })}` : ""}</div>
                    </>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">{t("overview.markHorizon")}</p>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:gap-5 md:grid-cols-2">
        <LeaderPanel
          title={t("overview.edgeTitle")}
          description={t("overview.edgeHint")}
          icon={TrendingUp}
          items={leaders.best}
          useR={s.rN >= Math.max(3, s.n * 0.5)}
          onOpenDimension={onOpenDimension}
          empty={t("overview.edgeEmpty")}
        />
        <LeaderPanel
          title={t("overview.weakTitle")}
          description={t("overview.weakHint")}
          icon={TrendingDown}
          items={leaders.worst}
          useR={s.rN >= Math.max(3, s.n * 0.5)}
          onOpenDimension={onOpenDimension}
          empty={t("overview.weakEmpty")}
        />
      </div>
    </div>
  );
}

function toneCls(v: number | null | undefined) {
  const t = toneOf(v ?? null);
  return t === "up" ? "text-up" : t === "down" ? "text-down" : "text-muted-foreground";
}

function MiniStat({ label, value, tone = "neutral" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="rounded-xl bg-[var(--glass-bg)] px-2 py-2">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function OutcomeBar({ wins, losses, be }: { wins: number; losses: number; be: number }) {
  const { t } = analyticsI18n.useT();
  const n = wins + losses + be;
  if (!n) return null;
  const seg = [
    { k: "win", v: wins, cls: "bg-up" },
    { k: "be", v: be, cls: "bg-muted-foreground/50" },
    { k: "loss", v: losses, cls: "bg-down" },
  ].filter((x) => x.v > 0);
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <div className="micro-label">{t("overview.outcomes")}</div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--glass-bg)]" role="img" aria-label={t("overview.outcomesAria", { wins, be, losses })}>
        {seg.map((x) => <div key={x.k} className={x.cls} style={{ width: `${(x.v / n) * 100}%` }} />)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span><span className="text-up">●</span> {t("overview.win")} {wins}</span>
        {be > 0 && <span>● {t("overview.be")} {be}</span>}
        <span><span className="text-down">●</span> {t("overview.loss")} {losses}</span>
      </div>
    </div>
  );
}

type Leader = ReturnType<typeof edgeLeaders>["best"][number];

function LeaderPanel({
  title, description, icon, items, useR, onOpenDimension, empty,
}: {
  title: string;
  description: string;
  icon: typeof TrendingUp;
  items: Leader[];
  useR: boolean;
  onOpenDimension: (d: DimensionKey) => void;
  empty: string;
}) {
  return (
    <Panel title={title} description={description} icon={icon}>
      {items.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((it) => {
            const rel = reliability(it.n);
            return (
              <li key={`${it.dimKey}-${it.key}`}>
                <button
                  type="button"
                  onClick={() => onOpenDimension(it.dimKey)}
                  className="lift group flex w-full items-center gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-2.5 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-2xs text-muted-foreground">{it.dim}</div>
                    <div className="truncate text-sm font-medium text-foreground" title={it.label}>{it.label}</div>

                  </div>
                  <div className="text-right">
                    <div className={`text-sm font-semibold tabular-nums ${useR ? (it.score >= 0 ? "text-up" : "text-down") : it.score >= 0.5 ? "text-up" : "text-down"}`}>
                      {useR ? fmtR(it.score) : fmtRate(it.score)}
                    </div>
                    <div className="text-2xs text-muted-foreground tabular-nums">
                      WR {fmtRate(it.stats.winRate)} · {commonI18n.t("units.tradesShort", { count: it.n })}
                    </div>
                  </div>
                  <Pill tone={rel.level === "high" ? "up" : rel.level === "medium" ? "warn" : "neutral"} className="hidden sm:inline-flex">{rel.label}</Pill>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
