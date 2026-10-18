import { Link } from "wouter";
import { BarChart3, ServerCog } from "lucide-react";
import { DataTable, EmptyState, Panel, Pill, Segmented, SortableTh, StatCard, StatGrid, TermTooltip, UpdatedAgo, toneOf, usePersistentState, useTableSort } from "@/components/ds";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { MiniBar } from "./bits";
import { isMissingEndpoint, useMyOfferingStats } from "./use-offerings-data";
import { fmtDay, type DayBucket } from "./types";
import { fmtUsd } from "@/lib/format";
import { humanizeApiError } from "@/lib/api/errors";
import { commonI18n } from "@/i18n/ns/common";
import { offeringsI18n } from "@/i18n/ns/offerings";
import { rich } from "@/i18n/rich";

const wr = (b: DayBucket | undefined) => (b?.winRate != null ? `${Math.round(b.winRate)}%` : "—");

function BucketRow({ label, b, onClick }: { label: React.ReactNode; b: DayBucket; onClick?: () => void }) {
  return (
    <tr onClick={onClick} className={cn(onClick && "cursor-pointer")}>
      <td className="font-medium text-foreground">{label}</td>
      <td className="text-right">{b.trades}</td>
      <td className={cn("text-right", b.net > 0 ? "text-up" : b.net < 0 ? "text-down" : "")}>{fmtUsd(b.net, { signed: true, compact: true })}</td>
      <td className="text-right">{wr(b)}</td>
      <td className="text-right text-muted-foreground">{fmtUsd(b.avgNet, { signed: true, compact: true })}</td>
    </tr>
  );
}

type TickerBucket = DayBucket & { ticker: string; days: string[] };
type TickerKey = "ticker" | "trades" | "net" | "wr" | "avg";
const TICKER_ACCESSORS: Record<TickerKey, (b: TickerBucket) => number | string | null> = {
  ticker: (b) => b.ticker,
  trades: (b) => b.trades,
  net: (b) => b.net,
  wr: (b) => b.winRate,
  avg: (b) => b.avgNet,
};

function ByTickerTable({ rows, onOpenTicker }: { rows: TickerBucket[]; onOpenTicker: (t: string) => void }) {
  const { rows: sorted, thProps } = useTableSort(rows, TICKER_ACCESSORS, "net");
  const { t } = offeringsI18n.useT();
  return (
    <DataTable maxHeight="70dvh" ariaLabel={t("stats.tableAria")}>
      <table>
        <thead>
          <tr>
            <SortableTh {...thProps("ticker")}>{commonI18n.t("trading.ticker")}</SortableTh>
            <SortableTh {...thProps("trades")} align="right">{t("stats.colTrades")}</SortableTh>
            <SortableTh {...thProps("net")} align="right">Net</SortableTh>
            <SortableTh {...thProps("wr")} align="right">WR</SortableTh>
            <SortableTh {...thProps("avg")} align="right">{t("stats.colAvg")}</SortableTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => (
            <BucketRow key={t.ticker} b={t} onClick={() => onOpenTicker(t.ticker)}
              label={<span className="inline-flex items-center gap-2">{t.ticker}<span className="text-2xs font-normal text-muted-foreground" title={t.days.map((d) => fmtDay(d)).join(", ")}>{t.days.slice(0, 2).map((d) => fmtDay(d)).join(", ")}{t.days.length > 2 ? ` +${t.days.length - 2}` : ""}</span></span>} />
          ))}
        </tbody>
      </table>
    </DataTable>
  );
}

/**
 * The trader's own results on days the traded ticker had a priced offering vs all other days.
 * Trades come from the journal (PropReports), offering days from SEC submissions.
 */
export function MyStatsView({ onOpenTicker }: { onOpenTicker: (t: string) => void }) {
  const { t } = offeringsI18n.useT();
  const trades = (n: number) => commonI18n.t("units.trades", { count: n });
  const [win, setWin] = useWindow();
  const q = useMyOfferingStats(win, true);
  const s = q.data;

  if (isMissingEndpoint(q.error)) {
    return (
      <Panel>
        <EmptyState icon={ServerCog} title={t("stats.needsServer")}
          description={t("stats.needsServerText")} />
      </Panel>
    );
  }
  if (q.error) {
    return <Panel><EmptyState icon={BarChart3} title={t("stats.failed")} description={humanizeApiError(q.error)} /></Panel>;
  }

  const off = s?.offering;
  const norm = s?.normal;
  const pending = s?.coverage.pending ?? 0;
  const diffWr = off?.winRate != null && norm?.winRate != null ? off.winRate - norm.winRate : null;
  const empty = s && s.coverage.trades === 0;

  return (
    <div className="flex min-w-0 flex-col gap-[var(--grid-gap)]">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<"0" | "1">
          ariaLabel={t("stats.windowAria")}
          size="sm"
          value={String(win) as "0" | "1"}
          onChange={(v) => setWin(v === "1" ? 1 : 0)}
          options={[{ value: "0", label: t("stats.dealDay") }, { value: "1", label: t("stats.plusNext") }]}
        />
        <span className="text-xs text-muted-foreground">
          {s ? t("stats.coverage", { covered: s.coverage.covered, tickers: t("stats.coverageTickers", { count: s.coverage.tickers }), trades: trades(s.coverage.trades) }) : t("stats.checking")}
        </span>
        {pending > 0 && <MiniBar value={s!.coverage.covered} max={s!.coverage.tickers} className="w-32" label={t("stats.progress")} />}
        {s && <UpdatedAgo at={s.fetchedAt} className="ml-auto" />}
      </div>

      {empty ? (
        <Panel><EmptyState icon={BarChart3} title={t("stats.emptyTitle")} description={t("stats.emptyText")} /></Panel>
      ) : (
        <>
          <StatGrid min="12rem">
            <StatCard loading={!s} label={t("stats.netOffering")} value={off ? fmtUsd(off.net, { signed: true, compact: true }) : "—"} tone={toneOf(off?.net)}
              hint={off ? t("stats.tradesTickers", { trades: trades(off.trades), tickers: commonI18n.t("units.tickers", { count: off.tickers }) }) : undefined} />
            <StatCard loading={!s} label={t("stats.wrOffering")} value={wr(off)}
              delta={diffWr != null ? t("stats.vsNormal", { value: `${diffWr > 0 ? "+" : ""}${Math.round(diffWr)}` }) : undefined}
              deltaTone={diffWr == null ? "neutral" : diffWr >= 0 ? "up" : "down"} term="winrate" />
            <StatCard loading={!s} label={t("stats.netNormal")} value={norm ? fmtUsd(norm.net, { signed: true, compact: true }) : "—"} tone={toneOf(norm?.net)}
              hint={norm ? t("stats.tradesWr", { trades: trades(norm.trades), wr: wr(norm) }) : undefined} />
            <StatCard loading={!s} label={t("stats.avgTrade")}
              value={off && norm ? <span className="text-xl">{fmtUsd(off.avgNet, { signed: true, compact: true })} <span className="text-muted-foreground">/</span> {fmtUsd(norm.avgNet, { signed: true, compact: true })}</span> : "—"}
              hint={t("stats.perTrade")} />
          </StatGrid>

          {s && s.excludedWksi.length > 0 && (
            <p className="text-xs text-muted-foreground" title={s.excludedWksi.join(", ")}>
              {rich(t("stats.excluded", { count: s.excludedWksi.length, dilution: "{dilution}" }), { dilution: <TermTooltip term="dilution">{t("stats.dilution")}</TermTooltip> })}
            </p>
          )}

          <div className="grid min-w-0 items-start gap-[var(--grid-gap)] xl:grid-cols-2">
            <Panel title={t("stats.byTicker")} description={t("stats.byTickerText")} padded={false} bodyClassName="p-2">
              {!s ? <div className="skeleton m-2 h-48 rounded-xl" /> : s.byTicker.length === 0 ? (
                <EmptyState compact icon={BarChart3} title={pending > 0 ? t("stats.stillChecking") : t("stats.noTrades")} />
              ) : (
                <ByTickerTable rows={s.byTicker} onOpenTicker={onOpenTicker} />
              )}
            </Panel>

            <div className="flex min-w-0 flex-col gap-[var(--grid-gap)]">
              <Panel title={t("stats.byForm")} padded={false} bodyClassName="p-2">
                {!s ? <div className="skeleton m-2 h-24 rounded-xl" /> : s.byForm.length === 0 ? (
                  <EmptyState compact icon={BarChart3} title={commonI18n.t("states.noData")} />
                ) : (
                  <DataTable>
                    <table>
                      <thead><tr><th>{t("stats.colForm")}</th><th className="text-right">{t("stats.colTrades")}</th><th className="text-right">Net</th><th className="text-right">WR</th><th className="text-right">{t("stats.colAvg")}</th></tr></thead>
                      <tbody>
                        {s.byForm.map((f) => (
                          <BucketRow key={f.form} b={f} label={<span title={f.form === "424B4" ? t("stats.form424b4") : f.form === "424B5" ? t("stats.form424b5") : f.form === "424B7" ? t("stats.form424b7") : undefined}>{f.form}</span>} />
                        ))}
                      </tbody>
                    </table>
                  </DataTable>
                )}
              </Panel>

              <Panel title={t("stats.recent")} padded={false} bodyClassName="p-2">
                {!s ? <div className="skeleton m-2 h-40 rounded-xl" /> : s.recent.length === 0 ? (
                  <EmptyState compact icon={BarChart3} title={t("stats.nothingYet")} />
                ) : (
                  <ul className="max-h-[60dvh] divide-y divide-border/50 overflow-y-auto text-sm">
                    {s.recent.map((r) => (
                      <li key={r.id}>
                        <Link href={links.trade(r.id)} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--glass-hover-bg)]">
                          <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{fmtDay(r.date, { day: "numeric", month: "short", year: "2-digit" })}</span>
                          <span className="font-medium text-foreground">{r.ticker}</span>
                          {r.form && <Pill tone="purple" className="px-1.5 text-2xs">{r.form}</Pill>}
                          {r.offeringDay !== r.date && <span className="text-2xs text-muted-foreground">{t("stats.dayAfter")}</span>}
                          <span className={cn("ml-auto tabular-nums", r.net == null ? "text-muted-foreground" : r.net >= 0 ? "text-up" : "text-down")}>{fmtUsd(r.net, { signed: true, compact: true })}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function useWindow() {
  const [w, setW] = usePersistentState<0 | 1>("offerings.mystats.window", 0);
  return [w === 1 ? 1 : 0, setW] as const;
}
