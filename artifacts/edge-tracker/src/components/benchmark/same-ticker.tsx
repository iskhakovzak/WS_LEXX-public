import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Users } from "lucide-react";
import { DataTable, EmptyState, FilterChip, Panel, Pill, toneOf, toneText } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import type { SameTickerCase, SameTickerResponse } from "./api";
import { fmtClock, fmtMinutes } from "./format";
import { fmtDate, fmtNum, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import { benchmarkI18n } from "@/i18n/ns/benchmark";
import { personName } from "@/i18n";

function CaseCard({ c }: { c: SameTickerCase }) {
  const { t } = benchmarkI18n.useT();
  return (
    <Panel
      title={<span className="flex items-center gap-2"><span className="font-mono">{c.ticker}</span><span className="text-muted-foreground">{fmtDate(c.day, "shortYY")}</span></span>}
      description={[
        t("same.traders", { count: c.traders }),
        c.sameSide ? t("same.sameSide") : t("same.diffSide"),
        c.rankBy ? t("same.place", { by: t(`same.rankBy.${c.rankBy}`) }) : t("same.noRank"),
      ].join(" · ")}
      actions={
        <div className="flex items-center gap-2">
          {c.spread != null && <Pill tone="warn" title={t("same.spreadTitle")}>{t("same.spread", { value: fmtUsd(c.spread, { decimals: "auto" }) })}</Pill>}
          <Link href={links.trades({ ticker: c.ticker, date: c.day })} className="text-xs text-primary underline-offset-2 hover:underline">{t("same.trades")}</Link>
        </div>
      }
    >
      <DataTable ariaLabel={t("same.aria", { ticker: c.ticker, day: fmtDate(c.day, "shortYY") })}>
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t("same.col.trader")}</th>
              <th scope="col">{t("same.col.side")}</th>
              <th scope="col" className="text-right">{t("same.col.tradesShares")}</th>
              <th scope="col" className="text-right">{t("same.col.entry")}</th>
              <th scope="col" className="text-right">{t("same.col.exit")}</th>
              <th scope="col" className="text-right">{t("same.col.timeEt")}</th>
              <th scope="col" className="text-right">{t("same.col.hold")}</th>
              <th scope="col" className="text-right">{t("same.col.captured")}</th>
              <th scope="col" className="text-right">{t("same.col.result")}</th>
            </tr>
          </thead>
          <tbody>
            {c.participants.map((p) => (
              <tr key={p.trader}>
                <td className="text-muted-foreground">{p.rank ?? "—"}</td>
                <td className="font-medium text-foreground">
                  <Link href={links.journalDay(c.day, p.trader)} className="hover:underline">{personName(p.trader)}</Link>
                </td>
                <td>{p.side ? <Pill tone={p.side === "long" ? "up" : p.side === "short" ? "down" : "neutral"}>{t(`same.side.${p.side}`)}</Pill> : "—"}</td>
                <td className="text-right">{p.trades}{p.qty != null && <span className="text-muted-foreground"> / {Math.round(p.qty)}</span>}</td>
                <td className="text-right">
                  {fmtPrice(p.avgEntry, p.avgEntry != null && p.avgEntry >= 1 && p.avgEntry < 10 ? { decimals: 3 } : {})}
                  {p.entryGapPct != null && p.entryGapPct > 0.005 && <div className="text-2xs text-down">{t("same.worseBy", { value: fmtNum(p.entryGapPct) })}</div>}
                  {p.entryGapPct === 0 && c.participants.filter((x) => x.side === p.side).length > 1 && <div className="text-2xs text-up">{t("same.bestEntry")}</div>}
                </td>
                <td className="text-right">
                  {fmtPrice(p.avgExit, p.avgExit != null && p.avgExit >= 1 && p.avgExit < 10 ? { decimals: 3 } : {})}
                  {p.exitGapPct != null && p.exitGapPct > 0.005 && <div className="text-2xs text-down">{t("same.worseBy", { value: fmtNum(p.exitGapPct) })}</div>}
                  {p.exitGapPct === 0 && c.participants.filter((x) => x.side === p.side).length > 1 && <div className="text-2xs text-up">{t("same.bestExit")}</div>}
                </td>
                <td className="text-right text-xs">{p.firstEntryMin != null ? `${fmtClock(p.firstEntryMin)} → ${fmtClock(p.lastExitMin)}` : "—"}</td>
                <td className="text-right">{fmtMinutes(p.holdMin)}</td>
                <td className={cn("text-right", toneText(toneOf(p.capturePct)))}>
                  {p.capturePct != null ? `${p.capturePct > 0 ? "+" : ""}${fmtNum(p.capturePct)}%` : "—"}
                  {p.capturePerShare != null && <div className="text-2xs text-muted-foreground">{t("same.perShare", { value: fmtNum(p.capturePerShare, 3) })}</div>}
                </td>
                <td className={cn("text-right font-medium", toneText(toneOf(p.net ?? p.r)))}>
                  {p.net != null ? fmtUsd(p.net, { signed: true, decimals: "auto" }) : fmtR(p.r)}
                  {p.net != null && p.r != null && <div className="text-2xs font-normal text-muted-foreground">{fmtR(p.r)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
    </Panel>
  );
}

export function SameTickerView({ data, loading, error }: { data: SameTickerResponse | undefined; loading: boolean; error: Error | null }) {
  const { t } = benchmarkI18n.useT();
  const [pair, setPair] = useState<string | null>(null);
  const [onlySameSide, setOnlySameSide] = useState(false);
  const cases = useMemo(() => {
    let list = data?.cases ?? [];
    if (pair) { const [a, b] = pair.split("|"); list = list.filter((c) => c.participants.some((p) => p.trader === a) && c.participants.some((p) => p.trader === b)); }
    if (onlySameSide) list = list.filter((c) => c.sameSide);
    return list;
  }, [data, pair, onlySameSide]);

  if (loading && !data) return <div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}</div>;
  if (error) return <EmptyState icon={Users} title={t("same.loadError")} description={error.message} />;
  if (!data || data.total === 0) {
    return (
      <EmptyState icon={Users} title={t("same.none")}
        description={t("same.noneHint")} />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("same.pairs")}</span>
        <FilterChip active={pair == null} onClick={() => setPair(null)} count={data.total}>{t("same.all")}</FilterChip>
        {data.pairs.slice(0, 12).map((p) => {
          const k = `${p.a}|${p.b}`;
          return <FilterChip key={k} active={pair === k} onClick={() => setPair(pair === k ? null : k)} count={p.cases}>{personName(p.a)} × {personName(p.b)}</FilterChip>;
        })}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <FilterChip active={onlySameSide} onClick={() => setOnlySameSide((v) => !v)}>{t("same.onlySameSide")}</FilterChip>
      </div>
      {cases.length === 0 ? (
        <EmptyState icon={Users} title={t("same.noCases")} />
      ) : (
        cases.map((c) => <CaseCard key={`${c.day}-${c.ticker}`} c={c} />)
      )}
      {data.total > data.cases.length && <p className="text-xs text-muted-foreground">{t("same.shown", { shown: data.cases.length, total: data.total })}</p>}

    </div>
  );
}
