// «Катализаторы» → day brief: what matters for one trading day before the open — macro with time, short
// day / closure, the trader's tickers that report around it (with their usual reaction and the trader's
// own record), the trader's day notes; for a past day — the day's result.
import * as React from "react";
import { Link } from "wouter";
import type { MarketEvent } from "@workspace/api-client-react";
import { AlertTriangle, ArrowRight, BookOpen, CalendarClock, Landmark, Megaphone, StickyNote } from "lucide-react";
import { EmptyState, Panel, Pill, toneOf, toneText, type Tone } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { addDays } from "@/lib/trading-date";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { CallTypePill } from "@/components/research/earnings-history";
import { useEarningsHistory } from "@/components/shared/market/earnings-api";
import {
  catLabel, categoryOf, earningsEdge, isClosedRow, isShortDayRow, nextTradingDay,
  type CatalystEdge, type CategoryEdge, type MacroRow, type Verdict,
} from "./catalyst-math";
import { fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import type { CatalystData, MyEarnings } from "./use-catalysts";
import { fmtDay, weekdayLabel, macroTime } from "./event-meta";
import { MarketReporters } from "./catalyst-market";
import { eventsI18n } from "@/i18n/ns/events";
import { rich } from "./rich-text";

/* ───────────── small pieces ───────────── */

export function verdictTone(row: Pick<CategoryEdge, "verdict" | "delta">): Tone {
  if (row.verdict !== "robust" && row.verdict !== "maybe") return "neutral";
  return toneOf(row.delta);
}

export const verdictLabel = (v: Verdict) => eventsI18n.t(`verdict.${v}`);

/** «Вы в такие дни: −$55/день · 6 дн.» next to a macro line. */
export function MyDayChip({ row, base }: { row: CategoryEdge | undefined; base: CatalystEdge["baseline"] }) {
  const { t } = eventsI18n.useT();
  if (!row) return null;
  if (row.agg.days === 0) return <span className="text-xs text-muted-foreground">{t("today.noTradesSuchDays")}</span>;
  const tone = verdictTone(row);
  const verdict = verdictLabel(row.verdict);
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
      title={t("today.myDayTitle", { base: fmtUsd(base.avgNetDay, { signed: true }), days: commonI18n.t("units.days", { count: row.agg.days }) })}
    >
      {t("today.youOnSuchDays")}
      <span className={cn("font-medium tabular-nums", toneText(toneOf(row.agg.avgNetDay)))}>{t("today.perDay", { amount: fmtUsd(row.agg.avgNetDay, { signed: true }) })}</span>
      <span className="tabular-nums">· {commonI18n.t("units.days", { count: row.agg.days })}</span>
      <Pill tone={tone} className="ml-0.5">{row.delta != null && row.verdict !== "low" ? (row.delta < 0 ? t("today.worseThanUsual", { verdict }) : t("today.betterThanUsual", { verdict })) : verdict}</Pill>
    </span>
  );
}

function sortByTime(rows: MacroRow[]) {
  const mins = (r: MacroRow) => {
    const t = macroTime(r.description);
    if (!t) return 24 * 60;
    const [h, m] = t.replace(" ET", "").split(":").map(Number);
    return h * 60 + m;
  };
  return [...rows].sort((a, b) => mins(a) - mins(b));
}

function MacroLine({ r, edge }: { r: MacroRow; edge: CatalystEdge }) {
  const { t } = eventsI18n.useT();
  const cat = categoryOf(r);
  const row = cat ? edge.rows.find((x) => x.key === cat) : undefined;
  const time = macroTime(r.description);
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="w-16 shrink-0 pt-0.5 text-sm font-medium tabular-nums text-foreground">{time ?? t("today.allDay")}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{r.name}</span>
          {r.importance === "high" && <Pill tone="neutral">{t("today.important")}</Pill>}
        </div>
        {r.description && !/^FOMC begins$/i.test(r.description) && <p className="mt-0.5 text-xs text-muted-foreground">{r.description}</p>}
        {row && <div className="mt-1"><MyDayChip row={row} base={edge.baseline} /></div>}
      </div>
    </li>
  );
}

const avgRange = (qs: { rangePct: number | null }[]) => {
  const xs = qs.map((q) => q.rangePct).filter((v): v is number => v != null);
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
};

/** One reporting ticker: timing, EPS estimate, its usual reaction and the trader's own record. */
export function ReporterRow({ e, data, onOpen }: { e: MyEarnings; data: CatalystData; onOpen: (e: MyEarnings) => void }) {
  const { t: tr } = eventsI18n.useT();
  const t = e.ticker.toUpperCase();
  const h = useEarningsHistory(t);
  const mine = data.tickerStats.get(t);
  const reaction = React.useMemo(() => (h.data ? earningsEdge(data.tradeRows, { ticker: t, quarters: h.data.quarters }) : null), [h.data, data.tradeRows, t]);
  const range = h.data ? avgRange(h.data.quarters) : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(e)}
        className="flex w-full flex-col gap-1.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-[var(--dur-1)] hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{t}</span>
          <CallTypePill type={e.callType} long />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{e.company}</span>
          {e.epsEstimate != null && <span className="text-xs tabular-nums text-muted-foreground">{tr("today.epsEstimate", { value: fmtUsd(e.epsEstimate) })}</span>}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {h.isLoading ? (
            <Skeleton className="h-3.5 w-48" />
          ) : h.data && h.data.quarters.length ? (
            <span className="tabular-nums">
              {tr("today.usually", { gap: h.data.avgAbsGap?.toFixed(1) ?? "—" })}{range != null && tr("today.range", { range: range.toFixed(1) })}
              {h.data.streak.kind && h.data.streak.count > 1 && tr("today.streak", { count: h.data.streak.count, kind: h.data.streak.kind === "beat" ? "beat" : "miss" })}
            </span>
          ) : (
            <span>{tr("today.noHistory")}</span>
          )}
          <span className="tabular-nums">
            {mine ? (
              rich(tr("today.youTraded", { count: mine.n, net: "{net}" }), { net: <span className={toneText(toneOf(mine.net))}>{fmtUsd(mine.net, { signed: true })}</span> })
            ) : e.mine === "watch" ? tr("today.watchNoTrades") : tr("today.noTrades")}
            {reaction && reaction.event.trades > 0 && (
              rich(tr("today.onReportDays", { count: reaction.event.trades, net: "{net}" }), { net: <span className={toneText(toneOf(reaction.event.net))}>{fmtUsd(reaction.event.net, { signed: true })}</span> })
            )}
          </span>
          {e.mine !== "traded" && <Pill tone="neutral">{tr("today.watchlist")}</Pill>}
        </span>
      </button>
    </li>
  );
}

/* ───────────── day brief ───────────── */

export function DayBrief({
  day,
  data,
  onOpenTicker,
  onOpenNote,
  addNote,
  showTeaser = true,
  onPickDay,
}: {
  day: string;
  data: CatalystData;
  onOpenTicker: (e: MyEarnings) => void;
  onOpenNote: (e: MarketEvent) => void;
  addNote: (date: string) => React.ReactNode;
  showTeaser?: boolean;
  onPickDay?: (d: string) => void;
}) {
  const { t } = eventsI18n.useT();
  const { edge, rows, closed, book, today, reportersFor } = data;
  const dayRows = rows.filter((r) => r.date.slice(0, 10) === day);
  const closedRow = dayRows.find(isClosedRow);
  const shortRow = dayRows.find(isShortDayRow);
  const macro = sortByTime(dayRows.filter((r) => r.type.toLowerCase() !== "holiday"));
  const rep = reportersFor(day);
  const beforeOpen = [...rep.before, ...rep.same];
  const notes = data.notes.get(day) ?? [];
  const past = day < today;
  const result = book.get(day);
  const shortEdge = edge.rows.find((r) => r.key === "short_day");
  const earningsLoading = data.upcoming.isLoading || data.watchlist.isLoading || data.trades.isLoading;
  const earningsHorizon = data.upcoming.data?.days.at(-1)?.date ?? null;
  const beyondHorizon = !past && earningsHorizon != null && day > earningsHorizon;

  const title = `${weekdayLabel(day, "long")}, ${fmtDay(day, "dayMonthLong")}`;
  const whenLabel = day === today ? t("today.when.today") : day === nextTradingDay(today, closed) && day > today ? t("today.when.next") : past ? t("today.when.past") : null;

  return (
    <div className="grid items-start gap-[var(--grid-gap)] lg:grid-cols-12">
      <Panel
        className="lg:col-span-7"
        icon={CalendarClock}
        title={title}
        actions={whenLabel ? <Pill tone={day === today ? "accent" : "neutral"}>{whenLabel}</Pill> : undefined}
        description={past ? t("today.pastDescription") : t("today.futureDescription")}
      >
        {closedRow ? (
          <EmptyState compact icon={Landmark} title={t("today.closedTitle", { name: closedRow.name })} description={t("today.closedText")} />
        ) : (
          <div className="flex flex-col gap-4">
            {shortRow && (
              <div className="flex items-start gap-2 rounded-xl bg-warn/10 px-3 py-2.5 text-sm text-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
                <div>
                  <p className="font-medium">{t("today.shortDay", { name: shortRow.name })}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("today.shortDayText")}{" "}
                    {shortEdge && shortEdge.agg.days > 0 ? t("today.shortDayMine", { amount: fmtUsd(shortEdge.agg.avgNetDay, { signed: true }) }) : t("today.shortDayNone")}
                  </p>
                </div>
              </div>
            )}

            <section aria-label={t("today.macro")}>
              <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Landmark className="h-3.5 w-3.5" aria-hidden="true" /> {t("today.macro")}
              </h3>
              {data.holidays.isLoading ? (
                <Skeleton className="h-12 w-full rounded-xl" />
              ) : macro.length ? (
                <ul className="divide-y divide-[var(--glass-border)]">
                  {macro.map((r) => <MacroLine key={`${r.date}-${r.type}-${r.name}`} r={r} edge={edge} />)}
                </ul>
              ) : (
                <p className="py-2 text-sm text-muted-foreground">{t("today.noMacro")}</p>
              )}
            </section>

            {!past && (
              <section aria-label={t("today.myReports")}>
                <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Megaphone className="h-3.5 w-3.5" aria-hidden="true" /> {t("today.myReports")}
                </h3>
                {earningsLoading ? (
                  <Skeleton className="h-14 w-full rounded-xl" />
                ) : beyondHorizon ? (
                  <p className="py-2 text-sm text-muted-foreground">{t("today.beyondHorizon")}</p>
                ) : beforeOpen.length || rep.after.length ? (
                  <div className="flex flex-col gap-2">
                    {beforeOpen.length > 0 && (
                      <div>
                        <p className="px-3 text-xs text-muted-foreground">{rep.before.length ? t("today.affectOpenPrev", { date: fmtDay(rep.prev) }) : t("today.affectOpen")}</p>
                        <ul className="-mx-3">{beforeOpen.map((e) => <ReporterRow key={`${e.date}-${e.ticker}`} e={e} data={data} onOpen={onOpenTicker} />)}</ul>
                      </div>
                    )}
                    {rep.after.length > 0 && (
                      <div>
                        <p className="px-3 text-xs text-muted-foreground">{t("today.afterClose")}</p>
                        <ul className="-mx-3">{rep.after.map((e) => <ReporterRow key={`${e.date}-${e.ticker}`} e={e} data={data} onOpen={onOpenTicker} />)}</ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="py-2 text-sm text-muted-foreground">
                    {data.myTickers.length ? t("today.noReportsWatching", { count: data.myTickers.length }) : t("today.noReports")}
                  </p>
                )}
              </section>
            )}

            {!past && <MarketReporters day={day} prev={rep.prev} data={data} onOpenTicker={onOpenTicker} />}

            {past && (
              <section aria-label={t("today.yourDay")} className="rounded-xl bg-[var(--glass-bg)] px-3 py-2.5">
                {result ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <span className="text-muted-foreground">{t("today.yourDayLabel")}</span>
                    <span className={cn("font-semibold tabular-nums", toneText(toneOf(result.net)))}>{fmtUsd(result.net, { signed: true })}</span>
                    <span className="tabular-nums text-muted-foreground">{t("today.dayStats", { count: result.n, wins: result.wins, losses: result.losses })}</span>
                    <Link href={links.journalDay(day)} className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      <BookOpen className="h-3.5 w-3.5" aria-hidden="true" /> {t("today.journalDay")}
                    </Link>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("today.noTradesThatDay")}</p>
                )}
              </section>
            )}
          </div>
        )}
      </Panel>

      <div className="flex flex-col gap-[var(--grid-gap)] lg:col-span-5">
        <Panel
          icon={StickyNote}
          title={t("today.notesTitle")}
          description={t("today.notesDescription")}
          actions={addNote(day)}
        >
          {notes.length ? (
            <ul className="-mx-2 flex flex-col">
              {notes.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onOpenNote(n)}
                    className="flex w-full flex-col gap-0.5 rounded-xl px-2 py-2 text-left hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <span className="font-semibold text-foreground">{n.ticker}</span>
                      {n.percentMove != null && <span className={cn("text-xs tabular-nums", toneText(toneOf(n.percentMove)))}>{n.percentMove > 0 ? "+" : ""}{n.percentMove.toFixed(1)}%</span>}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{n.headline}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("today.notesEmpty")}</p>
          )}
        </Panel>

        {showTeaser && <HorizonPanel from={day} data={data} onPickDay={onPickDay} />}
      </div>
    </div>
  );
}

/** Upcoming catalyst days (macro categories + my tickers' reports) after `from`, with my record on such days. */
function HorizonPanel({ from, data, onPickDay }: { from: string; data: CatalystData; onPickDay?: (d: string) => void }) {
  const { t } = eventsI18n.useT();
  type Item = { date: string; key: string; label: string; kind: "macro" | "earn"; row?: CategoryEdge; sub?: string };
  const until = addDays(from, 35);
  const items: Item[] = [];
  const seenCat = new Set<string>();
  for (const [d, set] of [...data.cats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (d <= from || d > until) continue;
    for (const k of set) {
      if (seenCat.has(k)) continue; // only the next occurrence of each type
      seenCat.add(k);
      items.push({ date: d, key: `${d}-${k}`, label: catLabel(k), kind: "macro", row: data.edge.rows.find((r) => r.key === k) });
    }
  }
  for (const [d, list] of data.earningsByDate) {
    if (d <= from) continue;
    for (const e of list) items.push({ date: d, key: `${d}-${e.ticker}`, label: e.ticker, kind: "earn", sub: e.callType === "AMC" ? t("call.reportAmc") : e.callType === "BMO" ? t("call.reportBmo") : t("call.report") });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "macro" ? -1 : 1));
  const shown = items.slice(0, 8);
  return (
    <Panel title={t("today.horizonTitle")} description={t("today.horizonDescription")} icon={ArrowRight}>
      {shown.length ? (
        <ul className="-mx-2 flex flex-col">
          {shown.map((it) => (
            <li key={it.key}>
              <button
                type="button"
                onClick={() => onPickDay?.(it.date)}
                className="flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="w-24 shrink-0 whitespace-nowrap pt-0.5 text-sm tabular-nums text-muted-foreground">{weekdayLabel(it.date)}, {fmtDay(it.date)}</span>
                <span className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-foreground">{it.label}</span>
                  {it.sub && <span className="ml-2 text-xs text-muted-foreground">{it.sub}</span>}
                  {it.row && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {it.row.agg.days ? (
                        <>{rich(t("today.horizonMine", { net: "{net}", days: commonI18n.t("units.days", { count: it.row.agg.days }) }), {
                          net: <span className={cn("tabular-nums", toneText(toneOf(it.row.agg.avgNetDay)))}>{t("today.perDay", { amount: fmtUsd(it.row.agg.avgNetDay, { signed: true }) })}</span>,
                        })}{" "}
                          <Pill tone={verdictTone(it.row)} className="ml-1">{verdictLabel(it.row.verdict)}</Pill></>
                      ) : t("today.horizonNever")}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("today.horizonEmpty")}</p>
      )}
    </Panel>
  );
}

/** Inside the ticker history sheet: the trader's own trades in this ticker, on reaction days vs other days. */
export function MyTickerEarnings({ ticker, data }: { ticker: string; data: CatalystData }) {
  const { t: tr } = eventsI18n.useT();
  const t = ticker.toUpperCase();
  const h = useEarningsHistory(t);
  const mine = data.tickerStats.get(t);
  const e = React.useMemo(() => (h.data ? earningsEdge(data.tradeRows, { ticker: t, quarters: h.data.quarters }) : null), [h.data, data.tradeRows, t]);
  return (
    <section className="rounded-xl bg-[var(--glass-bg)] px-3 py-3" aria-label={tr("today.tickerTrading")}>
      <h3 className="text-sm font-semibold text-foreground">{tr("today.tickerTradingTitle", { ticker: t })}</h3>
      {data.trades.isLoading ? (
        <Skeleton className="mt-2 h-4 w-2/3" />
      ) : !mine ? (
        <p className="mt-1 text-sm text-muted-foreground">{tr("today.tickerNoTrades")}</p>
      ) : (
        <div className="mt-1.5 flex flex-col gap-1 text-sm">
          <p className="tabular-nums">
            {rich(tr("today.tickerTotal", { count: mine.n, net: "{net}" }), { net: <span className={toneText(toneOf(mine.net))}>{fmtUsd(mine.net, { signed: true })}</span> })}
            <span className="text-muted-foreground">{tr("today.tickerLast", { date: fmtDay(mine.last) })}</span>
          </p>
          {e && (
            e.event.trades ? (
              <p className="tabular-nums">
                {rich(tr("today.tickerReactionDays", { count: e.event.trades, days: commonI18n.t("units.days", { count: e.event.days }), net: "{net}" }), {
                  net: <span className={toneText(toneOf(e.event.net))}>{fmtUsd(e.event.net, { signed: true })}</span>,
                })}
                {e.event.winRate != null && <span className="text-muted-foreground"> · WR {e.event.winRate}%</span>}
                <span className="text-muted-foreground">{tr("today.tickerUsual", { amount: fmtUsd(e.other.avgNetTrade, { signed: true }) })}</span>
              </p>
            ) : (
              <p className="text-muted-foreground">{tr("today.tickerNoReactionTrades")}</p>
            )
          )}
          {e && e.event.days > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {e.reactions.filter((r) => data.book.get(r.date)?.tickers.has(t)).map((r) => {
                const s = data.book.get(r.date)!.tickers.get(t)!;
                return (
                  <Link key={r.date} href={links.journalDay(r.date)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--glass-hover-bg)] px-2 py-1 text-xs hover:underline">
                    <span className="tabular-nums text-muted-foreground">{fmtDay(r.date)}</span>
                    <span className={cn("font-medium tabular-nums", toneText(toneOf(s.net)))}>{fmtUsd(s.net, { signed: true })}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
