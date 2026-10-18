/**
 * «Месяц к месяцу» — the focus year month by month: result, change vs the previous month and vs the same month a
 * year earlier, the running total against the straight-line plan to the yearly goal, green days and trades.
 * Partners read it as «are we on plan, and is this month better than the last one»; a row opens that month.
 */
import * as React from "react";
import { CalendarRange, Download } from "lucide-react";
import { DataTable, EmptyState, Panel, Pill } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtShare, fmtV, monthLong } from "./api";
import { downloadCsv } from "./csv";
import type { Ctx } from "./overview";
import { fmtCount, fmtMonth } from "@/lib/format";
import { officeI18n } from "@/i18n/ns/officeStats";

type Row = {
  month: number;
  v: number | null;
  days: number;
  green: number;
  trades: number;
  mom: number | null;
  prevYear: number | null;
  yoy: number | null;
  cum: number;
  plan: number | null;
  vsPlan: number | null;
  running: boolean;
};

/** DataTable styles thead/tbody only; the totals row gets the same cell padding + a hairline above. */
// Sticky to the bottom of a height-capped table, so the office total stays in view while scrolling the rows.
export const TFOOT = "[&_tfoot_td]:sticky [&_tfoot_td]:bottom-0 [&_tfoot_td]:z-sticky [&_tfoot_td]:bg-surface-solid [&_tfoot_td]:border-t [&_tfoot_td]:border-[var(--glass-border)] [&_tfoot_td]:px-3 [&_tfoot_td]:py-2";

const tone = (v: number | null | undefined) => (v == null || Math.abs(v) < 1e-12 ? "" : v > 0 ? "text-up" : "text-down");

export function MonthlyPanel({ ctx, today, onPickMonth }: { ctx: Ctx; today: string; onPickMonth: (m: number) => void }) {
  const { focus, view, unit } = ctx;
  const { t } = officeI18n.useT();
  const prevY = view.years.find((y) => y.year === focus.year - 1 && y.hasData);
  const curMonth = Number(today.slice(0, 4)) === focus.year ? Number(today.slice(5, 7)) : 13;

  const rows = React.useMemo<Row[]>(() => {
    const last = focus.months.reduce((a, m) => (m.days ? m.month : a), 0);
    const out: Row[] = [];
    let cum = 0;
    let prevV: number | null = null;
    for (const m of focus.months) {
      if (m.month > last) break;
      cum += m.v ?? 0;
      const running = m.month === curMonth;
      const py = prevY?.months.find((x) => x.month === m.month);
      const pyV = py && py.days ? py.v ?? 0 : null;
      // Plan = straight line to the yearly goal; the running month is compared with the plan for today.
      const plan = focus.goal == null ? null : running && focus.pace ? focus.pace.expected : (focus.goal * m.month) / 12;
      out.push({
        month: m.month, v: m.days ? m.v ?? 0 : null, days: m.days, green: m.green, trades: m.trades,
        mom: m.days && prevV != null ? (m.v ?? 0) - prevV : null,
        prevYear: pyV, yoy: m.days && pyV != null ? (m.v ?? 0) - pyV : null,
        cum, plan, vsPlan: plan == null ? null : cum - plan, running,
      });
      if (m.days) prevV = m.v ?? 0;
    }
    return out;
  }, [focus, prevY, curMonth]);

  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.v ?? 0)));
  const hasPlan = focus.goal != null;
  const totalDays = rows.reduce((a, r) => a + r.days, 0);
  const totalGreen = rows.reduce((a, r) => a + r.green, 0);
  const totalTrades = rows.reduce((a, r) => a + r.trades, 0);
  const lastRow = rows[rows.length - 1];
  const prevTotal = prevY ? rows.reduce((a, r) => a + (r.prevYear ?? 0), 0) : null;

  const exportCsv = () => {
    const u = unit === "usd" ? "$" : "%";
    downloadCsv(`office-months-${focus.year}-${unit}.csv`, [
      [t("cols.month"), t("cols.netUnit", { unit: u }), t("monthly.deltaPrevUnit", { unit: u }), ...(prevY ? [t("monthly.yearUnit", { year: prevY.year, unit: u }), t("monthly.deltaYearUnit", { year: prevY.year, unit: u })] : []), t("cols.ytdUnit", { unit: u }),
        ...(hasPlan ? [t("monthly.planUnit", { unit: u }), t("monthly.vsPlanUnit", { unit: u })] : []), t("cols.tradingDays"), t("cols.greenDaysCount"), t("cols.trades")],
      ...rows.map((r) => [
        t(r.running ? "monthly.runningCsv" : "period.monthOfYear", { month: monthLong(r.month - 1), year: focus.year }), r.v, r.mom,
        ...(prevY ? [r.prevYear, r.yoy] : []), r.cum, ...(hasPlan ? [r.plan, r.vsPlan] : []), r.days, r.green, r.trades,
      ]),
    ]);
  };

  return (
    <Panel
      title={t("monthly.title")}
      description={[
        prevY ? t("monthly.descWithPrev", { year: focus.year, prev: prevY.year }) : t("monthly.desc", { year: focus.year }),
        ...(hasPlan ? [t("monthly.descPlan")] : []),
        t("monthly.descTail"),
      ].join(" · ")}
      icon={CalendarRange}
      actions={rows.length > 0 && <Button variant="ghost" size="sm" onClick={exportCsv} aria-label={t("monthly.csvAria")}><Download className="h-4 w-4" /> CSV</Button>}
    >
      {!rows.length ? <EmptyState compact icon={CalendarRange} title={t("states.noTradesYear", { year: focus.year })} /> : (
        <DataTable ariaLabel={t("monthly.tableAria", { year: focus.year })} className={cn(TFOOT, "[&_tbody_td]:px-2 [&_tfoot_td]:px-2 [&_thead_th]:px-2 [&_thead_th]:h-auto [&_thead_th]:min-h-9 [&_thead_th]:whitespace-normal [&_thead_th]:align-bottom [&_thead_th]:leading-tight")}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("cols.month")}</th>
                <th scope="col" className="text-right">{t("cols.net")}</th>
                <th scope="col" className="text-right" title={t("monthly.deltaPrevTip")}>{t("monthly.deltaPrev")}</th>
                {prevY && <th scope="col" className="text-right" title={t("monthly.sameMonth", { year: prevY.year })}>{prevY.year}</th>}
                {prevY && <th scope="col" className="text-right" title={t("monthly.deltaYearTip", { year: prevY.year })}>{t("monthly.deltaYear", { year: prevY.year })}</th>}
                <th scope="col" className="text-right">{t("monthly.ytd")}</th>
                {hasPlan && <th scope="col" className="text-right" title={t("monthly.planTip", { pct: focus.goalPct })}>{t("monthly.plan")}</th>}
                {hasPlan && <th scope="col" className="text-right" title={t("monthly.vsPlanTip")}>{t("monthly.vsPlan")}</th>}
                <th scope="col" className="text-right" title={t("monthly.greenTip")}>{t("cols.greenDays")}</th>
                <th scope="col" className="hidden text-right min-[1400px]:table-cell">{t("cols.trades")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.month}
                  className={cn("cursor-pointer", !r.days && "opacity-50")}
                  onClick={() => r.days && onPickMonth(r.month)}
                >
                  <td>
                    <button
                      type="button"
                      disabled={!r.days}
                      onClick={(e) => { e.stopPropagation(); onPickMonth(r.month); }}
                      className="inline-flex items-center gap-2 rounded-md font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                      title={r.days ? t("monthly.open", { month: fmtMonth(r.month - 1, "long"), year: focus.year }) : t("states.noTrades")}
                    >
                      {monthLong(r.month - 1)}
                      {r.running && <Pill tone="accent">{t("monthly.running")}</Pill>}
                    </button>
                  </td>
                  <td className="text-right">
                    <span className="inline-flex items-center justify-end gap-2">
                      <span className="relative hidden h-1.5 w-14 rounded-full bg-[var(--glass-bg)] xl:inline-block" aria-hidden="true">
                        {r.v != null && <span className={cn("absolute inset-y-0 left-0 rounded-full", r.v >= 0 ? "bg-up" : "bg-down")} style={{ width: `${Math.max(4, (Math.abs(r.v) / max) * 100)}%` }} />}
                      </span>
                      <b className={cn("min-w-[4.5rem] font-semibold", tone(r.v))}>{fmtV(r.v, unit)}</b>
                    </span>
                  </td>
                  <td className={cn("text-right", tone(r.mom))}>{fmtV(r.mom, unit)}</td>
                  {prevY && <td className="text-right text-muted-foreground">{fmtV(r.prevYear, unit)}</td>}
                  {prevY && <td className={cn("text-right", tone(r.yoy))}>{fmtV(r.yoy, unit)}</td>}
                  <td className={cn("text-right font-medium", tone(r.cum))}>{fmtV(r.cum, unit)}</td>
                  {hasPlan && <td className="text-right text-muted-foreground">{fmtV(r.plan, unit)}</td>}
                  {hasPlan && <td className={cn("text-right font-medium", r.vsPlan == null ? "" : r.vsPlan >= 0 ? "text-up" : "text-warn")}>{fmtV(r.vsPlan, unit)}</td>}
                  <td className="whitespace-nowrap text-right" title={r.days ? t("monthly.greenOfDays", { green: r.green, days: r.days }) : undefined}>{r.days ? <>{fmtShare(r.green / r.days)}<span className="ml-1 hidden text-2xs text-muted-foreground min-[1400px]:inline">{r.green}/{r.days}</span></> : "—"}</td>
                  <td className="hidden text-right min-[1400px]:table-cell">{fmtCount(r.trades)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td>{t("monthly.total", { year: focus.year })}</td>
                <td className={cn("text-right", tone(focus.totals.net))}>{fmtV(focus.totals.net, unit)}</td>
                <td className="text-right text-muted-foreground">—</td>
                {prevY && <td className="text-right text-muted-foreground">{fmtV(prevTotal, unit)}</td>}
                {prevY && <td className={cn("text-right", tone(prevTotal == null ? null : focus.totals.net - prevTotal))}>{prevTotal == null ? "—" : fmtV(focus.totals.net - prevTotal, unit)}</td>}
                <td className={cn("text-right", tone(lastRow?.cum))}>{fmtV(lastRow?.cum, unit)}</td>
                {hasPlan && <td className="whitespace-nowrap text-right text-muted-foreground" title={t("monthly.goalTip")}>{t("monthly.goal", { value: fmtV(focus.goal, unit) })}</td>}
                {hasPlan && <td className={cn("text-right", (lastRow?.vsPlan ?? 0) >= 0 ? "text-up" : "text-warn")}>{fmtV(lastRow?.vsPlan, unit)}</td>}
                <td className="text-right">{totalDays ? fmtShare(totalGreen / totalDays) : "—"}</td>
                <td className="hidden text-right min-[1400px]:table-cell">{fmtCount(totalTrades)}</td>
              </tr>
            </tfoot>
          </table>
        </DataTable>
      )}
    </Panel>
  );
}

