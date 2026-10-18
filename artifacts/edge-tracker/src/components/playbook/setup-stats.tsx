/**
 * «Статистика» tab of a setup: $-first edge from real (auto-imported) trades linked to the setup —
 * net, win rate, expectancy in $, payoff, best entry slots (ET), equity curve, tickers, horizon split.
 * R stays optional (shown only when trades carry it). Data: GET /api/playbook/:id/stats.
 * When the sample includes other traders' trades and the viewer is not staff, the server nulls every $ figure
 * (`redacted: true`); the panel then leads with R (avg R, expectancy in R, PF in R, cumulative-R curve).
 */
import * as React from "react";
import { BarChart3, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, SortableTh, Sparkline, StatCard, StatGrid, toneText, useTableSort, type Tone } from "@/components/ds";
import { winrateTone } from "@/components/playbook-sub/bits";
import { cn } from "@/lib/utils";
import { notLiveMessage, useSetupStats } from "./api";
import { DocSection, RedactedHint } from "./setup-bits";
import { HORIZON_LABEL, moneyTone, type SetupSummary, type SlotStat, type UsdStats } from "./model";
import { fmtDate, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { playbookExamplesI18n } from "@/i18n/ns/playbookExamples";

import { personName } from "@/i18n";
const et = playbookExamplesI18n.t; // called at render time only
const slotLabel = (s: string) => (s === "pre" ? et("stats.slotPre") : s === "post" ? et("stats.slotPost") : `${s}–${endOf(s)}`);
function endOf(s: string) {
  const [h, m] = s.split(":").map(Number);
  const t = h * 60 + m + 30;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
const wrTone = (u: UsdStats): Tone => (u.winrate == null ? "neutral" : winrateTone(u.winrate, u.wins + u.losses));

export function SetupStatsPanel({ setupId, summary, children }: { setupId: number; summary?: SetupSummary; children?: React.ReactNode }) {
  const { t } = playbookExamplesI18n.useT();
  const q = useSetupStats(setupId);

  if (q.isLoading) {
    return (
      <div className="flex min-h-[420px] flex-col gap-[var(--grid-gap)]" aria-busy="true">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-[var(--glass-bg)] motion-reduce:animate-none" />)}</div>
        <div className="h-48 animate-pulse rounded-2xl bg-[var(--glass-bg)] motion-reduce:animate-none" />
      </div>
    );
  }

  // Older API: fall back to the summary row ($ fields when present).
  if (q.isError) {
    const live = notLiveMessage(q.error);
    if (live && summary && summary.tradeCount > 0) {
      return (
        <div className="flex flex-col gap-[var(--grid-gap)]">
          <StatGrid cols={4}>
            <StatCard label={t("stats.trades")} value={summary.tradeCount} hint={`${summary.wins}W · ${summary.losses}L`} />
            <StatCard label="Win rate" value={fmtRate(summary.winrate)} hint="W / (W + L)" />
            <StatCard label={t("stats.netPnl")} value={fmtUsd(summary.netPnl, { signed: true, decimals: 0 })} tone={moneyTone(summary.netPnl)} />
            <StatCard label={t("stats.expectancyUsd")} value={fmtUsd(summary.netPnl != null && summary.tradeCount ? summary.netPnl / summary.tradeCount : null, { signed: true, decimals: 0 })} tone={moneyTone(summary.netPnl)} hint={t("stats.perTrade")} />
          </StatGrid>
          {summary.redacted && <RedactedHint agg />}
          <p className="text-xs text-muted-foreground">{t("stats.notLiveHint")}</p>
          {children}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-[var(--grid-gap)]">
        <div className="glass-panel rounded-2xl">
          <EmptyState
            icon={BarChart3}
            title={live ? t("stats.notLive") : t("stats.loadFailed")}
            description={live ? undefined : (q.error as Error)?.message}
            action={live ? undefined : <Button variant="outline" onClick={() => q.refetch()}>{commonI18n.t("actions.retry")}</Button>}
          />
        </div>
        {children}
      </div>
    );
  }

  const s = q.data!;
  if (!s.count) {
    return (
      <div className="flex flex-col gap-[var(--grid-gap)]">
        <div className="glass-panel rounded-2xl">
          <EmptyState
            icon={BarChart3}
            title={t("stats.emptyTitle")}
            description={t("stats.emptyDesc")}
          />
        </div>
        {children}
      </div>
    );
  }

  const u = s.usd;
  const small = u.n < 10;
  const hasR = (s.edge?.rCount ?? 0) > 0;
  // $ hidden by the server → R everywhere a $ figure would be.
  const redacted = !!s.redacted;
  const curve = redacted ? (s.equityR ?? []).map((p) => p.cum) : s.equity.map((p) => p.cum);
  const curveTone = redacted ? moneyTone(s.edge?.avgR) : moneyTone(u.net);
  const expR = s.edge?.expectancy ?? s.edge?.avgR ?? null;
  const maxSlotN = Math.max(1, ...s.slots.map((x) => x.n));

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      {redacted && <RedactedHint agg className="px-1" />}
      {redacted ? (
        <StatGrid cols={4}>
          <StatCard label={t("stats.avgR")} value={fmtR(s.edge?.avgR)} tone={curveTone} hint={s.count < 10 ? t("stats.fewTrades", { count: s.count }) : t("stats.tradesN", { count: s.count })} spark={curve.length > 1 ? curve : undefined} term="avgR" />
          <StatCard label="Win rate" value={fmtRate(u.winrate)} tone={wrTone(u)} hint={`${u.wins}W · ${u.losses}L`} term="winrate" />
          <StatCard label={t("stats.expectancy")} value={fmtR(expR)} tone={moneyTone(expR)} hint={hasR ? t("stats.rPerTrade", { count: s.edge.rCount }) : t("stats.noR")} term="expectancy" />
          <StatCard label="PF (R)" value={s.edge?.profitFactor == null ? "—" : s.edge.profitFactor.toFixed(2)} hint="ΣR⁺ / |ΣR⁻|" term="pf" />
        </StatGrid>
      ) : (
      <StatGrid cols={4}>
        <StatCard label={t("stats.netPnl")} value={fmtUsd(u.net, { signed: true, decimals: 0 })} tone={moneyTone(u.net)} hint={small ? t("stats.fewTrades", { count: u.n }) : t("stats.tradesN", { count: u.n })} spark={curve.length > 1 ? curve : undefined} />
        <StatCard label="Win rate" value={fmtRate(u.winrate)} tone={wrTone(u)} hint={`${u.wins}W · ${u.losses}L`} term="winrate" />
        <StatCard label={t("stats.expectancy")} value={fmtUsd(u.expectancy, { signed: true, decimals: 2 })} tone={moneyTone(u.expectancy)} hint={t("stats.usdPerTrade")} term="expectancy" />
        <StatCard
          label="Payoff"
          value={u.payoff == null ? "—" : u.payoff.toFixed(2)}
          hint={t("stats.payoffHint", { win: fmtUsd(u.avgWin, { signed: true, decimals: 0 }), loss: fmtUsd(u.avgLoss, { signed: true, decimals: 0 }) })}
        />
      </StatGrid>
      )}

      {s.recent.n >= 5 && u.n >= 25 && s.recent.expectancy != null && u.expectancy != null && s.recent.expectancy < u.expectancy - Math.abs(u.expectancy) && (
        <p className="rounded-xl border border-[hsl(var(--chart-3)/0.3)] bg-[hsl(var(--chart-3)/0.1)] px-3 py-2 text-sm text-[hsl(var(--chart-3))]">
          {t("stats.decay", { count: s.recent.n, recent: fmtUsd(s.recent.expectancy, { signed: true, decimals: 2 }), all: fmtUsd(u.expectancy, { signed: true, decimals: 2 }) })}
        </p>
      )}

      <div className="grid gap-[var(--grid-gap)] xl:grid-cols-2">
        <DocSection title={t("stats.bestTime")} icon={Clock}>
          {s.slots.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("stats.noTimes")}</p>
          ) : (
            <>
              {s.bestSlots.length > 0 && (
                <p className="mb-3 text-sm text-foreground">
                  {t("stats.bestWorks")} {s.bestSlots.map((b) => <strong key={b.slot} className="font-semibold">{slotLabel(b.slot)}</strong>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}
                </p>
              )}
              <ul className="flex flex-col gap-1">
                {s.slots.map((sl) => <SlotRow key={sl.slot} sl={sl} maxN={maxSlotN} best={s.bestSlots.some((b) => b.slot === sl.slot)} />)}
              </ul>
              {s.timeCoverage != null && s.timeCoverage < 0.95 && (
                <p className="mt-2 text-xs text-muted-foreground">{t("stats.timeCoverage", { pct: Math.round(s.timeCoverage * 100) })}</p>
              )}
            </>
          )}
        </DocSection>

        <DocSection title={redacted ? t("stats.curveR") : t("stats.curvePnl")} icon={BarChart3} actions={s.firstDate ? <span className="text-xs tabular-nums text-muted-foreground">{fmtDate(s.firstDate, "dayMonthNumeric")} — {fmtDate(s.lastDate, "dayMonthNumeric")}</span> : undefined}>
          {curve.length > 1 ? (
            <Sparkline data={curve} width={560} height={140} tone={curveTone} baseline={0} className="h-36 w-full" ariaLabel={redacted ? t("stats.cumR") : t("stats.cumPnl")} />
          ) : (
            <p className="text-sm text-muted-foreground">{redacted && !hasR ? t("stats.curveRSoon") : t("stats.needTwoDays")}</p>
          )}
          {!redacted && (
          <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <Mini label={t("stats.best")} value={fmtUsd(u.best, { signed: true, decimals: 0 })} tone={moneyTone(u.best)} />
            <Mini label={t("stats.worst")} value={fmtUsd(u.worst, { signed: true, decimals: 0 })} tone={moneyTone(u.worst)} />
            <Mini label={t("stats.drawdown")} value={s.edge?.maxDrawdown != null ? fmtUsd(-Math.abs(s.edge.maxDrawdown), { signed: true, decimals: 0 }) : "—"} tone={s.edge?.maxDrawdown ? "down" : "neutral"} />
          </dl>
          )}
        </DocSection>
      </div>

      <div className="grid gap-[var(--grid-gap)] 2xl:grid-cols-2">
        <DocSection title={t("stats.tickers")}>
          <UsdTable head={t("stats.ticker")} rows={s.tickers.map((x) => ({ key: x.ticker, label: x.ticker, u: x }))} />
        </DocSection>
        <DocSection title={s.traders ? t("stats.tradersHorizon") : t("stats.horizon")}>
          {s.traders && s.traders.length > 0 && <div className="mb-3"><UsdTable head={t("stats.trader")} rows={s.traders.map((x) => ({ key: x.trader, label: personName(x.trader), u: x }))} /></div>}
          <UsdTable head={t("stats.horizon")} rows={Object.entries(s.byHorizon).map(([k, v]) => ({ key: k, label: HORIZON_LABEL[k] ?? k, u: v }))} />
        </DocSection>
      </div>

      {hasR && (
        <p className="px-1 text-xs text-muted-foreground">
          {s.edge.profitFactor != null
            ? t("stats.inRPf", { avg: fmtR(s.edge.avgR), count: s.edge.rCount, pf: s.edge.profitFactor.toFixed(2) })
            : t("stats.inR", { avg: fmtR(s.edge.avgR), count: s.edge.rCount })}.
        </p>
      )}
      {children}
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="rounded-xl bg-[var(--glass-bg)] px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("font-semibold tabular-nums", toneText(tone))}>{value}</dd>
    </div>
  );
}

function SlotRow({ sl, maxN, best }: { sl: SlotStat; maxN: number; best: boolean }) {
  return (
    <li className="grid grid-cols-[132px_minmax(0,1fr)_56px_80px] items-center gap-2 text-sm">
      <span className={cn("truncate tabular-nums", best ? "font-semibold text-foreground" : "text-muted-foreground")} title={slotLabel(sl.slot)}>{slotLabel(sl.slot)}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-[hsl(var(--border))]" aria-hidden="true">
        <span className={cn("block h-full rounded-full", sl.net == null ? "bg-[hsl(var(--muted-foreground)/0.45)]" : sl.net >= 0 ? "bg-up" : "bg-down")} style={{ width: `${(sl.n / maxN) * 100}%` }} />
      </span>
      <span className="text-right text-xs tabular-nums text-muted-foreground" title={et("stats.slotTitle")}>{sl.n} · {fmtRate(sl.winrate)}</span>
      <span className={cn("text-right tabular-nums", toneText(moneyTone(sl.net)))}>{fmtUsd(sl.net, { signed: true, decimals: 0 })}</span>
    </li>
  );
}

type UsdRow = { key: string; label: string; u: UsdStats };
type UsdKey = "label" | "n" | "winrate" | "exp" | "net";
const USD_ACCESSORS: Record<UsdKey, (r: UsdRow) => number | string | null | undefined> = {
  label: (r) => r.label,
  n: (r) => r.u.n,
  winrate: (r) => r.u.winrate,
  exp: (r) => r.u.expectancy,
  net: (r) => r.u.net,
};

/** Sortable breakdown (ticker / trader / horizon): default — most trades first; long lists scroll inside. */
function UsdTable({ rows: data, head }: { rows: UsdRow[]; head: string }) {
  const { rows, thProps } = useTableSort<UsdRow, UsdKey>(data, USD_ACCESSORS, "n", "desc", { label: "asc" });
  if (!data.length) return <p className="text-sm text-muted-foreground">—</p>;
  return (
    <div className="max-h-[min(60dvh,520px)] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-raised bg-surface-solid">
          <tr className="text-xs text-muted-foreground [&_th]:py-1 [&_th]:font-medium">
            <SortableTh {...thProps("label")}>{head}</SortableTh>
            <SortableTh {...thProps("n")} align="right">{et("stats.colTrades")}</SortableTh>
            <SortableTh {...thProps("winrate")} align="right">WR</SortableTh>
            <SortableTh {...thProps("exp")} align="right">{et("stats.colPerTrade")}</SortableTh>
            <SortableTh {...thProps("net")} align="right">{et("stats.colNet")}</SortableTh>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, label, u }) => (
            <tr key={key} className="border-t border-border/40">
              <td className="py-1.5 font-medium text-foreground">{label}</td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">{u.n}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtRate(u.winrate)}</td>
              <td className={cn("py-1.5 text-right tabular-nums", toneText(moneyTone(u.expectancy)))}>{fmtUsd(u.expectancy, { signed: true, decimals: 2 })}</td>
              <td className={cn("py-1.5 text-right tabular-nums", toneText(moneyTone(u.net)))}>{fmtUsd(u.net, { signed: true, decimals: 0 })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
