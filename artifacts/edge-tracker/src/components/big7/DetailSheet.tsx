/**
 * Ticker detail sheet: metric strip, 5-minute chart of the session (chart-engine WsChart, with its own
 * PDH/PDL/premarket/VWAP overlays), the automatic day-level ladder, saved levels, own stats and catalysts.
 */
import { Check, ChevronLeft, ChevronRight, Flame, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Pill, toneOf, TermTooltip } from "@/components/ds";
import { WsChart } from "@/components/chart-engine";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { useAuth } from "@/contexts/auth-context";
import { LIST_LABELS } from "@/components/watchlist/lib";
import { useQuickAddToWatchlist, useWatchlistIndex } from "@/components/watchlist/use-quick-add";
import { type GapStats, type MergedCatalyst, type StockQuote } from "./lib";
import type { Big7Row, LevelPoint, Phase } from "./context";
import { LevelsLadder } from "./LevelsLadder";
import { CatalystTimeline } from "./catalysts";
import { MyTickerStats } from "./MyStatsPanel";
import type { MyTicker } from "./use-big7";
import { Signed, earningsLabel, fmtRvol } from "./ui";
import { fmtDate, fmtPct, fmtPrice } from "@/lib/format";
import { big7I18n } from "@/i18n/ns/big7";

function Metric({ label, children, title }: { label: React.ReactNode; children: React.ReactNode; title?: string }) {
  return (
    <div className="tile min-w-0 px-3 py-2" title={title}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-semibold tabular-nums">{children}</div>
    </div>
  );
}

/** Day levels around the price, highest first, with a «now» marker between them. */
function DayLadder({ row }: { row: Big7Row }) {
  const items: Array<LevelPoint | "price"> = [];
  let placed = false;
  for (const l of row.levels) {
    if (!placed && row.price != null && l.price < row.price) { items.push("price"); placed = true; }
    items.push(l);
  }
  if (!placed && row.price != null) items.push("price");
  const t = big7I18n.t;
  return (
    <section aria-label={t("detail.dayLevels")} className="tile flex min-w-0 flex-col gap-1 p-3">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t("detail.dayLevels")}</span>
        <span>% / <TermTooltip term="atr" /></span>
      </div>
      {items.length === 0 && <p className="text-xs text-muted-foreground">{t("detail.noIntraday")}</p>}
      <ol className="flex flex-col">
        {items.map((it) =>
          it === "price" ? (
            <li key="price" className="my-0.5 flex items-center justify-between rounded-md bg-primary/12 px-2 py-1 text-sm font-semibold tabular-nums text-accent-soft">
              <span>{t("detail.price")}</span><span>{fmtPrice(row.price)}</span>
            </li>
          ) : (
            <li key={it.key} className="flex items-center justify-between gap-2 px-2 py-1 text-sm tabular-nums">
              <span className={cn("min-w-0 truncate", it.key === "vwap" ? "text-primary" : "text-foreground")}>{it.label}</span>
              <span className="flex items-baseline gap-2">
                <span>{fmtPrice(it.price)}</span>
                <span className="w-14 text-right text-xs text-muted-foreground">{fmtPct(it.distPct, 2)}</span>
                <span className="w-10 text-right text-xs text-muted-foreground">{it.distAtr != null ? it.distAtr.toFixed(1) : "—"}</span>
              </span>
            </li>
          ),
        )}
      </ol>
    </section>
  );
}

export function DetailSheet({
  row, name, session, phase, quote, stats, merged, mine, earnings, open, onOpenChange, onStep, onAddCatalyst, onEditCatalyst,
}: {
  row: Big7Row | null;
  name?: string;
  session: string;
  phase: Phase;
  quote?: StockQuote;
  stats?: GapStats;
  merged: MergedCatalyst[];
  mine?: MyTicker;
  earnings: { days: number; when: string | null } | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onStep: (dir: 1 | -1) => void;
  onAddCatalyst: (symbol: string) => void;
  onEditCatalyst: (c: MergedCatalyst) => void;
}) {
  const { t } = big7I18n.useT();
  const { canEdit } = useAuth();
  const wl = useWatchlistIndex(open);
  const quick = useQuickAddToWatchlist();
  const inList = row ? wl.get(row.symbol.toUpperCase()) : undefined;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-4 p-5 sm:max-w-[min(1180px,94vw)] [&>*]:shrink-0"
        onKeyDown={(e) => {
          const el = e.target as HTMLElement;
          if (el.closest("input,textarea,select,[contenteditable=true]")) return;
          if (e.key === "ArrowRight") { e.preventDefault(); onStep(1); }
          else if (e.key === "ArrowLeft") { e.preventDefault(); onStep(-1); }
        }}
      >
        {row && (
          <>
            <SheetHeader className="space-y-0 pr-8 text-left">
              <div className="flex flex-wrap items-center gap-3">
                <SheetTitle className="text-xl font-semibold tracking-tight">{row.symbol}</SheetTitle>
                <span className="text-xl font-semibold tabular-nums">{fmtPrice(row.price)}</span>
                <Pill tone={toneOf(row.chg)}>{fmtPct(row.chg)}</Pill>
                {earnings && <Pill tone="warn">{earningsLabel(earnings)}</Pill>}
                <div className="ml-auto flex items-center gap-1">
                  {inList ? (
                    <Button variant="ghost" size="sm" asChild title={t("detail.openInWatchlist")}>
                      <Link href={links.watchlist(row.symbol)}><Check /> {t("detail.inWatchlist", { list: LIST_LABELS[inList] })}</Link>
                    </Button>
                  ) : canEdit ? (
                    <Button variant="outline" size="sm" disabled={quick.busy === row.symbol.toUpperCase()} onClick={() => void quick.add(row.symbol, "today")} title={t("detail.addTodayTitle")}>
                      {quick.busy === row.symbol.toUpperCase() ? <Loader2 className="animate-spin" /> : <Flame />} {t("detail.addToday")}
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="icon-sm" aria-label={t("detail.prev")} title="←" onClick={() => onStep(-1)}><ChevronLeft /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t("detail.next")} title="→" onClick={() => onStep(1)}><ChevronRight /></Button>
                </div>
              </div>
              <SheetDescription className="text-xs">
                {name && name !== row.symbol ? `${name} · ` : ""}{t("detail.session", { session: fmtDate(session, "weekdayDayMonth") })}
              </SheetDescription>
            </SheetHeader>

            <div className="grid grid-cols-4 gap-2 lg:grid-cols-8">
              <Metric label={phase === "pre" ? t("detail.premarket") : t("detail.gap")}><Signed value={phase === "pre" ? row.pmChg : row.gap} /></Metric>
              <Metric label={t("detail.rsQqq")} title={t("detail.rsTitle")}><Signed value={row.rsQqq} suffix="" /></Metric>
              <Metric label={t("detail.rs30")} title={t("detail.rs30Title")}><Signed value={row.rs30} suffix="" /></Metric>
              <Metric label={t("detail.rs5")} title={t("detail.rs5Title")}><Signed value={row.rs5} digits={1} /></Metric>
              <Metric label={<TermTooltip term="rvol" />}>{fmtRvol(row.rvol)}</Metric>
              <Metric label={<><TermTooltip term="atr" /> · {t("detail.atrUsed")}</>} title={t("detail.atrTitle")}>
                {row.atr != null ? fmtPrice(row.atr) : "—"}
                {row.atrUsed != null && <span className="ml-1 text-xs font-normal text-muted-foreground">{Math.round(row.atrUsed)}%</span>}
              </Metric>
              <Metric label={t("detail.fromVwap")}><Signed value={row.vwapDist} /></Metric>
              <Metric label={t("detail.corr")} title={t("detail.corrTitle")}>
                {row.corr != null ? `${row.corr.toFixed(2)} / ${row.beta?.toFixed(2) ?? "—"}` : "—"}
              </Metric>
            </div>

            <div className="grid min-h-[480px] grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
              <div className="min-w-0">
                <WsChart
                  key={`${row.symbol}-${session}`}
                  trade={{ id: 0, ticker: row.symbol, date: session }}
                  executions={[]}
                  initialTimeframe="5m"
                  contextDays={1}
                  height={480}
                />
              </div>
              <DayLadder row={row} />
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <LevelsLadder ticker={row.symbol} quote={quote} stats={stats} atr={row.atr} />
              <div className="flex min-w-0 flex-col gap-3">
                <MyTickerStats row={mine} />
                <CatalystTimeline ticker={row.symbol} merged={merged} onAdd={() => onAddCatalyst(row.symbol)} onEdit={onEditCatalyst} />
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
