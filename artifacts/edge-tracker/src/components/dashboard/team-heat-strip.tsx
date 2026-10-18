import * as React from "react";
import { Link } from "wouter";
import { ChevronRight, Users } from "lucide-react";
import { EmptyState, Panel, Pill, StatusDot, limitTone, limitToneToTone, toneOf, toneText, useTableSort, type Tone } from "@/components/ds";
import { SortHead } from "@/components/trades/sort-head";
import { Skeleton } from "@/components/ui/skeleton";
import { KPI_FORMULAS } from "@/lib/trade-math";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { fmtR, fmtUsd } from "@/lib/format";
import { comparePersonNames, personName } from "@/i18n";
import type { RiskDesk, RiskDeskRow } from "./use-dashboard";
import { commonI18n } from "@/i18n/ns/common";
import { dashboardI18n } from "@/i18n/ns/dashboard";

const STATUS_TONE: Record<RiskDeskRow["status"], Tone> = { breach: "down", warn: "warn", ok: "up", no_limits: "neutral" };
const statusLabel = (s: RiskDeskRow["status"]) => dashboardI18n.t(`desk.status.${s}`);
const RANK: Record<RiskDeskRow["status"], number> = { breach: 0, warn: 1, ok: 2, no_limits: 3 };

const COLS = "grid grid-cols-[minmax(0,1fr)_84px_84px_108px] items-center gap-x-3";

/** Daily-limit use 0…1+ (null without a limit); halted traders sort as fully used. */
function limitUse(r: RiskDeskRow): number | null {
  if (r.halted) return Number.MAX_SAFE_INTEGER;
  const limit = r.limits?.dailyLossLimit ?? null;
  return limit != null && limit > 0 ? Math.max(0, -(r.today.pnlNet ?? 0)) / limit : null;
}

const DESK_ACCESSORS = {
  // Default: stopped first, then breach → warn → ok → no limits (alphabetical inside a status).
  status: (r: RiskDeskRow) => (r.halted ? -1 : RANK[r.status]),
  trader: (r: RiskDeskRow) => personName(r.trader),
  today: (r: RiskDeskRow) => r.today.pnlNet ?? (r.today.trades ? r.today.r : null),
  week: (r: RiskDeskRow) => r.week.pnlNet ?? (r.week.trades ? r.week.r : null),
  limit: limitUse,
} as const;

function money(v: number | null, r: number, trades: number) {
  return v != null ? fmtUsd(v, { signed: true }) : trades > 0 && r !== 0 ? fmtR(r) : "—";
}

function TraderRow({ r }: { r: RiskDeskRow }) {
  const { t } = dashboardI18n.useT();
  const pnl = r.today.pnlNet;
  const loss = Math.max(0, -(pnl ?? 0));
  const limit = r.limits?.dailyLossLimit ?? null;
  const lt = r.halted ? "breach" : limitTone(loss, limit, 0.6);
  const pct = limit != null && limit > 0 ? Math.round((loss / limit) * 100) : null;
  return (
    <li>
      <Link
        href={links.risk(r.trader)}
        className={cn(COLS, "rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
        aria-label={t("desk.rowAria", { trader: personName(r.trader), amount: money(pnl, r.today.r, r.today.trades), status: r.halted ? t("desk.stop") : statusLabel(r.status) })}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium" title={personName(r.trader)}>{personName(r.trader)}</span>
          <span className="block truncate text-2xs text-muted-foreground tabular-nums">
            {commonI18n.t("units.trades", { count: r.today.trades })}
            {r.today.carriedTonight > 0 ? ` · ${t("desk.overnight", { count: r.today.carriedTonight })}` : ""}
          </span>
        </span>
        <span className={cn("text-right text-sm font-medium tabular-nums", toneText(toneOf(pnl ?? r.today.r)))} title={KPI_FORMULAS.netPnl}>
          {money(pnl, r.today.r, r.today.trades)}
        </span>
        <span className={cn("text-right text-sm tabular-nums", toneText(toneOf(r.week.pnlNet ?? r.week.r)))}>{money(r.week.pnlNet, r.week.r, r.week.trades)}</span>
        <span className="flex justify-end">
          <StatusDot tone={r.halted ? "down" : pct != null ? limitToneToTone(lt) : STATUS_TONE[r.status]} className="text-muted-foreground">
            {r.halted ? t("desk.stop") : pct != null ? t("desk.limitPct", { pct }) : statusLabel(r.status)}
          </StatusDot>
        </span>
      </Link>
    </li>
  );
}

/** Staff only: one row per trader — today, week, daily-limit use (GET /api/risk/desk). Hidden on 404. */
export function DeskTodayPanel({ data, isLoading, fill }: { data: RiskDesk | null | undefined; isLoading: boolean; fill?: boolean }) {
  if (isLoading && data === undefined) {
    return (
      <Panel title={dashboardI18n.t("desk.title")} icon={Users} fill={fill}>
        <div className="flex flex-col gap-2" role="status" aria-label={commonI18n.t("states.loading")}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      </Panel>
    );
  }
  if (!data) return null;
  return <DeskTodayBody data={data} fill={fill} />;
}

function DeskTodayBody({ data, fill }: { data: RiskDesk; fill?: boolean }) {
  const { t } = dashboardI18n.useT();
  const s = data.summary;
  const base = React.useMemo(
    () => data.traders.filter((r) => !r.banned).sort((a, b) => comparePersonNames(a.trader, b.trader)),
    [data.traders],
  );
  const { rows, thProps } = useTableSort(base, DESK_ACCESSORS, "status", "asc");

  return (
    <Panel
      title={t("desk.title")}
      icon={Users}
      fill={fill}
      description={t("desk.desc", { traders: commonI18n.t("units.traders", { count: s.traders }), trades: commonI18n.t("units.trades", { count: s.tradesToday }) })}
      actions={
        s.halted + s.breach > 0 ? (
          <Pill tone="down" dot>
            {t("desk.stops", { count: s.halted + s.breach })}
          </Pill>
        ) : s.warn > 0 ? (
          <Pill tone="warn" dot>
            {t("desk.nearLimit", { count: s.warn })}
          </Pill>
        ) : undefined
      }
      bodyClassName="px-2 sm:px-3"
      footer={
        <>
          <span className="tabular-nums">
            {s.pnlNetToday != null ? t("desk.deskNet", { amount: fmtUsd(s.pnlNetToday, { signed: true }) }) : t("desk.noTradesToday")}
            {s.carriedTonight ? ` · ${t("desk.overnight", { count: s.carriedTonight })}` : ""}
          </span>
          <Link href={links.risk()} className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
            {t("attention.riskDesk")}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </>
      }
    >
      {rows.length === 0 ? (
        <EmptyState compact icon={Users} title={t("desk.noTraders")} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className={cn(COLS, "px-2 pb-1 text-2xs text-muted-foreground")}>
            <SortHead plain {...thProps("trader")}>{commonI18n.t("fields.trader")}</SortHead>
            <SortHead plain {...thProps("today")} align="right">{t("desk.today")}</SortHead>
            <SortHead plain {...thProps("week")} align="right">{t("desk.week")}</SortHead>
            <SortHead plain {...thProps("limit")} align="right" title={t("desk.limitTitle")}>{t("desk.limit")}</SortHead>
          </div>
          <ul className="flex max-h-[min(60dvh,520px)] flex-col overflow-y-auto" aria-label={t("desk.listAria")}>
            {rows.map((r) => (
              <TraderRow key={r.trader} r={r} />
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
