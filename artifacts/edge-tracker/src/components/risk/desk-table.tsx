
import { Moon, PanelRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { DataTable, SortableTh, useTableSort } from "@/components/ds";
import { Button } from "@/components/ui/button";
import type { DeskRow } from "./use-risk";
import { rankLevel, riskScore, worstUsage, type RankInput, type RankLevel, type TraderExposure } from "./risk-math";
import { LevelBadge, UsageCell, tierLabel } from "./primitives";
import { fmtDate, fmtPct, fmtUsd } from "@/lib/format";
import { riskI18n } from "@/i18n/ns/risk";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";
import { alertLabel, stopMessage, stopStateLabel } from "./labels";

export type DeskTableRow = {
  row: DeskRow;
  level: RankLevel;
  score: number;
  worst: number | null;
  exposure: TraderExposure | null;
};

export function rankInput(r: DeskRow): RankInput {
  const alertPct = r.alerts.reduce<number | null>((m, a) => (a.pct != null && (m == null || a.pct > m) ? a.pct : m), null);
  return {
    halted: r.halted,
    status: r.status,
    stopState: r.stop.state,
    dailyPct: r.stop.dailyPct,
    weeklyPct: r.stop.weeklyPct,
    drawdownPct: r.stop.drawdownPct,
    alertPct,
    todayPnl: r.today.pnlNet,
  };
}

export function toTableRows(rows: DeskRow[], exposure: Map<string, TraderExposure>): DeskTableRow[] {
  return rows.map((row) => {
    const ri = rankInput(row);
    return { row, level: rankLevel(ri), score: riskScore(ri), worst: worstUsage(ri), exposure: exposure.get(row.trader) ?? null };
  });
}

/** Short reason next to the status: what exactly is near / over. */
function statusDetail(t: DeskTableRow): string | null {
  const r = t.row;
  if (t.level === "none") return null;
  if (r.halted) return stopStateLabel(r.stop.state);
  const top = r.alerts[0];
  if (top) return [alertLabel(top), top.pct != null ? fmtPct(top.pct, { decimals: 0, signed: false }) : null].filter(Boolean).join(" ");
  if (r.stop.dailyRemainingUsd != null) return riskI18n.t("table.leftToStop", { amount: fmtUsd(r.stop.dailyRemainingUsd, { decimals: 0 }) });
  return null;
}

const ACCESSORS = {
  risk: (t: DeskTableRow) => t.score,
  trader: (t: DeskTableRow) => personName(t.row.trader),
  daily: (t: DeskTableRow) => t.row.stop.dailyPct,
  weekly: (t: DeskTableRow) => t.row.stop.weeklyPct,
  drawdown: (t: DeskTableRow) => t.row.stop.drawdownPct,
  pnl: (t: DeskTableRow) => t.row.today.pnlNet,
  gross: (t: DeskTableRow) => t.exposure?.grossUsd ?? null,
  overnight: (t: DeskTableRow) => t.exposure?.overnightUsd ?? (t.row.today.overnightExposureUsd || null),
};

const ddmm = (d: string) => fmtDate(d.slice(0, 10), "dayMonthNumeric");

export function DeskTable({ rows, onOpen }: { rows: DeskTableRow[]; onOpen: (trader: string) => void }) {
  const { rows: sorted, thProps } = useTableSort(rows, ACCESSORS, "risk");
  const { t } = riskI18n.useT();
  const c = commonI18n.t;
  const short = (v: number) => fmtUsd(v, { decimals: 0, compact: 10_000 });

  return (
    <DataTable ariaLabel={t("desk.tradersTitle")} density="comfortable">
      <table>
        <thead>
          <tr>
            <SortableTh {...thProps("trader")}>{c("fields.trader")}</SortableTh>
            <SortableTh {...thProps("risk")}>{c("fields.status")}</SortableTh>
            <SortableTh {...thProps("daily")}>{c("time.day")}</SortableTh>
            <SortableTh {...thProps("weekly")}>{c("time.week")}</SortableTh>
            <SortableTh {...thProps("drawdown")}>{c("trading.drawdown")}</SortableTh>
            <SortableTh {...thProps("pnl")} align="right">{t("table.pnlToday")}</SortableTh>
            <SortableTh {...thProps("gross")} align="right">{t("table.positions")}</SortableTh>
            <SortableTh {...thProps("overnight")} align="right">{c("trading.overnight")}</SortableTh>
            <th scope="col">{t("table.topTicker")}</th>
            <th scope="col" className="w-12"><span className="sr-only">{t("table.card")}</span></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const r = row.row;
            const L = r.limits;
            const e = row.exposure;
            const pnl = r.today.pnlNet;
            const detail = statusDetail(row);
            const message = row.level === "none" ? undefined : stopMessage(r, L);
            const todayLoss = Math.max(0, -(pnl ?? 0));
            const weekLoss = Math.max(0, -(r.week.pnlNet ?? 0));
            const overnightBad = L != null && !L.allowOvernight && (e?.overnightCount ?? r.today.carriedTonight) > 0;
            const concentrated = e?.topTickerPct != null && e.count >= 2 && e.topTickerPct >= 50;
            return (
              <tr
                key={r.trader}
                onClick={() => onOpen(r.trader)}
                className={cn(
                  "cursor-pointer",
                  row.level === "stop" && "bg-down/[0.06]",
                  row.level === "near" && "bg-warn/[0.06]",
                )}
              >
                <td>
                  <button
                    type="button"
                    onClick={(ev) => { ev.stopPropagation(); onOpen(r.trader); }}
                    className="whitespace-nowrap rounded-md text-left font-semibold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {personName(r.trader)}
                  </button>
                  <div className="text-xs text-muted-foreground">{tierLabel(L?.tier) ?? c("tiers.noTier")}</div>
                </td>
                <td>
                  <LevelBadge level={row.level} />
                  {detail && (
                    <div className={cn("mt-0.5 max-w-[170px] truncate text-xs", row.level === "stop" ? "text-down" : "text-muted-foreground")} title={message ?? detail}>{detail}</div>
                  )}
                </td>
                <td><UsageCell label={t("table.usageDaily", { name: personName(r.trader) })} pct={r.stop.dailyPct} used={todayLoss} limit={L?.dailyLossLimit} /></td>
                <td><UsageCell label={t("table.usageWeekly", { name: personName(r.trader) })} pct={r.stop.weeklyPct} used={weekLoss} limit={L?.weeklyLossLimit} /></td>
                <td><UsageCell label={t("table.usageDrawdown", { name: personName(r.trader) })} pct={r.stop.drawdownPct} used={r.drawdown.currentUsd} limit={L?.maxDrawdown} /></td>
                <td className="text-right">
                  <div className={cn("font-semibold", pnl == null ? "text-muted-foreground" : pnl > 0 ? "text-up" : pnl < 0 ? "text-down" : "")}>
                    {pnl != null ? fmtUsd(pnl, { signed: true, decimals: 0 }) : "—"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {r.today.trades ? c("units.tradesShort", { count: r.today.trades }) : r.lastTradeDate ? t("table.lastTrade", { date: ddmm(r.lastTradeDate) }) : t("table.noTrades")}
                  </div>
                </td>
                <td className="text-right">
                  {e && e.count > 0 ? (
                    <>
                      <div className="font-medium">{e.count} · {short(e.grossUsd)}</div>
                      <div className="whitespace-nowrap text-xs text-muted-foreground">
                        {t("table.longShort", { long: short(e.longUsd), short: short(e.shortUsd) })}
                      </div>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t("table.none")}</span>
                  )}
                </td>
                <td className="text-right">
                  {e && e.overnightCount > 0 ? (
                    <span className={cn("inline-flex items-center gap-1 font-medium", overnightBad && "text-down")} title={overnightBad ? t("table.overnightForbidden") : undefined}>
                      <Moon className="h-3 w-3" aria-hidden="true" />
                      {e.overnightCount} · {fmtUsd(e.overnightUsd, { decimals: 0, compact: 10_000 })}
                      {overnightBad && <span className="sr-only">{t("table.overnightForbidden")}</span>}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td>
                  {e?.topTicker ? (
                    <span className={cn("text-xs", concentrated ? "font-medium text-warn" : "text-muted-foreground")} title={concentrated ? t("table.concentrated") : undefined}>
                      {e.topTicker} {Math.round(e.topTickerPct ?? 0)}%
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={t("table.cardAria", { name: personName(r.trader) })}
                    title={t("table.cardTitle")}
                    onClick={(ev) => { ev.stopPropagation(); onOpen(r.trader); }}
                  >
                    <PanelRight className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </DataTable>
  );
}
