import * as React from "react";
import { Link } from "wouter";
import { Activity, Briefcase, Calculator, Check, LineChart, OctagonX, ShieldAlert, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState, Panel } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isNotFound } from "@/lib/api/errors";
import { useRiskMe, useRiskPositions } from "./use-risk";
import { TIERS, TierPill } from "./primitives";
import { links } from "@/lib/links";
import { AlertList } from "./usage";
import { PositionsTable } from "./positions-table";
import { HistoryCharts } from "./history-charts";
import { LimitsForm } from "./limits-form";
import { StopRemaining } from "./remaining";
import { TraderDayBlock } from "./intraday";
import { BreachHistory } from "./breaches";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { fmtR, fmtUsd } from "@/lib/format";
import { riskI18n } from "@/i18n/ns/risk";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";
import { stopMessage } from "./labels";

function Allowed({ ok, label }: { ok: boolean; label: string }) {
  const { t } = riskI18n.useT();
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm", ok ? "text-foreground" : "text-muted-foreground line-through")}>
      {ok ? <Check className="h-3.5 w-3.5 text-up" aria-hidden="true" /> : <X className="h-3.5 w-3.5 text-down" aria-hidden="true" />}
      {label}
      <span className="sr-only">{ok ? t("me.allowed") : t("me.forbidden")}</span>
    </span>
  );
}

function Fact({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "up" | "down" | "warn" }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-lg font-semibold tabular-nums", tone === "up" && "text-up", tone === "down" && "text-down", tone === "warn" && "text-warn")}>{value}</span>
    </div>
  );
}

export function MyRiskView({ trader, onUpdatedAt, canEditLimits = false }: {
  trader: string;
  onUpdatedAt?: (ts: number) => void;
  /** Staff (curator/admin) may set limits right here — the same LimitsForm as in the desk trader card. */
  canEditLimits?: boolean;
}) {
  const me = useRiskMe();
  const pos = useRiskPositions(trader);
  const [limitsOpen, setLimitsOpen] = React.useState(false);
  const { t } = riskI18n.useT();
  const c = commonI18n.t;

  React.useEffect(() => {
    if (me.dataUpdatedAt) onUpdatedAt?.(me.dataUpdatedAt);
  }, [me.dataUpdatedAt, onUpdatedAt]);

  if (me.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-56 rounded-2xl" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-72 rounded-2xl lg:col-span-2" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      </div>
    );
  }
  if (me.isError || !me.data) {
    const notReady = isNotFound(me.error);
    return (
      <Panel>
        <EmptyState
          icon={ShieldCheck}
          title={notReady ? t("page.notReadyTitle") : t("me.loadFailed")}
          description={notReady ? t("page.notReadyDesc", { path: "/api/risk" }) : (me.error as Error | null)?.message}
        />
      </Panel>
    );
  }

  const m = me.data;
  const L = m.limits;
  const stop = m.stop;
  const positions = pos.data?.positions ?? [];
  const tierIdx = L?.tier ? TIERS.findIndex((x) => x.value === L.tier) : -1;
  const nextTier = tierIdx >= 0 ? TIERS[tierIdx + 1] : undefined;
  const afterOpen = m.today.dailyRemainingAfterOpenRiskUsd;
  const pnl = m.today.pnlNet;
  const HeroIcon = m.halted ? OctagonX : stop.state === "warn" ? ShieldAlert : ShieldCheck;
  const heroTitle =
    stop.state === "no_limits" ? t("me.hero.noLimits")
    : stop.state === "drawdown" ? t("me.hero.drawdown")
    : stop.state === "weekly" ? t("me.hero.weekly")
    : m.halted ? t("me.hero.stop")
    : stop.state === "warn" ? t("me.hero.warn")
    : t("me.hero.ok");

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      {/* Hero: how much is left to the stop today / this week */}
      <Panel
        className={cn(m.halted ? "ring-1 ring-inset ring-down/50" : stop.state === "warn" ? "ring-1 ring-inset ring-warn/40" : undefined)}
        bodyClassName="flex flex-col gap-4"
      >
        <div role={m.halted ? "alert" : "status"} className="flex flex-wrap items-center gap-3">
          <HeroIcon className={cn("h-6 w-6 shrink-0", m.halted ? "text-down" : stop.state === "warn" ? "text-warn" : L ? "text-up" : "text-muted-foreground")} aria-hidden="true" />
          <div className="min-w-[240px] flex-1">
            <p className={cn("text-base font-semibold", m.halted && "text-down", !m.halted && stop.state === "warn" && "text-warn")}>{heroTitle}</p>
            <p className="text-sm text-muted-foreground tabular-nums">
              {stop.state === "no_limits"
                ? canEditLimits ? t("me.noLimitsStaff") : t("me.noLimitsTrader")
                : stopMessage(m, L)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Fact label={t("me.pnlToday")} value={pnl != null ? fmtUsd(pnl, { signed: true, decimals: 0 }) : m.today.trades ? fmtR(m.today.r) : "—"} tone={(pnl ?? 0) > 0 ? "up" : (pnl ?? 0) < 0 ? "down" : undefined} />
            <Fact label={t("me.tradesToday")} value={m.today.trades} />
            {m.today.openPositions > 0 && <Fact label={t("me.openRisk")} value={fmtUsd(m.today.openRiskUsd, { decimals: 0 })} tone={afterOpen != null && afterOpen < 0 ? "down" : undefined} />}
          </div>
          {stop.state === "no_limits" && canEditLimits && <Button size="sm" onClick={() => setLimitsOpen(true)}>{t("me.setLimits")}</Button>}
        </div>

        {L && <StopRemaining m={m} limits={L} big />}

        {L && m.today.openRiskUsd > 0 && afterOpen != null && (
          <p className={cn("flex items-start gap-1.5 text-xs tabular-nums", afterOpen < 0 ? "font-medium text-down" : "text-muted-foreground")}>
            {afterOpen < 0 && <OctagonX className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
            {afterOpen < 0
              ? t("me.openRiskOver", { amount: fmtUsd(-afterOpen, { decimals: 0 }) })
              : t("me.openRiskLeft", { amount: fmtUsd(afterOpen, { decimals: 0 }) })}
          </p>
        )}

        {m.alerts.length > 0 && <AlertList alerts={m.alerts} />}
        {m.drawdown.redDayStreak >= 2 && (
          <p className="flex items-start gap-1.5 text-xs text-warn">
            <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t("me.redStreak", { count: m.drawdown.redDayStreak })}
          </p>
        )}
      </Panel>

      <div className={cn("grid grid-cols-1 gap-[var(--grid-gap)]", L && "lg:grid-cols-3")}>
        <Panel title={t("me.dayTitle")} icon={Activity} description={t("me.dayDesc")} className={L ? "lg:col-span-2" : undefined}>
          <TraderDayBlock trader={trader} dailyLimit={L?.dailyLossLimit} showTrades height={200} />
        </Panel>

        {L && <Panel title={t("me.paramsTitle")} icon={SlidersHorizontal} actions={<TierPill tier={L.tier} />}>
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-muted-foreground">{t("me.bpPerPosition")}</dt><dd className="font-medium tabular-nums">{fmtUsd(L.maxPositionUsd, { decimals: 0 })}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t("me.oneR")}</dt><dd className="font-medium tabular-nums">{fmtUsd(L.maxRiskPerTrade, { decimals: 0 })}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t("me.maxOpen")}</dt><dd className="font-medium tabular-nums">{L.maxOpenPositions ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t("me.overnightUpTo")}</dt><dd className="font-medium tabular-nums">{L.allowOvernight ? fmtUsd(L.maxOvernightExposure, { decimals: 0, compact: 10_000 }) : "—"}</dd></div>
            </dl>
            <div className="flex flex-wrap gap-3">
              <Allowed ok label={c("trading.intraday")} />
              <Allowed ok={L.allowOvernight} label={c("trading.overnight")} />
              <Allowed ok={L.allowSwing} label={c("trading.swing")} />
            </div>
            {nextTier && <p className="text-xs text-muted-foreground">{t("me.nextTier", { tier: nextTier.label, hint: nextTier.hint })}</p>}
            {L.notes && <p className="rounded-xl bg-[var(--glass-bg)] p-3 text-sm text-muted-foreground ring-1 ring-inset ring-[var(--field-border)]">{L.notes}</p>}
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/calculator"><Calculator className="mr-1.5 h-4 w-4" aria-hidden="true" />{t("me.calculator")}</Link>
              </Button>
              {canEditLimits && <Button variant="ghost" size="sm" onClick={() => setLimitsOpen(true)}>{t("me.editLimits")}</Button>}
            </div>
          </div>
        </Panel>}
      </div>

      {positions.length > 0 && (
        <Panel title={t("me.positionsTitle", { count: positions.length })} icon={Briefcase}>
          <PositionsTable positions={positions} limitsByTrader={new Map([[trader, L]])} storageKey="risk.me.horizon" />
        </Panel>
      )}
      {pos.isError && <p role="alert" className="text-sm text-down">{t("me.positionsFailed", { error: (pos.error as Error).message })}</p>}

      {L && (
        <Panel title={t("me.breachesTitle")} icon={ShieldAlert} description={t("me.breachesDesc")}>
          <BreachHistory trader={trader} limits={L} max={8} />
        </Panel>
      )}

      <Panel
        title={t("me.equityTitle")}
        icon={LineChart}
        actions={<Link href={links.journalDay(m.today.date, trader)} className="whitespace-nowrap text-xs text-primary hover:underline">{t("me.journal")}</Link>}
      >
        <HistoryCharts trader={trader} />
      </Panel>

      {canEditLimits && (
        <Sheet open={limitsOpen} onOpenChange={setLimitsOpen}>
          <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
            <SheetHeader>
              <SheetTitle>{t("me.sheetTitle", { name: personName(trader) })}</SheetTitle>
              <SheetDescription>{t("me.sheetDesc")}</SheetDescription>
            </SheetHeader>
            <div className="mt-4">
              <LimitsForm trader={trader} limits={L} onSaved={() => setLimitsOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
