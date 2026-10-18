import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, ChevronDown, ExternalLink, ListOrdered, ShieldAlert } from "lucide-react";
import { EmptyState, FilterChip, Panel, Pill, SortableTh, TableScroll, toneOf, toneText, useTableSort } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AddToPlaybookButton } from "@/components/add-to-playbook";
import { cn } from "@/lib/utils";
import { HORIZON_LABEL, feesOf, grossPnl, netPnl, signedR, splitTags, tradeOutcome, tradeRiskPct, type Trade } from "./utils";
import { fmtCount, fmtDate, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { journalI18n } from "@/i18n/ns/journal";
import { tradesI18n } from "@/i18n/ns/trades";
import { personName } from "@/i18n";
import { RESULT_LABEL, sessionLabel } from "@/components/shared/trade-labels";
import { tagLabel } from "@/components/shared/trade-labels";

export type RuleViolation = {
  id: number;
  trader: string | null;
  ruleId: number | null;
  tradeId: number | null;
  severity: string | null;
  message: string | null;
  ruleName: string | null;
  ticker: string | null;
  tradeDate: string | null;
};

const PREVIEW = 15;


const OUTCOME_BAR: Record<ReturnType<typeof tradeOutcome>, string> = {
  win: "bg-up",
  loss: "bg-down",
  be: "bg-muted-foreground/60",
  open: "bg-primary",
};

/** Outcome label in the current language (shared result labels of the trades area). */
const outcomeLabel = (o: ReturnType<typeof tradeOutcome>) => RESULT_LABEL[o === "be" ? "breakeven" : o];

export function DayTrades({
  trades,
  carried = [],
  opened = [],
  day,
  isLoading,
  violations,
  showTrader,
  emptyAction,
}: {
  /** Trades whose result is realised on this day (closed on it, or still open and entered on it). */
  trades: Trade[];
  /** Overnight/swing positions opened earlier and still held on this day. */
  carried?: Trade[];
  /** Entered on this day but closed on a later one — shown so the entry day is not «empty». */
  opened?: Trade[];
  day: string;
  isLoading: boolean;
  violations: RuleViolation[];
  showTrader: boolean;
  emptyAction?: ReactNode;
}) {
  const { t: tj } = journalI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [ticker, setTicker] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const ordered = useMemo(
    () => [...trades].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id)),
    [trades],
  );

  const tickers = useMemo(() => {
    const m = new Map<string, TickerAgg>();
    const add = (cur: number | null, v: number | null) => (v == null ? cur : (cur ?? 0) + v);
    for (const t of ordered) {
      const g = m.get(t.ticker) ?? { count: 0, r: null, qty: null, gross: null, fees: null, net: null };
      g.count++;
      g.r = add(g.r, signedR(t));
      g.qty = add(g.qty, typeof t.qty === "number" ? t.qty : null);
      g.gross = add(g.gross, grossPnl(t));
      g.fees = add(g.fees, grossPnl(t) != null ? feesOf(t) : null);
      g.net = add(g.net, netPnl(t));
      m.set(t.ticker, g);
    }
    return Array.from(m.entries());
  }, [ordered]);

  const activeTicker = ticker && tickers.some(([k]) => k === ticker) ? ticker : null;
  const filtered = activeTicker ? ordered.filter((t) => t.ticker === activeTicker) : ordered;
  const [showAll, setShowAll] = useState(false);
  const visible = showAll || filtered.length <= PREVIEW + 3 ? filtered : filtered.slice(0, PREVIEW);

  const violationsByTrade = useMemo(() => {
    const m = new Map<number, RuleViolation[]>();
    for (const v of violations) {
      if (v.tradeId == null) continue;
      const arr = m.get(v.tradeId) ?? [];
      arr.push(v);
      m.set(v.tradeId, arr);
    }
    return m;
  }, [violations]);

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOpen = visible.length > 0 && visible.every((t) => open.has(t.id));

  return (
    <Panel
      title={tj("trades.title")}
      icon={ListOrdered}
      description={trades.length > 0 ? commonI18n.t("units.trades", { count: trades.length }) : undefined}
      actions={
        visible.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(allOpen ? new Set() : new Set(visible.map((t) => t.id)))}
          >
            {allOpen ? tj("trades.collapseAll") : tj("trades.expandAll")}
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : trades.length === 0 && carried.length === 0 && opened.length === 0 ? (
        <EmptyState
          icon={ListOrdered}
          title={tj("trades.emptyTitle")}
          description={tj("trades.emptyDesc")}
          action={emptyAction}
          className="py-8"
        />
      ) : (
        <div className="space-y-3">
          {trades.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {opened.length > 0 ? tj("trades.onlyOpened") : tj("trades.onlyCarried")}
            </p>
          )}
          {tickers.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={tj("trades.tickerFilter")}>
              <FilterChip active={!activeTicker} onClick={() => setTicker(null)} count={ordered.length}>
                {tc("states.all")}
              </FilterChip>
              {tickers.map(([k, g]) => (
                <FilterChip key={k} active={activeTicker === k} onClick={() => setTicker(activeTicker === k ? null : k)}>
                  <span className="font-semibold">{k}</span>
                  <span className={cn("tabular-nums", toneText(toneOf(g.net ?? g.r)))}>{g.net != null ? fmtUsd(g.net, { signed: true, decimals: "auto" }) : g.r != null ? fmtR(g.r, 1) : g.count}</span>
                </FilterChip>
              ))}
            </div>
          )}

          <ol className="relative space-y-2">
            {visible.map((t) => (
              <TradeItem
                key={t.id}
                trade={t}
                index={ordered.indexOf(t) + 1}
                isOpen={open.has(t.id)}
                onToggle={() => toggle(t.id)}
                violations={violationsByTrade.get(t.id) ?? []}
                showTrader={showTrader}
              />
            ))}
          </ol>

          {filtered.length > visible.length && (
            <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
              {tc("actions.showAllCount", { count: filtered.length })}
            </Button>
          )}

          {tickers.length > 0 && <TickerTable rows={tickers} />}

          {opened.length > 0 && (
            <div className="space-y-2 border-t border-[var(--glass-border)] pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="micro-label">{tj("trades.openedHere")}</span>
                <span className="text-2xs text-muted-foreground">{tj("trades.openedHereHint")}</span>
              </div>
              <ol className="space-y-2">
                {opened.map((t) => (
                  <TradeItem
                    key={t.id}
                    trade={t}
                    index={0}
                    openedHere={t.exitDate ?? null}
                    isOpen={open.has(t.id)}
                    onToggle={() => toggle(t.id)}
                    violations={violationsByTrade.get(t.id) ?? []}
                    showTrader={showTrader}
                  />
                ))}
              </ol>
            </div>
          )}

          {carried.length > 0 && (
            <div className="space-y-2 border-t border-[var(--glass-border)] pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="micro-label">{tj("trades.carried")}</span>
                <span className="text-2xs text-muted-foreground">{tj("trades.carriedHint")}</span>
              </div>
              <ol className="space-y-2">
                {carried.map((t) => (
                  <TradeItem
                    key={t.id}
                    trade={t}
                    index={0}
                    carriedFrom={t.date}
                    closesToday={t.exitDate === day}
                    isOpen={open.has(t.id)}
                    onToggle={() => toggle(t.id)}
                    violations={violationsByTrade.get(t.id) ?? []}
                    showTrader={showTrader}
                  />
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function TradeItem({
  trade: t,
  index,
  carriedFrom,
  closesToday,
  openedHere,
  isOpen,
  onToggle,
  violations,
  showTrader,
}: {
  trade: Trade;
  index: number;
  carriedFrom?: string;
  closesToday?: boolean;
  /** Entered on the shown day; closes on this later date (null = still open). */
  openedHere?: string | null;
  isOpen: boolean;
  onToggle: () => void;
  violations: RuleViolation[];
  showTrader: boolean;
}) {
  const reduce = useReducedMotion();
  const { t: tj } = journalI18n.useT();
  const { t: tc } = commonI18n.useT();
  const { t: tt } = tradesI18n.useT();
  const r = signedR(t);
  const net = netPnl(t);
  const gross = grossPnl(t);
  const fees = gross != null ? feesOf(t) : null;
  const outcome = tradeOutcome(t);
  const riskPct = tradeRiskPct(t);
  const tags = splitTags(t.tags);
  const isShort = (t.side ?? "").toLowerCase() === "short";
  const hasText = !!(t.notes || t.whatWorked || t.whatFailed || t.conclusion);
  const detailsId = `journal-trade-${t.id}`;

  return (
    <li className="relative overflow-hidden rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)]">
      <span className={cn("absolute inset-y-0 left-0 w-[3px]", OUTCOME_BAR[outcome])} aria-hidden="true" />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={detailsId}
        className="flex w-full items-center gap-3 py-2.5 pl-4 pr-3 text-left transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="w-5 shrink-0 text-center text-2xs tabular-nums text-muted-foreground">{index > 0 ? index : "↪"}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{t.ticker}</span>
            {t.side && <Pill>{isShort ? "↘ Short" : "↗ Long"}</Pill>}
            {t.setup && <span className="truncate text-xs text-muted-foreground">{t.setup}</span>}
            {t.horizon && t.horizon !== "intraday" && <Pill tone="purple">{HORIZON_LABEL[t.horizon] ?? t.horizon}</Pill>}
            {carriedFrom && <Pill>{tj("trades.since", { date: fmtDate(carriedFrom, "dayMonth") })}</Pill>}
            {closesToday && <Pill tone="accent">{tj("trades.closesToday")}</Pill>}
            {openedHere !== undefined && (
              <Pill tone="purple">{openedHere ? tj("trades.openedClosedOn", { date: fmtDate(openedHere, "dayMonth") }) : tj("trades.openedStillHeld")}</Pill>
            )}
            {violations.length > 0 && (
              <Pill tone="warn"><ShieldAlert className="h-3 w-3" aria-hidden="true" />{violations.length}</Pill>
            )}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground tabular-nums">
            {showTrader && t.trader && <span className="text-foreground/80">{personName(t.trader)}</span>}
            {t.session && <span>{sessionLabel(t.session, { full: true })}</span>}
            <span>
              {t.entry ?? "—"} → {t.exit ?? "…"}
            </span>
            {t.stop != null && <span>{tj("trades.stopShort", { price: t.stop })}</span>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          {net != null ? (
            <span className={cn("text-sm font-semibold tabular-nums", toneText(toneOf(net)))}>{fmtUsd(net, { signed: true, decimals: "auto" })}</span>
          ) : (
            <span className={cn("text-sm font-semibold tabular-nums", toneText(toneOf(r)))}>{r != null ? fmtR(r) : outcomeLabel(outcome)}</span>
          )}
          {net != null && r != null && (
            <span className={cn("text-xs tabular-nums", toneText(toneOf(r)))}>{fmtR(r)}</span>
          )}
        </span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[var(--dur-2)] motion-reduce:transition-none", isOpen && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={detailsId}
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-3 border-t border-[var(--glass-border)] py-3 pl-4 pr-3 sm:pl-12">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                <Fact label={tc("trading.entry")} value={t.entry} />
                <Fact label={tc("trading.exit")} value={t.exit} />
                <Fact label={tc("trading.stop")} value={t.stop} />
                <Fact label={tj("trades.riskPerShare")} value={riskPct != null ? fmtRate(riskPct) : null} />
                <Fact label={tc("trading.holdTime")} value={t.holdTime} />
                <Fact label={tj("trades.slippage")} value={t.slippage != null ? `${t.slippage}¢` : null} />
                <Fact label="RVOL" value={t.relativeVolume != null ? `${t.relativeVolume}×` : null} />
                <Fact label={tc("trading.result")} value={outcomeLabel(outcome)} />
                <Fact label={tj("trades.qty")} value={t.qty != null ? fmtCount(t.qty) : null} />
                <Fact label={tj("trades.grossPnl")} value={gross != null ? fmtUsd(gross, { signed: true, decimals: "auto" }) : null} />
                <Fact label={tc("trading.fees")} value={fees != null ? fmtUsd(-fees, { signed: true, decimals: "auto" }) : null} />
                <Fact label={tc("trading.netPnl")} value={net != null ? fmtUsd(net, { signed: true, decimals: "auto" }) : null} />
                <Fact label={tj("trades.riskUsd")} value={t.riskUsd != null ? fmtUsd(Math.abs(t.riskUsd), { decimals: "auto" }) : null} />
                <Fact label={tc("trading.horizon")} value={t.horizon ? HORIZON_LABEL[t.horizon] ?? t.horizon : null} />
                <Fact label={tj("trades.exitDate")} value={t.exitDate ? fmtDate(t.exitDate, "dayMonth") : null} />
              </dl>

              {hasText && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {t.notes && <TextBlock label={tc("fields.notes")} text={t.notes} className="sm:col-span-2" />}
                  {t.whatWorked && <TextBlock label={tt("reviewFields.whatWorked")} text={t.whatWorked} tone="up" />}
                  {t.whatFailed && <TextBlock label={tt("reviewFields.whatFailed")} text={t.whatFailed} tone="down" />}
                  {t.conclusion && <TextBlock label={tj("trades.conclusion")} text={t.conclusion} className="sm:col-span-2" />}
                </div>
              )}

              {violations.length > 0 && (
                <ul className="space-y-1">
                  {violations.map((v) => (
                    <li key={v.id} className="flex items-start gap-2 text-xs">
                      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
                      <span>
                        <span className="font-medium">{v.ruleName ?? tj("trades.rule")}</span>
                        {v.message && <span className="text-muted-foreground"> — {v.message}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                {tags.map((tg) => (
                  <Pill key={tg}>{tagLabel(tg)}</Pill>
                ))}
                <span className="ml-auto flex flex-wrap gap-1.5">
                  {t.screenshotUrl && /^https?:\/\//i.test(t.screenshotUrl) && (
                    <Button asChild variant="ghost" size="sm">
                      <a href={t.screenshotUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink aria-hidden="true" />{tj("trades.chart")}
                      </a>
                    </Button>
                  )}
                  <AddToPlaybookButton payload={{ name: `${t.ticker} ${String(t.date ?? "").slice(0, 10)}`, ticker: t.ticker, sourceType: "trade", sourceId: t.id }} />
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/trades?highlight=${t.id}`}>
                      <ArrowUpRight aria-hidden="true" />{tj("trades.openTrade")}
                    </Link>
                  </Button>
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

type TickerAgg = { count: number; r: number | null; qty: number | null; gross: number | null; fees: number | null; net: number | null };

const TICKER_ACCESSORS = {
  ticker: ([k]: [string, TickerAgg]) => k,
  count: ([, g]: [string, TickerAgg]) => g.count,
  qty: ([, g]: [string, TickerAgg]) => g.qty,
  gross: ([, g]: [string, TickerAgg]) => g.gross,
  fees: ([, g]: [string, TickerAgg]) => g.fees,
  net: ([, g]: [string, TickerAgg]) => g.net,
  r: ([, g]: [string, TickerAgg]) => g.r,
} as const;

const TH = "px-2 py-1.5 font-medium";

/** Per-ticker summary — only real, computed columns. Headers sort; «Итого» stays in the footer. */
function TickerTable({ rows }: { rows: Array<[string, TickerAgg]> }) {
  const { rows: sorted, thProps } = useTableSort(rows, TICKER_ACCESSORS, "net");
  const { t: tj } = journalI18n.useT();
  const { t: tc } = commonI18n.useT();
  const sum = (k: keyof TickerAgg) =>
    rows.reduce<number | null>((acc, [, g]) => (g[k] == null ? acc : (acc ?? 0) + (g[k] as number)), null);
  const total: TickerAgg = { count: sum("count") ?? 0, r: sum("r"), qty: sum("qty"), gross: sum("gross"), fees: sum("fees"), net: sum("net") };
  const money = (v: number | null) => (v == null ? "—" : fmtUsd(v, { signed: true, decimals: "auto" }));
  const showQty = total.qty != null;
  const showMoney = total.gross != null || total.fees != null;
  const showR = total.r != null;
  // Without size/money data the table would only repeat the ticker chips — skip it.
  if (!showQty && !showMoney) return null;
  const cells = (g: TickerAgg) => [
    <td key="n" className="px-2 py-1.5 text-right">{g.count}</td>,
    showQty && <td key="q" className="px-2 py-1.5 text-right">{g.qty != null ? fmtCount(g.qty) : "—"}</td>,
    showMoney && <td key="g" className={cn("px-2 py-1.5 text-right", toneText(toneOf(g.gross)))}>{money(g.gross)}</td>,
    showMoney && <td key="f" className="px-2 py-1.5 text-right text-muted-foreground">{g.fees != null ? fmtUsd(-g.fees, { signed: true, decimals: "auto" }) : "—"}</td>,
    showMoney && <td key="t" className={cn("px-2 py-1.5 text-right font-medium", toneText(toneOf(g.net)))}>{money(g.net)}</td>,
    showR && <td key="r" className={cn("px-2 py-1.5 text-right font-medium", toneText(toneOf(g.r)))}>{fmtR(g.r)}</td>,
  ];
  return (
    <TableScroll>
      <table className={cn("w-full text-xs tabular-nums", showMoney && "min-w-[480px]")}>
        <caption className="sr-only">{tj("trades.tickerTotals")}</caption>
        <thead>
          <tr className="border-b border-[var(--glass-border)] text-muted-foreground">
            <SortableTh {...thProps("ticker")} className={cn(TH, "text-left")}>{tc("trading.ticker")}</SortableTh>
            <SortableTh {...thProps("count")} align="right" className={TH}>{tc("trading.trades")}</SortableTh>
            {showQty && <SortableTh {...thProps("qty")} align="right" className={TH}>{tj("trades.qty")}</SortableTh>}
            {showMoney && <SortableTh {...thProps("gross")} align="right" className={TH}>{tc("trading.gross")}</SortableTh>}
            {showMoney && <SortableTh {...thProps("fees")} align="right" className={TH}>{tc("trading.fees")}</SortableTh>}
            {showMoney && <SortableTh {...thProps("net")} align="right" className={TH}>{tc("trading.net")}</SortableTh>}
            {showR && <SortableTh {...thProps("r")} align="right" className={TH}>R</SortableTh>}
          </tr>
        </thead>
        <tbody>
          {sorted.map(([k, g]) => (
            <tr key={k} className="border-b border-[var(--glass-border)]">
              <th scope="row" className="px-2 py-1.5 text-left font-semibold">{k}</th>
              {cells(g)}
            </tr>
          ))}
        </tbody>
        {rows.length > 1 && (
          <tfoot>
            <tr className="font-semibold">
              <th scope="row" className="px-2 py-1.5 text-left">{tc("fields.total")}</th>
              {cells(total)}
            </tr>
          </tfoot>
        )}
      </table>
    </TableScroll>
  );
}

function Fact({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tabular-nums">{value == null || value === "" ? "—" : value}</dd>
    </div>
  );
}

function TextBlock({ label, text, tone, className }: { label: string; text: string; tone?: "up" | "down"; className?: string }) {
  return (
    <div className={cn("rounded-xl bg-[var(--glass-bg)] p-3", className)}>
      <div className={cn("micro-label mb-1", tone === "up" && "text-up", tone === "down" && "text-down")}>{label}</div>
      <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">{text}</p>
    </div>
  );
}
