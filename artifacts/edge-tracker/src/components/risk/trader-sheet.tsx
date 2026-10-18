import * as React from "react";
import { Link } from "wouter";
import { AlertTriangle, History, Moon, OctagonX } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Pill, Segmented } from "@/components/ds";
import { links } from "@/lib/links";
import type { DeskRow, LimitEvent, RiskPosition } from "./use-risk";
import { useLimitsHistory, useTraderDay } from "./use-risk";
import { HistoryCharts } from "./history-charts";
import { LimitsForm } from "./limits-form";
import { PositionsTable } from "./positions-table";
import { AlertList } from "./usage";
import { LevelBadge, TierPill, tierLabel } from "./primitives";
import { rankLevel } from "./risk-math";
import { rankInput } from "./desk-table";
import { StopRemaining } from "./remaining";
import { DayTradesList, DaySkeleton, TraderDayBlock } from "./intraday";
import { BreachHistory, useBreaches } from "./breaches";
import { cn } from "@/lib/utils";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";
import { riskI18n } from "@/i18n/ns/risk";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";
import { rich, slots } from "@/i18n/rich";
import { positionsCount, stopMessage } from "./labels";

type Tab = "overview" | "trades" | "breaches" | "limits";

function TradesTab({ trader }: { trader: string }) {
  const { t } = riskI18n.useT();
  const q = useTraderDay(trader);
  const day = q.data;
  if (q.isLoading) return <DaySkeleton height={160} />;
  if (!day?.date || !day.trades.length) return <p className="text-sm text-muted-foreground">{t("day.noTrades")}</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        {day.isToday ? commonI18n.t("time.today") : t("sheet.lastDay", { date: fmtDate(day.date, "dayMonthNumeric") })}
        {" · "}{commonI18n.t("units.tradesShort", { count: day.trades.length })}
        {" · "}{rich(t("sheet.net", slots("amount")), {
          amount: <span className={cn("font-semibold", (day.net ?? 0) > 0 ? "text-up" : (day.net ?? 0) < 0 ? "text-down" : "text-foreground")}>{fmtUsd(day.net, { signed: true, decimals: 0 })}</span>,
        })}
        {day.fees > 0 && <> · {t("sheet.fees", { amount: fmtUsd(day.fees, { decimals: 0 }) })}</>}
      </p>
      <DayTradesList day={day} />
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm"><Link href={links.journalDay(day.date, trader)}>{t("sheet.journalDay")}</Link></Button>
        <Button asChild variant="outline" size="sm"><Link href={links.trades({ date: day.date })}>{t("sheet.allTradesDay")}</Link></Button>
      </div>
    </div>
  );
}

const LIMIT_FIELDS = [
  "tier", "accountSize", "dailyLossLimit", "weeklyLossLimit", "maxDrawdown", "maxRiskPerTrade",
  "maxPositionUsd", "maxOvernightExposure", "maxOpenPositions", "allowOvernight", "allowSwing", "notes",
] as const;

function fmtVal(k: string, v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return commonI18n.t(v ? "yes" : "no");
  if (typeof v === "number") return k === "maxOpenPositions" ? String(v) : fmtUsd(v, { decimals: 0 });
  if (k === "tier") return tierLabel(String(v)) ?? String(v);
  return String(v);
}

/** Only the fields that actually changed between before/after. */
function diff(e: LimitEvent): { key: string; from: string; to: string }[] {
  const out: { key: string; from: string; to: string }[] = [];
  for (const k of LIMIT_FIELDS) {
    const a = (e.before as Record<string, unknown> | null)?.[k];
    const b = (e.after as Record<string, unknown>)?.[k];
    if ((a ?? null) === (b ?? null)) continue;
    out.push({ key: riskI18n.t(`limitField.${k}`), from: fmtVal(k, a), to: fmtVal(k, b) });
  }
  return out;
}

function LimitsHistory({ trader }: { trader: string }) {
  const { t } = riskI18n.useT();
  const q = useLimitsHistory(trader);
  if (q.isLoading) return <Skeleton className="h-16 rounded-xl" />;
  if (q.isError) return <p className="text-xs text-muted-foreground">{t("sheet.historyUnavailable")}</p>;
  const events = q.data ?? [];
  if (events.length === 0) return <p className="text-xs text-muted-foreground">{t("sheet.noChanges")}</p>;
  return (
    <ol className="flex flex-col gap-2">
      {events.map((e) => {
        const d = diff(e);
        return (
          <li key={e.id} className="rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-xs ring-1 ring-inset ring-[var(--field-border)]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
              <span className="tabular-nums">{fmtDate(e.changedAt, "shortDateTime")}</span>
              {e.changedBy && <span>· {personName(e.changedBy)}</span>}
              {!e.before && <Pill tone="accent">{t("sheet.firstLimits")}</Pill>}
            </div>
            {e.reason && <div className="mt-0.5 font-medium text-foreground">{e.reason}</div>}
            {d.length > 0 && (
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
                {d.map((x) => (
                  <li key={x.key}><span className="text-muted-foreground">{x.key}:</span> {x.from} → <span className="font-medium text-foreground">{x.to}</span></li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function TraderSheet({
  row,
  positions,
  open,
  onOpenChange,
  initialTab = "overview",
}: {
  row: DeskRow | null;
  positions: RiskPosition[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialTab?: "overview" | "limits";
}) {
  const [tab, setTab] = React.useState<Tab>(initialTab);
  React.useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab, row?.trader]);

  const mine = React.useMemo(() => (row ? positions.filter((p) => p.trader === row.trader) : []), [positions, row]);
  const limitsMap = React.useMemo(() => new Map(row ? [[row.trader, row.limits]] : []), [row]);
  const breaches = useBreaches(row?.trader ?? null, row?.limits, open && !!row);
  const breachCount = breaches.rows.filter((b) => b.level === "breach").length;

  const level = row ? rankLevel(rankInput(row)) : "none";
  const pnl = row ? row.today.pnlNet ?? null : null;
  const { t } = riskI18n.useT();
  const c = commonI18n.t;
  const pnlTone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-foreground");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        {row && (
          <div className="flex flex-col gap-5">
            <SheetHeader className="pr-10 text-left">
              <div className="flex flex-wrap items-center gap-3">
                <SheetTitle className="text-xl">{personName(row.trader)}</SheetTitle>
                <LevelBadge level={level} />
                <TierPill tier={row.limits?.tier} />
              </div>
              <SheetDescription className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                <span>
                  {rich(t("sheet.today", slots("value")), {
                    value: (
                      <span className={cn("font-medium", pnlTone(pnl ?? row.today.r))}>
                        {pnl != null ? fmtUsd(pnl, { signed: true, decimals: 0 }) : row.today.trades ? fmtR(row.today.r) : t("sheet.noTrades")}
                      </span>
                    ),
                  })}
                </span>
                <span>
                  {rich(t("sheet.week", slots("value")), {
                    value: (
                      <span className={cn("font-medium", pnlTone(row.week.pnlNet ?? row.week.r))}>
                        {row.week.pnlNet != null ? fmtUsd(row.week.pnlNet, { signed: true, decimals: 0 }) : row.week.trades ? fmtR(row.week.r) : t("sheet.noTrades")}
                      </span>
                    ),
                  })}
                </span>
                <span>{rich(t("sheet.tradesToday", slots("count")), { count: <span className="font-medium text-foreground">{row.today.trades}</span> })}</span>
                {row.today.carriedTonight > 0 && (
                  <span className={cn("inline-flex items-center gap-1", row.limits && !row.limits.allowOvernight && "text-down")}>
                    <Moon className="h-3 w-3" aria-hidden="true" />{t("sheet.carried", { positions: positionsCount(row.today.carriedTonight) })}
                  </span>
                )}
              </SheetDescription>
              {row.stop.state !== "no_limits" && (row.halted || row.stop.state === "warn") && (
                <p
                  role="status"
                  className={cn(
                    "flex items-start gap-2 rounded-xl px-3 py-2 text-sm font-medium tabular-nums ring-1 ring-inset",
                    row.halted ? "bg-down/10 text-down ring-down/30" : "bg-warn/10 text-warn ring-warn/30",
                  )}
                >
                  {row.halted ? <OctagonX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
                  <span className="min-w-0">{stopMessage(row, row.limits)}</span>
                </p>
              )}
            </SheetHeader>

            <Segmented
              ariaLabel={t("sheet.tabsAria")}
              value={tab}
              onChange={setTab}
              options={[
                { value: "overview", label: c("fields.overview") },
                { value: "trades", label: c("trading.trades") },
                { value: "breaches", label: t("sheet.breaches"), count: breachCount || undefined },
                { value: "limits", label: row.limits ? t("sheet.limits") : t("desk.setLimits") },
              ]}
            />

            {tab === "overview" && (
              <div className="flex flex-col gap-6">
                {row.alerts.length > 0 && <AlertList alerts={row.alerts} />}
                {row.limits ? (
                  <section aria-label={t("sheet.remaining")}>
                    <h3 className="micro-label mb-2">{t("sheet.remaining")}</h3>
                    <StopRemaining m={row} limits={row.limits} />
                  </section>
                ) : (
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-2.5 text-sm ring-1 ring-inset ring-[var(--field-border)]">
                    <span className="text-muted-foreground">{t("sheet.noLimits")}</span>
                    <Button size="sm" variant="outline" className="shrink-0" onClick={() => setTab("limits")}>{t("desk.setLimits")}</Button>
                  </div>
                )}
                <section aria-label={c("trading.tradingDay")}>
                  <h3 className="micro-label mb-2">{t("sheet.dayTitle")}</h3>
                  <TraderDayBlock trader={row.trader} dailyLimit={row.limits?.dailyLossLimit} />
                </section>
                {mine.length > 0 && (
                  <section aria-label={t("sheet.openPositions")}>
                    <h3 className="micro-label mb-2">{t("sheet.openPositionsCount", { count: mine.length })}</h3>
                    <PositionsTable positions={mine} limitsByTrader={limitsMap} storageKey="risk.sheet.horizon" compact />
                  </section>
                )}
                <section aria-label={c("fields.history")}>
                  <h3 className="micro-label mb-2">{t("sheet.historyTitle")}</h3>
                  <HistoryCharts trader={row.trader} compact />
                </section>
              </div>
            )}

            {tab === "trades" && <TradesTab trader={row.trader} />}

            {tab === "breaches" && <BreachHistory trader={row.trader} limits={row.limits} />}

            {tab === "limits" && (
              <div className="flex flex-col gap-6">
                <LimitsForm trader={row.trader} limits={row.limits} />
                <section aria-label={t("sheet.limitsHistory")}>
                  <h3 className="micro-label mb-2 flex items-center gap-1"><History className="h-3 w-3" aria-hidden="true" />{t("sheet.limitsHistoryTitle")}</h3>
                  <LimitsHistory trader={row.trader} />
                </section>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
