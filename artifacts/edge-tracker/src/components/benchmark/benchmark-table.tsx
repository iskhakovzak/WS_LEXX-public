import { useMemo, useState } from "react";
import { DataTable, Pill, SortableTh, Sparkline, toneOf, toneText, useTableSort } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { BenchRow } from "./api";
import { fmtMinutes } from "./format";
import { fmtDate, fmtNum, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { benchmarkI18n } from "@/i18n/ns/benchmark";
import { personName } from "@/i18n";
import { PeopleSearchInput } from "@/components/people/people-search-input";
import { matchPerson, prepareQuery, usePeopleAliases } from "@/components/people/search";

type Key =
  | "trader" | "trades" | "tpd" | "winRate" | "pf" | "net" | "expectancy" | "feeShare" | "sharpe" | "sortino" | "dd"
  | "green" | "bestDay" | "streak" | "hold" | "first15" | "rcov";

const ACCESSORS: Record<Key, (r: BenchRow) => number | string | null | undefined> = {
  trader: (r) => personName(r.trader),
  trades: (r) => r.trades,
  tpd: (r) => r.tradesPerDay,
  winRate: (r) => r.winRate,
  pf: (r) => r.profitFactor,
  net: (r) => r.net ?? (r.totalR != null ? r.totalR * 1e-6 : null),
  expectancy: (r) => r.expectancy ?? (r.expectancyR != null ? r.expectancyR * 1e-6 : null),
  feeShare: (r) => r.feeShare,
  sharpe: (r) => r.sharpe,
  sortino: (r) => r.sortino,
  dd: (r) => (r.maxDd == null ? null : -r.maxDd),
  green: (r) => r.greenShare,
  bestDay: (r) => (r.bestDayShare == null ? null : -r.bestDayShare),
  streak: (r) => -r.maxLossStreak,
  hold: (r) => r.avgHoldMin,
  first15: (r) => r.first15Share,
  rcov: (r) => r.rCoverage,
};

const CONS_TONE = { ok: "up", warn: "warn", breach: "down" } as const;

export function BenchmarkTable({
  rows, selected, onToggleSelect, me,
}: {
  rows: BenchRow[];
  selected: string[];
  onToggleSelect: (trader: string) => void;
  me: string;
}) {
  const { t } = benchmarkI18n.useT();
  const [q, setQ] = useState("");
  const aliases = usePeopleAliases();
  const shown = useMemo(() => {
    const pq = prepareQuery(q);
    return pq.empty ? rows : rows.filter((r) => matchPerson(pq, r.trader, aliases));
  }, [rows, q, aliases]);
  const { rows: sorted, thProps } = useTableSort(shown, ACCESSORS, "net");
  const sel = useMemo(() => new Set(selected), [selected]);
  return (
    <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <PeopleSearchInput value={q} onChange={setQ} />
      {q && <span className="text-xs tabular-nums text-muted-foreground">{t("table.ofTotal", { shown: shown.length, total: rows.length })}</span>}
    </div>
    <DataTable maxHeight="70vh" stickyFirstCol ariaLabel={t("table.aria")}>
      <table>
        <thead>
          <tr>
            <SortableTh {...thProps("trader")}>{t("table.col.trader")}</SortableTh>
            <th scope="col">{t("table.col.curve")}</th>
            <SortableTh {...thProps("trades")} align="right">{t("table.col.trades")}</SortableTh>
            <SortableTh {...thProps("tpd")} align="right">{t("table.col.perDay")}</SortableTh>
            <SortableTh {...thProps("winRate")} align="right">Win rate</SortableTh>
            <SortableTh {...thProps("pf")} align="right">PF</SortableTh>
            <SortableTh {...thProps("net")} align="right">{t("table.col.net")}</SortableTh>
            <SortableTh {...thProps("expectancy")} align="right">{t("table.col.expectancy")}</SortableTh>
            <th scope="col" className="text-right" title={t("table.avgWinLossTitle")}>{t("table.col.avgWinLoss")}</th>
            <SortableTh {...thProps("feeShare")} align="right">{t("table.col.fees")}</SortableTh>
            <SortableTh {...thProps("sharpe")} align="right">Sharpe</SortableTh>
            <SortableTh {...thProps("sortino")} align="right">Sortino</SortableTh>
            <SortableTh {...thProps("dd")} align="right">{t("table.col.maxDd")}</SortableTh>
            <SortableTh {...thProps("green")} align="right">{t("table.col.green")}</SortableTh>
            <SortableTh {...thProps("bestDay")} align="right">{t("table.col.bestDay")}</SortableTh>
            <SortableTh {...thProps("streak")} align="right">{t("table.col.streaks")}</SortableTh>
            <SortableTh {...thProps("hold")} align="right">{t("table.col.hold")}</SortableTh>
            <SortableTh {...thProps("first15")} align="right">9:30–9:45</SortableTh>
            <SortableTh {...thProps("rcov")} align="right">{t("table.col.rCoverage")}</SortableTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const usd = r.equityUnit === "usd";
            const isSel = sel.has(r.trader);
            return (
              <tr key={r.trader} className={cn(!r.qualified && "opacity-60", isSel && "bg-primary/5")}>
                <td className="min-w-[220px] align-top">
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                      checked={isSel}
                      onChange={() => onToggleSelect(r.trader)}
                      aria-label={t("table.select", { name: personName(r.trader) })}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-foreground">{personName(r.trader)}</span>
                        {r.trader === me && <Pill tone="accent">{t("table.you")}</Pill>}
                        {!r.qualified && <Pill title={t("table.fewTradesTitle")}>{t("table.fewTrades")}</Pill>}
                      </div>
                      {r.badges.length > 0 && (
                        <div className="mt-1 flex max-w-[280px] flex-wrap gap-1">
                          {r.badges.slice(0, 4).map((b) => (
                            <Pill key={b.key + b.kind} tone={b.kind === "strength" ? "up" : "down"} title={b.detail} className="text-2xs">
                              {b.kind === "strength" ? "▲" : "▼"} {b.label}
                            </Pill>
                          ))}
                          {r.badges.length > 4 && <Pill title={r.badges.slice(4).map((b) => b.label).join(", ")} className="text-2xs">+{r.badges.length - 4}</Pill>}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td>
                  <Sparkline
                    data={r.equity.map((p) => p.cum)}
                    width={96}
                    height={28}
                    baseline={0}
                    ariaLabel={t("table.curveAria", { name: personName(r.trader), value: usd ? fmtUsd(r.equity.at(-1)?.cum, { signed: true, decimals: "auto" }) : fmtR(r.equity.at(-1)?.cum) })}
                  />
                </td>
                <td className="text-right">
                  {r.trades}
                  <div className="text-2xs text-muted-foreground">{t("table.days", { count: r.days })}</div>
                </td>
                <td className="text-right">{fmtNum(r.tradesPerDay, 1)}</td>
                <td className="text-right" title={`${r.wins} W / ${r.losses} L / ${r.be} BE`}>{fmtRate(r.winRate)}</td>
                <td className="text-right" title={r.profitFactor == null && r.losses === 0 && r.wins > 0 ? t("table.pfUndefined") : undefined}>
                  {r.profitFactor != null ? fmtNum(r.profitFactor) : r.profitFactorR != null ? <span className="text-muted-foreground">{fmtNum(r.profitFactorR)}R</span> : "—"}
                </td>
                <td className={cn("text-right font-medium", toneText(toneOf(r.net ?? r.totalR)))}>
                  {r.net != null ? fmtUsd(r.net, { signed: true, decimals: "auto" }) : r.totalR != null ? fmtR(r.totalR) : "—"}
                  {r.net != null && r.gross != null && <div className="text-2xs font-normal text-muted-foreground">{t("table.gross", { value: fmtUsd(r.gross, { signed: true, decimals: "auto" }) })}</div>}
                </td>
                <td className={cn("text-right", toneText(toneOf(r.expectancy ?? r.expectancyR)))}>
                  {r.expectancy != null ? fmtUsd(r.expectancy, { signed: true, decimals: "auto" }) : fmtR(r.expectancyR)}
                </td>
                <td className="text-right text-xs">
                  <span className="text-up">{fmtUsd(r.avgWin, { signed: true, decimals: "auto" })}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="text-down">{fmtUsd(r.avgLoss, { signed: true, decimals: "auto" })}</span>
                </td>
                <td className={cn("text-right", (r.feeShare ?? 0) > 0.3 && "text-down")} title={r.fees != null ? t("table.feesTitle", { value: fmtUsd(r.fees, { decimals: "auto" }) }) : undefined}>
                  {fmtRate(r.feeShare)}
                  {r.fees != null && <div className="text-2xs text-muted-foreground">{fmtUsd(r.fees, { decimals: "auto" })}</div>}
                </td>
                <td className="text-right">{fmtNum(r.sharpe)}</td>
                <td className="text-right">{fmtNum(r.sortino)}</td>
                <td className="text-right">
                  {r.maxDd != null ? fmtUsd(r.maxDd, { decimals: "auto" }) : "—"}
                  {r.maxDd != null && r.maxDd > 0 && (
                    <div className={cn("text-2xs", r.ddRecovered ? "text-muted-foreground" : "text-down")}>
                      {r.ddRecovered ? t("table.recovered", { count: r.recoveryDays ?? 0 }) : t("table.notRecovered")}
                    </div>
                  )}
                </td>
                <td className="text-right" title={t("table.greenRedTitle", { green: r.greenDays, red: r.redDays })}>{fmtRate(r.greenShare)}</td>
                <td className="text-right">
                  {r.bestDayShare != null && r.consistencyFlag ? (
                    <Pill tone={CONS_TONE[r.consistencyFlag]} title={r.bestDay ? `${fmtDate(r.bestDay.day, "shortYY")}: ${fmtUsd(r.bestDay.net, { signed: true, decimals: "auto" })}` : undefined}>
                      {r.bestDayShare > 9.99 ? ">999%" : fmtRate(r.bestDayShare)}
                    </Pill>
                  ) : "—"}
                </td>
                <td className="text-right">
                  <span className="text-up">{r.maxWinStreak}</span> / <span className="text-down">{r.maxLossStreak}</span>
                </td>
                <td className="text-right" title={t("table.holdTitle", { win: fmtMinutes(r.avgHoldWinMin), loss: fmtMinutes(r.avgHoldLossMin) })}>{fmtMinutes(r.avgHoldMin)}</td>
                <td className="text-right">
                  {r.first15Share != null ? fmtRate(r.first15Share) : "—"}
                  {r.first15Net != null && <div className={cn("text-2xs", toneText(toneOf(r.first15Net)))}>{fmtUsd(r.first15Net, { signed: true, decimals: "auto" })}</div>}
                </td>
                <td className="text-right">
                  {fmtRate(r.rCoverage)}
                  {r.rTrades > 0 && <div className="text-2xs text-muted-foreground">{fmtR(r.totalR)}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-3 py-2 text-2xs text-muted-foreground">
        {t("table.footnote")}

      </p>
    </DataTable>
    </div>
  );
}
