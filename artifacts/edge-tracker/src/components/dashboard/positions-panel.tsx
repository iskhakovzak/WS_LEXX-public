import { Link } from "wouter";
import { CalendarClock, Moon, Layers } from "lucide-react";
import { EmptyState, Panel, Pill, toneOf, toneText } from "@/components/ds";
import { KPI_FORMULAS } from "@/lib/trade-math";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { shortDate } from "./fmt";
import { fmtCount, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import type { DashboardToday, Horizon, OpenPosition } from "./use-dashboard";
import { commonI18n } from "@/i18n/ns/common";
import { dashboardI18n } from "@/i18n/ns/dashboard";
import { personName } from "@/i18n";
import { HORIZON_LABEL as TRADES_HORIZON_LABEL } from "@/components/shared/trade-labels";

/** Horizon code → label (current language); the trades area owns the labels. */
export const HORIZON_LABEL: Record<Horizon, string> = TRADES_HORIZON_LABEL;

const HORIZON_TONE = { intraday: "accent", overnight: "purple", swing: "warn" } as const;


function PositionRow({ p, showTrader, today }: { p: OpenPosition; showTrader: boolean; today: string }) {
  const { t } = dashboardI18n.useT();
  const isShort = (p.side ?? "").toLowerCase().startsWith("s");
  const eventSoon = p.nextEvent && p.nextEvent.date <= today.slice(0, 10) ? "today" : p.nextEvent ? "soon" : null;
  return (
    <li>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--glass-hover-bg)] sm:grid-cols-[minmax(0,1fr)_72px_110px_84px_96px]">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <Link href={links.trade(p.id)} className="font-semibold rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {p.ticker}
          </Link>
          {p.side && (
            <Pill tone={isShort ? "down" : "up"} className="px-1.5 text-2xs">
              {isShort ? commonI18n.t("trading.short") : commonI18n.t("trading.long")}
            </Pill>
          )}
          {showTrader && p.trader && <span className="truncate text-xs text-muted-foreground" title={personName(p.trader)}>{personName(p.trader)}</span>}
          {p.nextEvent && (
            <Link
              href={links.events(p.ticker)}
              className={cn("inline-flex items-center gap-0.5 rounded text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", eventSoon === "today" ? "text-down" : "text-muted-foreground")}
              title={t("positions.nextEvent", { ticker: p.ticker, type: p.nextEvent.type ?? t("positions.eventFallback"), date: p.nextEvent.date })}
            >
              <CalendarClock className="h-3 w-3" aria-hidden="true" />
              {p.nextEvent.type ?? t("positions.eventFallback")} {shortDate(p.nextEvent.date)}
            </Link>
          )}
        </div>
        <span className="text-right text-sm tabular-nums">
          {p.daysHeld === 0 ? t("positions.today") : commonI18n.t("units.days", { count: p.daysHeld })}
        </span>
        <span className="hidden text-right text-xs tabular-nums text-muted-foreground sm:block" title={t("positions.entryStop")}>
          {p.entry != null || p.stop != null ? (
            <>
              {fmtPrice(p.entry)} <span aria-hidden="true">→</span> {fmtPrice(p.stop)}
              {p.stopPct != null ? <span className="ml-1">({p.stopPct}%)</span> : null}
            </>
          ) : (
            "—"
          )}
        </span>
        <span className="hidden text-right text-sm tabular-nums sm:block">{p.qty != null ? t("positions.shares", { count: fmtCount(p.qty) }) : "—"}</span>
        <span className="hidden text-right text-sm tabular-nums sm:block">
          {p.riskUsd != null ? (
            <span className="text-down">{fmtUsd(-Math.abs(p.riskUsd), { signed: true })}</span>
          ) : (
            <span className="text-muted-foreground" title={t("positions.noRiskTitle")}>
              {t("positions.noRisk")}
            </span>
          )}
        </span>
      </div>
    </li>
  );
}

export function PositionsPanel({ data }: { data: DashboardToday | undefined }) {
  const { t } = dashboardI18n.useT();
  // Shown only when something is actually open — no empty block on a flat day.
  if (!data || !data.positions || data.positions.length === 0) return null;

  const positions = data.positions;
  const carried = positions.filter((p) => p.horizon !== "intraday");
  // Intraday positions still open after their entry day are a desk-risk smell.
  const staleIntraday = positions.filter((p) => p.horizon === "intraday" && p.daysHeld > 0);
  const groups: { h: Horizon; items: OpenPosition[] }[] = (["overnight", "swing", "intraday"] as Horizon[])
    .map((h) => ({ h, items: positions.filter((p) => p.horizon === h) }))
    .filter((g) => g.items.length > 0);
  const carriedRisk = data.exposure?.carriedRiskUsd ?? carried.reduce((s, p) => s + (p.riskUsd ?? 0), 0);
  const noRisk = carried.filter((p) => p.riskUsd == null).length;
  const team = data.scope === "team";
  const split = data.today.byHorizon;

  return (
    <Panel
      title={t("positions.title")}
      icon={Moon}
      description={team ? t("positions.team") : t("positions.mine")}
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {carried.length > 0 && (
            <span title={t("positions.carriedRiskTitle")}>
              <Pill tone="down">{t("positions.carriedRisk", { amount: fmtUsd(-Math.abs(carriedRisk), { signed: true }) })}</Pill>
            </span>
          )}
          {!team && (
            <Link href={links.risk(data.viewer.name)} className="text-xs font-medium text-primary hover:underline">
              {t("attention.riskDesk")}
            </Link>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {split && split.filter((h) => h.trades > 0).length > 1 && (
          <div>
            <div className="micro-label mb-2" title={KPI_FORMULAS.netPnl}>
              {t("positions.realizedByHorizon")}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {split.map((h) => {
                const val = h.pnl ?? null;
                return (
                  <div key={h.horizon} className="min-w-0 rounded-xl border border-border/60 bg-[var(--glass-bg)] p-3">
                    <div className="truncate text-xs text-muted-foreground">{HORIZON_LABEL[h.horizon]}</div>
                    <div className={cn("truncate text-lg font-semibold tabular-nums", toneText(toneOf(val ?? h.r)))}>
                      {val != null ? fmtUsd(val, { signed: true }) : h.trades > 0 ? fmtR(h.r) : "—"}
                    </div>
                    <div className="truncate text-2xs text-muted-foreground">
                      {commonI18n.t("units.trades", { count: h.trades })}
                      {val != null && h.trades > 0 ? ` · ${fmtR(h.r)}` : ""}
                      {h.fees ? ` · ${t("positions.fees", { amount: fmtUsd(-Math.abs(h.fees), { signed: true }) })}` : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {positions.length === 0 ? (
          <EmptyState
            icon={Layers}
            className="py-6"
            title={t("positions.emptyTitle")}
            description={t("positions.emptyHint")}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((g) => (
              <section key={g.h} aria-label={HORIZON_LABEL[g.h]}>
                <div className="mb-1 flex items-center justify-between gap-2 px-2">
                  <Link href={links.trades({ horizon: g.h })} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Pill tone={HORIZON_TONE[g.h]}>
                      {HORIZON_LABEL[g.h]} · {g.items.length}
                    </Pill>
                  </Link>
                  <span className="hidden text-2xs text-muted-foreground sm:grid sm:w-[386px] sm:grid-cols-[72px_110px_84px_96px] sm:gap-x-3 sm:text-right">
                    <span className="truncate" title={t("positions.inPosition")}>{t("positions.inPosition")}</span>
                    <span className="truncate" title={t("positions.entryStop")}>{t("positions.entryStop")}</span>
                    <span className="truncate" title={t("positions.volume")}>{t("positions.volume")}</span>
                    <span className="truncate" title={t("positions.riskUsd")}>{t("positions.riskUsd")}</span>
                  </span>
                </div>
                <ul className="divide-y divide-border/50">
                  {g.items.map((p) => (
                    <PositionRow key={p.id} p={p} showTrader={team} today={data.date} />
                  ))}
                </ul>
              </section>
            ))}
            {(noRisk > 0 || staleIntraday.length > 0) && (
              <p className="px-2 text-xs text-muted-foreground">
                {noRisk > 0 && `${t("positions.noRiskCount", { count: noRisk })} `}
                {staleIntraday.length > 0 &&
                  t("positions.staleIntraday", { ticker: staleIntraday[0].ticker, date: shortDate(staleIntraday[0].date) })}
              </p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
