/**
 * «Отчёт по овернайт-книге» — what the desk carries through the close (key time 15:45 ET):
 * positions by trader marked to live quotes, catalysts inside the holding window, gap scenarios
 * (−1/−2/−3 ATR, custom %) against daily limits, and concentration (ticker / sector / side / shared names).
 */
import * as React from "react";
import { Link } from "wouter";
import { AlertTriangle, Briefcase, CalendarClock, Download, Layers, Moon, Printer, Sparkles, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { nyDate, addDays } from "@/lib/trading-date";
import { EmptyState, Panel, Pill, Segmented, StatCard, StatGrid, TableScroll, toneOf, useTableSort } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Catalyst, EarningsHit, OfferingHit, OvernightBook, OvernightTrader, RiskPosition } from "./use-risk";
import { isNotFound } from "@/lib/api/errors";
import { useEarningsMap, useOfferingsMap, useOvernightBook, useQuotes } from "./use-risk";
import { HORIZON_LABEL, HORIZON_TONE, LimitBar, SortableTableHead, StopPill, usageText, useStoredState } from "./primitives";
import {
  DEFAULT_SHOCKS, NO_SECTOR, concentration, customPctShock, markPosition, runShock, toCsv,
  type BookPosition, type Marked, type ShockMode, type ShockResult, type TraderRoom,
} from "./risk-math";
import { fmtDate, fmtPct, fmtUsd } from "@/lib/format";
import { riskI18n } from "@/i18n/ns/risk";
import { comparePersonNames, personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";
import { rich, slots } from "@/i18n/rich";
import { positionsCount, sideLabel } from "./labels";

type Mode = "book" | "all";
const MODES: readonly Mode[] = ["book", "all"];
const SHOCK_MODES: readonly ShockMode[] = ["market", "adverse"];

type CatalystChip = { kind: "earnings" | "offering" | "catalyst"; label: string; date: string; urgent: boolean; title: string };

function catalystsFor(ticker: string, today: string, book: OvernightBook | undefined, earnings: Record<string, EarningsHit> | undefined, offerings: Record<string, OfferingHit> | undefined): CatalystChip[] {
  const out: CatalystChip[] = [];
  const t = ticker.toUpperCase();
  const soon = addDays(today, 3);
  const dd = (d: string) => fmtDate(d.slice(0, 10), "dayMonthNumeric");
  const tr = riskI18n.t;
  const e = earnings?.[t];
  if (e) {
    const title = e.company
      ? tr("overnight.earningsTitleCompany", { date: dd(e.date), call: e.callType, company: e.company })
      : tr("overnight.earningsTitle", { date: dd(e.date), call: e.callType });
    out.push({ kind: "earnings", label: tr("overnight.earnings", { date: dd(e.date), call: e.callType }), date: e.date, urgent: e.date <= soon, title });
  }
  const o = offerings?.[t];
  if (o) {
    const details = [o.type, o.dealSizeM != null ? fmtUsd(o.dealSizeM * 1e6, { decimals: 0, compact: true }) : null, o.dilutionPct != null ? tr("overnight.dilution", { pct: o.dilutionPct }) : null, o.status]
      .filter(Boolean)
      .join(" · ");
    out.push({ kind: "offering", label: `${o.type} ${dd(o.date)}`, date: o.date, urgent: true, title: tr("overnight.offeringTitle", { details }) });
  }
  for (const c of (book?.catalysts?.[t] ?? []) as Catalyst[]) {
    out.push({ kind: "catalyst", label: `${c.type} ${dd(c.date)}`, date: c.date, urgent: c.date <= soon || c.impact === "high", title: `${c.type} ${c.date}${c.description ? ` — ${c.description}` : ""} (${c.impact})` });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function CatalystPills({ items }: { items: CatalystChip[] }) {
  if (!items.length) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((c, i) => (
        <span key={i} title={c.title} className="inline-flex">
          <Pill tone={c.urgent ? "down" : c.kind === "earnings" ? "warn" : "neutral"}>{c.label}</Pill>
        </span>
      ))}
    </div>
  );
}

function downloadCsv(name: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const PRINT_CSS = `@media print {
  body * { visibility: hidden !important; }
  #risk-overnight-print, #risk-overnight-print * { visibility: visible !important; }
  #risk-overnight-print { position: absolute; left: 0; top: 0; width: 100%; padding: 0; }
  #risk-overnight-print .no-print { display: none !important; }
  #risk-overnight-print .glass-panel { background: transparent !important; box-shadow: none !important; border: 1px solid hsl(var(--border)); break-inside: avoid; }
  #risk-overnight-print table { font-size: 11px; }
}`;

type Row = { p: RiskPosition; m: Marked; cats: CatalystChip[]; pctOfMax: number | null };

export function OvernightView({ trader, isCurator, onUpdatedAt }: { trader: string | null; isCurator: boolean; onUpdatedAt?: (ts: number) => void }) {
  const scope = isCurator ? null : trader;
  const [mode, setMode] = useStoredState<Mode>("risk.overnight.mode", "book", MODES);
  const [shockMode, setShockMode] = useStoredState<ShockMode>("risk.overnight.shockMode", "market", SHOCK_MODES);
  const [customPct, setCustomPct] = React.useState<string>(() => {
    try { return localStorage.getItem("risk.overnight.customPct") ?? "-5"; } catch { return "-5"; }
  });
  const book = useOvernightBook(scope, mode === "all");
  const data = book.data;
  const tickers = React.useMemo(() => (data?.positions ?? []).map((p) => p.ticker), [data]);
  const quotes = useQuotes(tickers);
  const earnings = useEarningsMap(tickers.length > 0);
  const offerings = useOfferingsMap(tickers.length > 0);
  const today = data?.date ?? nyDate();

  React.useEffect(() => {
    if (book.dataUpdatedAt) onUpdatedAt?.(book.dataUpdatedAt);
  }, [book.dataUpdatedAt, onUpdatedAt]);

  React.useEffect(() => {
    try { localStorage.setItem("risk.overnight.customPct", customPct); } catch { /* ignore */ }
  }, [customPct]);

  const q = quotes.data ?? {};
  const traderBy = React.useMemo(() => new Map((data?.traders ?? []).map((t) => [t.trader, t])), [data]);

  const rows: Row[] = React.useMemo(
    () =>
      (data?.positions ?? []).map((p) => {
        const m = markPosition(p, q[p.ticker.toUpperCase()]);
        const L = traderBy.get(p.trader)?.limits;
        return { p, m, cats: catalystsFor(p.ticker, today, data, earnings.data, offerings.data), pctOfMax: L?.maxOvernightExposure != null && m.marketValueUsd != null ? (L.maxOvernightExposure > 0 ? (m.marketValueUsd / L.maxOvernightExposure) * 100 : 100) : null };
      }),
    [data, q, traderBy, today, earnings.data, offerings.data],
  );
  const byTrader = React.useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) (m.get(r.p.trader) ?? m.set(r.p.trader, []).get(r.p.trader)!).push(r);
    for (const arr of m.values()) arr.sort((a, b) => (b.m.marketValueUsd ?? 0) - (a.m.marketValueUsd ?? 0));
    return [...m.entries()].sort((a, b) => comparePersonNames(a[0], b[0]));
  }, [rows]);

  const totals = React.useMemo(() => {
    const mv = rows.reduce((s, r) => s + (r.m.marketValueUsd ?? 0), 0);
    const unreal = rows.filter((r) => r.m.unrealizedUsd != null);
    return {
      mv,
      unrealized: unreal.length ? unreal.reduce((s, r) => s + (r.m.unrealizedUsd ?? 0), 0) : null,
      quoted: rows.filter((r) => r.m.last != null).length,
      riskToStop: rows.reduce((s, r) => s + (r.m.riskToStopUsd ?? 0), 0),
      catalysts: rows.filter((r) => r.cats.some((c) => c.urgent)).length,
    };
  }, [rows]);

  const bookPositions: BookPosition[] = React.useMemo(() => rows.map((r) => r.p), [rows]);
  const rooms: TraderRoom[] = React.useMemo(
    () => (data?.traders ?? []).map((t) => ({ trader: t.trader, limits: t.limits, dailyRemainingUsd: t.dailyRemainingUsd })),
    [data],
  );
  const custom = Number(customPct.replace(",", "."));
  const shocks = React.useMemo(() => [...DEFAULT_SHOCKS, ...(Number.isFinite(custom) && custom !== 0 ? [customPctShock(custom)] : [])], [custom]);
  const results: ShockResult[] = React.useMemo(() => shocks.map((s) => runShock(bookPositions, q, rooms, s, shockMode)), [shocks, bookPositions, q, rooms, shockMode]);
  const conc = React.useMemo(() => concentration(bookPositions, q), [bookPositions, q]);

  const { t } = riskI18n.useT();
  const cm = commonI18n.t;

  const exportCsv = () => {
    const h = (k: "date" | "trader" | "ticker" | "side" | "horizon" | "daysHeld" | "qty" | "avgPrice" | "lastPrice" | "unrealUsd" | "unrealPct" | "stop" | "riskToStop" | "marketValue" | "pctOfMax" | "atr" | "atrSource" | "sector" | "catalysts" | "source" | "tradeId") => t(`overnight.csv.${k}`);
    const head = [h("date"), h("trader"), h("ticker"), h("side"), h("horizon"), h("daysHeld"), h("qty"), h("avgPrice"), h("lastPrice"), h("unrealUsd"), h("unrealPct"), h("stop"), h("riskToStop"), h("marketValue"), h("pctOfMax"), h("atr"), h("atrSource"), h("sector"), h("catalysts"), h("source"), h("tradeId")];
    const body = rows.map(({ p, m, cats, pctOfMax }) => [
      today, personName(p.trader), p.ticker, p.side ? sideLabel(p.side) : "", HORIZON_LABEL[p.horizon], p.daysHeld, p.qty, p.entry, m.last, m.unrealizedUsd, m.unrealizedPct, p.stop, m.riskToStopUsd, m.marketValueUsd,
      pctOfMax == null ? "" : Math.round(pctOfMax), m.atr, m.atrSource ?? "", p.sector ?? "", cats.map((c) => c.label).join(", "), p.source, p.id,
    ]);
    const scen: (string | number | null | undefined)[][] = [
      [],
      [t("overnight.csv.scenarios"), shockMode === "market" ? t("overnight.csv.modeMarket") : t("overnight.csv.modeAdverse")],
      [h("trader"), ...results.map((r) => t("overnight.csv.shockPnl", { shock: r.shock.label })), ...results.map((r) => t("overnight.csv.shockLeft", { shock: r.shock.label }))],
    ];
    const traders = [...new Set(rows.map((r) => r.p.trader))].sort(comparePersonNames);
    for (const t of traders) {
      const cells = results.map((r) => r.traders.find((x) => x.trader === t)?.pnlUsd ?? "");
      const rem = results.map((r) => r.traders.find((x) => x.trader === t)?.remainingAfterUsd ?? "");
      scen.push([personName(t), ...cells, ...rem]);
    }
    scen.push([t("overnight.csv.desk"), ...results.map((r) => r.desk.pnlUsd), ...results.map(() => "")]);
    downloadCsv(`overnight-book-${today}.csv`, toCsv([head, ...body, ...scen]));
  };

  if (book.isError) {
    const notReady = isNotFound(book.error);
    return (
      <Panel>
        <EmptyState icon={Moon} title={notReady ? t("overnight.notReadyTitle") : t("overnight.loadFailed")} description={notReady ? t("overnight.notReadyDesc") : (book.error as Error).message} />
      </Panel>
    );
  }

  // Saturday / Sunday: no session, so no countdown to today's 15:45 cut-off.
  const weekend = data ? [0, 6].includes(new Date(`${data.date}T12:00:00Z`).getUTCDay()) : false;
  const keyPill = data
    ? weekend
      ? <Pill tone="neutral">{t("overnight.weekend")}</Pill>
      : data.afterKey
      ? <Pill tone="accent" dot>{t("overnight.afterKey")}</Pill>
      : data.minutesToKey != null
        ? (
          <Pill tone={data.minutesToKey <= 30 ? "warn" : "neutral"} dot>
            {t("overnight.toKey", {
              time: data.minutesToKey >= 60
                ? cm("time.hoursMinutesShort", { h: Math.floor(data.minutesToKey / 60), m: data.minutesToKey % 60 })
                : cm("time.minutesShort", { count: data.minutesToKey }),
            })}
          </Pill>
        )
        : <Pill tone="neutral">{t("overnight.key")}</Pill>
    : null;

  const empty = !book.isLoading && !!data && rows.length === 0;

  return (
    <div id="risk-overnight-print" className="flex flex-col gap-[var(--grid-gap)]">
      <style>{PRINT_CSS}</style>

      {/* Print-only header */}
      <div className="hidden print:block">
        <h1 className="text-xl font-semibold">{t("overnight.printTitle", { date: fmtDate(today, "medium") })}</h1>
        <p className="text-sm text-muted-foreground">
          {t("overnight.printMeta", {
            scope: isCurator ? cm("fields.wholeDesk") : trader ?? "",
            at: fmtDate(new Date(), "shortDateTime"),
            quotes: quotes.dataUpdatedAt ? fmtDate(quotes.dataUpdatedAt, "time") : "—",
          })}
        </p>
      </div>

      {!empty && <StatGrid>
        {book.isLoading || !data ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-2xl" />)
        ) : (
          <>
            <StatCard
              label={t("overnight.kpiExposure")}
              icon={Moon}
              value={fmtUsd(totals.mv, { decimals: 0, compact: 10_000 })}
              hint={[
                t("overnight.kpiExposureHint", { positions: positionsCount(rows.length), traders: cm("units.traders", { count: byTrader.length }) }),
                totals.quoted < rows.length ? t("overnight.noQuote", { count: rows.length - totals.quoted }) : null,
              ].filter(Boolean).join(" · ")}
            />
            <StatCard label={t("overnight.kpiUnreal")} value={totals.unrealized != null ? fmtUsd(totals.unrealized, { signed: true, decimals: 0 }) : "—"} tone={toneOf(totals.unrealized)} hint={totals.unrealized == null ? t("overnight.noQuotes") : t("overnight.byLast")} />
            <StatCard label={t("overnight.kpiRisk")} icon={Briefcase} value={fmtUsd(totals.riskToStop, { decimals: 0, compact: 10_000 })} hint={t("overnight.kpiRiskHint")} tone={totals.riskToStop > 0 ? "down" : "neutral"} />
            <StatCard label={t("overnight.kpiCatalyst")} icon={CalendarClock} value={totals.catalysts} tone={totals.catalysts ? "warn" : "neutral"} hint={t("overnight.kpiCatalystHint")} />
          </>
        )}
      </StatGrid>}

      <Panel
        title={t("overnight.bookTitle")}
        icon={Moon}
        description={mode === "all" ? t("overnight.bookDescPreview") : t("overnight.bookDesc")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {keyPill}
            <Segmented
              ariaLabel={t("overnight.modeAria")}
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "book", label: t("overnight.modeBook") },
                { value: "all", label: t("overnight.modeAll") },
              ]}
              className="no-print"
            />
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length} className="no-print">
              <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!rows.length} className="no-print">
              <Printer className="mr-1.5 h-4 w-4" aria-hidden="true" />{t("overnight.print")}
            </Button>
          </div>
        }
      >
        {book.isLoading ? (
          <Skeleton className="h-48 rounded-xl" />
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            icon={Moon}
            title={mode === "all" ? t("positions.emptyTitle") : t("overnight.emptyBookTitle")}
            description={mode === "all" ? t("overnight.emptyAllDesc") : data?.afterKey ? t("overnight.emptyAfterKey") : t("overnight.emptyBeforeKey")}
            action={mode === "book" && !data?.afterKey ? <Button size="sm" variant="outline" onClick={() => setMode("all")}>{t("overnight.showAll")}</Button> : undefined}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {byTrader.map(([name, list]) => {
              const t = traderBy.get(name);
              return <TraderBlock key={name} name={name} t={t} rows={list} showTrader={isCurator} />;
            })}
          </div>
        )}
      </Panel>

      {!empty && <div className="grid grid-cols-1 gap-[var(--grid-gap)] xl:grid-cols-5">
        <Panel
          className="xl:col-span-3"
          title={t("overnight.scenTitle")}
          icon={Sparkles}
          description={t("overnight.scenDesc")}
          actions={
            <div className="flex flex-wrap items-center gap-2 no-print">
              <Segmented
                ariaLabel={t("overnight.shockAria")}
                size="sm"
                value={shockMode}
                onChange={setShockMode}
                options={[
                  { value: "market", label: t("overnight.shockMarket") },
                  { value: "adverse", label: t("overnight.shockAdverse") },
                ]}
              />
              <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                {t("overnight.customPct")}
                <Input
                  inputMode="decimal"
                  value={customPct}
                  onChange={(e) => setCustomPct(e.target.value)}
                  aria-label={t("overnight.customAria")}
                  className="h-8 w-20 text-right"
                />
              </label>
            </div>
          }
        >
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("overnight.scenEmpty")}</p>
          ) : (
            <ScenarioTable results={results} rooms={rooms} shockMode={shockMode} />
          )}
        </Panel>

        <Panel className="xl:col-span-2" title={t("overnight.concTitle")} icon={Layers} description={t("overnight.concDesc")}>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("overnight.concEmpty")}</p>
          ) : (
            <ConcentrationPanel c={conc} />
          )}
        </Panel>
      </div>}
    </div>
  );
}

const OVERNIGHT_ACCESSORS = {
  ticker: (r: Row) => r.p.ticker,
  side: (r: Row) => r.p.side,
  qty: (r: Row) => r.p.qty,
  entry: (r: Row) => r.p.entry,
  last: (r: Row) => r.m.unrealizedPct ?? null,
  unreal: (r: Row) => r.m.unrealizedUsd ?? null,
  stop: (r: Row) => r.m.riskToStopUsd ?? null,
  // Within one trader the limit is shared, so market value orders rows exactly like «% овернайт».
  mv: (r: Row) => r.m.marketValueUsd ?? null,
  sector: (r: Row) => r.p.sector ?? null,
};

function TraderBlock({ name, t: tr, rows: data, showTrader }: { name: string; t: OvernightTrader | undefined; rows: Row[]; showTrader: boolean }) {
  const { rows, thProps } = useTableSort(data, OVERNIGHT_ACCESSORS, "mv");
  const mv = rows.reduce((s, r) => s + (r.m.marketValueUsd ?? 0), 0);
  const unreal = rows.filter((r) => r.m.unrealizedUsd != null);
  const unrealSum = unreal.length ? unreal.reduce((s, r) => s + (r.m.unrealizedUsd ?? 0), 0) : null;
  const risk = rows.reduce((s, r) => s + (r.m.riskToStopUsd ?? 0), 0);
  const L = tr?.limits;
  const forbidden = L && !L.allowOvernight && rows.some((r) => r.p.horizon !== "swing");
  const forbiddenSwing = L && !L.allowSwing && rows.some((r) => r.p.horizon === "swing");
  const { t } = riskI18n.useT();
  const cm = commonI18n.t;
  const short = (v: number) => fmtUsd(v, { decimals: 0, compact: 10_000 });
  const strong = (node: React.ReactNode, cls = "text-foreground") => <span className={cn("font-medium", cls)}>{node}</span>;
  return (
    <section aria-label={t("overnight.blockAria", { name: personName(name) })} className="rounded-xl bg-[var(--glass-bg)] p-3 ring-1 ring-inset ring-[var(--field-border)]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          {showTrader ? <Link href={links.risk(name)} className="font-semibold hover:text-primary">{personName(name)}</Link> : <span className="font-semibold">{personName(name)}</span>}
          {tr && <StopPill state={tr.stop.state} />}
          {forbidden && <Pill tone="down" dot>{t("alertKind.overnight_not_allowed")}</Pill>}
          {forbiddenSwing && <Pill tone="down" dot>{t("alertKind.swing_not_allowed")}</Pill>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
          <span>{rich(t("overnight.exposure", slots("amount")), { amount: strong(short(mv)) })}</span>
          <span>
            {rich(t("overnight.unreal", slots("amount")), {
              amount: strong(unrealSum != null ? fmtUsd(unrealSum, { signed: true, decimals: 0 }) : "—", unrealSum == null ? "" : unrealSum > 0 ? "text-up" : unrealSum < 0 ? "text-down" : "text-foreground"),
            })}
          </span>
          <span>{rich(t("overnight.riskToStops", slots("amount")), { amount: strong(short(risk)) })}</span>
          {tr && (
            <span className="inline-flex items-center gap-1">
              {rich(t("overnight.today", slots("amount")), {
                amount: strong(tr.todayPnlNet != null ? fmtUsd(tr.todayPnlNet, { signed: true, decimals: 0 }) : "—", toneOf(tr.todayPnlNet) === "up" ? "text-up" : toneOf(tr.todayPnlNet) === "down" ? "text-down" : "text-foreground"),
              })}
            </span>
          )}
        </div>
        <div className="ml-auto w-full sm:w-64">
          <LimitBar size="sm" label={t("overnight.maxOvernight")} used={mv} limit={L?.maxOvernightExposure} hint={tr?.dailyRemainingUsd != null ? t("overnight.dayLeft", { amount: fmtUsd(tr.dailyRemainingUsd, { decimals: 0 }) }) : undefined} />
        </div>
      </div>

      <TableScroll className="mt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead {...thProps("ticker")}>{cm("trading.ticker")}</SortableTableHead>
              <SortableTableHead {...thProps("side")}>{cm("trading.side")}</SortableTableHead>
              <SortableTableHead {...thProps("qty")} align="right">{t("positions.qty")}</SortableTableHead>
              <SortableTableHead {...thProps("entry")} align="right">{t("overnight.col.avg")}</SortableTableHead>
              <SortableTableHead {...thProps("last")} align="right">{t("overnight.col.last")}</SortableTableHead>
              <SortableTableHead {...thProps("unreal")} align="right">{t("overnight.col.unreal")}</SortableTableHead>
              <SortableTableHead {...thProps("stop")} align="right">{t("overnight.col.toStop")}</SortableTableHead>
              <SortableTableHead {...thProps("mv")} align="right" className="whitespace-nowrap">{t("overnight.col.pctOvernight")}</SortableTableHead>
              <TableHead>{t("overnight.col.catalysts")}</TableHead>
              <SortableTableHead {...thProps("sector")}>{cm("trading.sector")}</SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ p, m, cats, pctOfMax }) => (
              <TableRow key={p.id} className={cn(cats.some((c) => c.urgent) && "bg-warn/5")}>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Link href={links.trade(p.id)} className="font-semibold hover:text-primary">{p.ticker}</Link>
                    <Pill tone={HORIZON_TONE[p.horizon]}>{HORIZON_LABEL[p.horizon]}</Pill>
                    {p.noStatus && <Pill tone="warn">{t("positions.noStatus")}</Pill>}
                  </div>
                  <div className="text-2xs text-muted-foreground">{p.daysHeld === 0 ? t("overnight.openedToday") : t("overnight.daysInPosition", { count: p.daysHeld })}{p.setup ? ` · ${p.setup}` : ""}</div>
                </TableCell>
                <TableCell className="text-sm">{sideLabel(p.side)}</TableCell>
                <TableCell className="text-right tabular-nums">{p.qty ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{p.entry ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {m.last != null ? m.last : <span className="text-muted-foreground">—</span>}
                  {m.unrealizedPct != null && <div className={cn("text-2xs", m.unrealizedPct > 0 ? "text-up" : m.unrealizedPct < 0 ? "text-down" : "text-muted-foreground")}>{m.unrealizedPct > 0 ? "+" : ""}{m.unrealizedPct}%</div>}
                </TableCell>
                <TableCell className={cn("text-right font-medium tabular-nums", m.unrealizedUsd == null ? "text-muted-foreground" : m.unrealizedUsd > 0 ? "text-up" : m.unrealizedUsd < 0 ? "text-down" : "")}>
                  {m.unrealizedUsd != null ? fmtUsd(m.unrealizedUsd, { signed: true, decimals: 0 }) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {m.riskToStopUsd != null ? fmtUsd(m.riskToStopUsd, { decimals: 0 }) : <span className="text-muted-foreground">{t("overnight.noStop")}</span>}
                  {p.stop != null && (
                    <div className={cn("text-2xs", m.riskToStopUsd === 0 ? "font-medium text-down" : "text-muted-foreground")}>
                      {m.riskToStopUsd === 0 ? t("overnight.stopHit", { price: p.stop }) : t("overnight.stopAt", { price: p.stop })}
                    </div>
                  )}
                </TableCell>
                <TableCell className={cn("text-right tabular-nums", usageText(pctOfMax))}>{pctOfMax != null ? fmtPct(pctOfMax, { decimals: 0, signed: false }) : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell><CatalystPills items={cats} /></TableCell>
                <TableCell className="max-w-[200px] text-xs text-muted-foreground">{p.sector ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
    </section>
  );
}

function ScenarioTable({ results, rooms, shockMode }: { results: ShockResult[]; rooms: TraderRoom[]; shockMode: ShockMode }) {
  const traders = React.useMemo(() => [...new Set(results.flatMap((r) => r.traders.map((t) => t.trader)))].sort(comparePersonNames), [results]);
  const roomBy = new Map(rooms.map((r) => [r.trader, r]));
  const breachers = new Map<string, string[]>();
  for (const r of results) for (const name of r.desk.breaches) breachers.set(name, [...(breachers.get(name) ?? []), r.shock.label]);
  const { t: tr } = riskI18n.useT();
  return (
    <div className="flex flex-col gap-3">
      {breachers.size > 0 ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl bg-down/10 px-3 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-down" aria-hidden="true" />
          <span className="font-medium text-down">{tr("overnight.scen.breachTitle")}</span>
          {[...breachers.entries()].map(([name, labels]) => (
            <Pill key={name} tone="down">{personName(name)} · {labels.length > 1 ? tr("overnight.scen.more", { label: labels[0], count: labels.length - 1 }) : labels[0]}</Pill>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {rooms.every((r) => r.dailyRemainingUsd == null) ? tr("overnight.scen.noneNoLimits") : tr("overnight.scen.none")}
        </p>
      )}
      <TableScroll>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{commonI18n.t("fields.trader")}</TableHead>
              <TableHead className="whitespace-nowrap text-right">{tr("overnight.scen.dayLeft")}</TableHead>
              {results.map((r) => <TableHead key={r.shock.key} className="text-right">{r.shock.label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {traders.map((name) => {
              const room = roomBy.get(name);
              return (
                <TableRow key={name}>
                  <TableCell className="font-medium">{personName(name)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{room?.dailyRemainingUsd != null ? fmtUsd(room.dailyRemainingUsd, { decimals: 0 }) : "—"}</TableCell>
                  {results.map((r) => {
                    const x = r.traders.find((y) => y.trader === name);
                    if (!x) return <TableCell key={r.shock.key} className="text-right">—</TableCell>;
                    return (
                      <TableCell key={r.shock.key} className={cn("text-right tabular-nums", x.breach && "bg-down/10")}>
                        <div className={cn("font-medium", x.pnlUsd > 0 ? "text-up" : x.pnlUsd < 0 ? "text-down" : "")}>{fmtUsd(x.pnlUsd, { signed: true, decimals: 0 })}</div>
                        {x.remainingAfterUsd != null && (
                          <div className={cn("text-2xs", x.breach ? "font-semibold text-down" : "text-muted-foreground")}>
                            {x.breach ? tr("overnight.scen.stopOver", { amount: fmtUsd(-x.remainingAfterUsd, { decimals: 0 }) }) : tr("overnight.scen.left", { amount: fmtUsd(x.remainingAfterUsd, { decimals: 0 }) })}
                          </div>
                        )}
                        {x.worst[0]?.pnlUsd != null && x.worst[0].pnlUsd < 0 && <div className="text-2xs text-muted-foreground">{x.worst[0].ticker} {fmtUsd(x.worst[0].pnlUsd, { signed: true, decimals: 0, compact: 10_000 })}</div>}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
            <TableRow className="font-semibold">
              <TableCell>{commonI18n.t("trading.desk")}</TableCell>
              <TableCell />
              {results.map((r) => (
                <TableCell key={r.shock.key} className={cn("text-right tabular-nums", r.desk.pnlUsd > 0 ? "text-up" : r.desk.pnlUsd < 0 ? "text-down" : "")}>
                  {fmtUsd(r.desk.pnlUsd, { signed: true, decimals: 0 })}
                  {r.desk.breaches.length > 0 && <div className="whitespace-nowrap text-2xs font-normal text-down">{tr("overnight.scen.breaches", { count: r.desk.breaches.length })}</div>}
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      </TableScroll>
      <p className="text-2xs text-muted-foreground">
        {tr("overnight.scen.atrNote")} {shockMode === "market" ? tr("overnight.scen.marketNote") : tr("overnight.scen.adverseNote")} {tr("overnight.scen.leftNote")}
      </p>
    </div>
  );
}

function Bars({ items, max }: { items: { key: string; label?: string; value: number; pct: number; sub?: React.ReactNode; tone?: "up" | "down" | "accent" | "neutral" }[]; max: number }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((it) => (
        <li key={it.key} className="text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium" title={it.label ?? it.key}>{it.label ?? it.key}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{fmtUsd(it.value, { decimals: 0, compact: 10_000 })} · {Math.round(it.pct)}%</span>
          </div>
          <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-[var(--glass-bg)] ring-1 ring-inset ring-[var(--field-border)]">
            <div
              className="h-full rounded-full"
              style={{
                width: `${max > 0 ? Math.max(2, (it.value / max) * 100) : 0}%`,
                background: it.tone === "down" ? "hsl(var(--down))" : it.tone === "up" ? "hsl(var(--up))" : it.tone === "accent" ? "hsl(var(--primary))" : "hsl(var(--chart-1))",
              }}
            />
          </div>
          {it.sub && <div className="mt-0.5 text-2xs text-muted-foreground">{it.sub}</div>}
        </li>
      ))}
    </ul>
  );
}

function ConcentrationPanel({ c }: { c: ReturnType<typeof concentration> }) {
  const topTickers = c.byTicker.slice(0, 6);
  const topSectors = c.bySector.slice(0, 6);
  const { t } = riskI18n.useT();
  const short = (v: number) => fmtUsd(v, { decimals: 0, compact: 10_000 });
  const pct0 = (v: number) => fmtPct(v, { decimals: 0, signed: false });
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="micro-label">{t("overnight.conc.longShort")}</span>
          <span className="tabular-nums text-muted-foreground">{t("overnight.conc.net", { amount: fmtUsd(c.netUsd, { signed: true, decimals: 0, compact: 10_000 }) })}</span>
        </div>
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--glass-bg)] ring-1 ring-inset ring-[var(--field-border)]" role="img" aria-label={t("overnight.conc.sideAria", { long: pct0(c.bySide.longPct), short: pct0(100 - c.bySide.longPct) })}>
          <div className="h-full bg-up" style={{ width: `${c.bySide.longPct}%` }} />
          <div className="h-full bg-down" style={{ width: `${100 - c.bySide.longPct}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-2xs tabular-nums text-muted-foreground">
          <span>{t("overnight.conc.long", { amount: short(c.longUsd), pct: pct0(c.bySide.longPct) })}</span>
          <span>{t("overnight.conc.short", { amount: short(c.shortUsd) })}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <div className="micro-label mb-1.5">{t("overnight.conc.byTicker")}{c.topTickerPct >= 40 && <Pill tone="warn" className="ml-2">{t("overnight.conc.top", { pct: pct0(c.topTickerPct) })}</Pill>}</div>
          <Bars
            max={topTickers[0]?.grossUsd ?? 0}
            items={topTickers.map((b) => ({
              key: b.key,
              value: b.grossUsd,
              pct: b.pctOfGross,
              tone: b.traders.length > 1 ? "accent" : "neutral",
              sub: b.traders.length > 1 ? t("overnight.conc.tradersSub", { traders: commonI18n.t("units.traders", { count: b.traders.length }), names: b.traders.map(personName).join(", ") }) : undefined,
            }))}
          />
        </div>
        <div>
          <div className="micro-label mb-1.5">{t("overnight.conc.bySector")}</div>
          <Bars
            max={topSectors[0]?.grossUsd ?? 0}
            items={topSectors.map((b) => ({
              key: b.key,
              label: b.key === NO_SECTOR ? t("overnight.conc.noSector") : b.key,
              value: b.grossUsd,
              pct: b.pctOfGross,
              tone: b.key === NO_SECTOR ? "neutral" : "accent",
              sub: t("overnight.conc.sectorSub", { positions: positionsCount(b.count), long: short(b.longUsd), short: short(b.shortUsd) }),
            }))}
          />
        </div>
      </div>

      <div>
        <div className="micro-label mb-1.5 flex items-center gap-1"><Users className="h-3 w-3" aria-hidden="true" />{t("overnight.conc.shared")}</div>
        {c.sharedTickers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("overnight.conc.sharedNone")}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {c.sharedTickers.map((s) => (
              <li key={s.ticker}>
                <Pill tone={s.sameSide ? "warn" : "neutral"}>
                  {s.ticker} · {s.traders.map(personName).join(", ")} · {s.sameSide ? t("overnight.conc.allSide", { side: commonI18n.t(s.sides[0] === "long" ? "trading.long" : "trading.short") }) : t("overnight.conc.mixedSides")} · {short(s.grossUsd)}
                </Pill>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="micro-label mb-1.5">{t("overnight.conc.correlated")}</div>
        {c.correlatedLongs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("overnight.conc.correlatedNone")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {c.correlatedLongs.map((g) => (
              <li key={g.sector} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-warn/10 px-2 py-1.5">
                <span className="font-medium">{g.sector}</span>
                <span className="tabular-nums text-muted-foreground">{short(g.longUsd)} · {t("overnight.conc.ofBook", { pct: pct0(g.pctOfGross) })}</span>
                <span className="text-muted-foreground">{g.tickers.join(", ")} · {g.traders.map(personName).join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
