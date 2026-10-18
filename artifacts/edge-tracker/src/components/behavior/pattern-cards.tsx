/**
 * Карточки поведенческих паттернов — «что делать», а не только «что было»:
 *   стоимость за период ($ нетто) и тренд (последние 30 дней против предыдущих), почему это вредит,
 *   конкретное правило с кнопкой «Сделать правилом», 3–5 примеров со ссылками на сделку и разбор дня.
 * Паттерны со стоимостью идут первыми; не стоящие денег свёрнуты в одну строку.
 */
import * as React from "react";
import { Link } from "wouter";
import { CalendarDays, ChevronDown, ChevronRight, ExternalLink, Info, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { Pill, Sparkline, toneOf, toneText, type Tone } from "@/components/ds";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import {
  SEVERITY_LABEL, SEVERITY_TONE, dayReportHref, fmtClock, fmtMinutes, type PatternReport, type PatternTrend,
} from "./api";
import { fmtDate, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { behaviorI18n } from "@/i18n/ns/behavior";
import { MakeRuleButton } from "./make-rule";

const tb = behaviorI18n.t;
/** Label of a pattern «extra» metric (server key); unknown keys are shown as they are. */
const extraLabel = (k: string) => behaviorI18n.tryT(`card.metric.${k}`) ?? k;

function extraValue(key: string, v: number | string | null): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (key.endsWith("Min")) return fmtMinutes(v);
  if (key === "ratio") return `×${v.toFixed(2)}`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/* ─── Тренд ───────────────────────────────────────────────────────────────── */

function trendView(t: PatternTrend | undefined): { tone: Tone; label: string; Icon: typeof TrendingUp } {
  switch (t?.direction) {
    case "better": return { tone: "up", label: tb("card.trend.better"), Icon: TrendingDown };
    case "worse": return { tone: "down", label: tb("card.trend.worse"), Icon: TrendingUp };
    case "flat": return { tone: "neutral", label: tb("card.trend.flat"), Icon: Minus };
    default: return { tone: "neutral", label: tb("card.trend.nodata"), Icon: Minus };
  }
}

function perDay(v: number | null | undefined): string {
  return v == null ? "—" : tb("card.perDay", { value: fmtUsd(v, { signed: true, compact: true }) });
}

function TrendLine({ t }: { t: PatternTrend | undefined }) {
  const v = trendView(t);
  if (!t) return null;
  const title =
    `${tb("card.trendRecent", { from: t.recent.from ? fmtDate(t.recent.from, "dayMonth") : "…", to: t.recent.to ? fmtDate(t.recent.to, "dayMonth") : "…", trades: commonI18n.t("units.trades", { count: t.recent.n }), cost: fmtUsd(t.recent.cost, { signed: true, decimals: "auto" }), days: commonI18n.t("units.days", { count: t.recent.days }) })}\n` +
    `${tb("card.trendPrior", { trades: commonI18n.t("units.trades", { count: t.prior.n }), cost: fmtUsd(t.prior.cost, { signed: true, decimals: "auto" }), days: commonI18n.t("units.days", { count: t.prior.days }) })}\n` +
    tb("card.trendNote");
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" title={title}>
      <Pill tone={v.tone}>
        <v.Icon className="h-3 w-3" aria-hidden="true" />
        {tb("card.days30", { label: v.label })}
      </Pill>
      <span className="tabular-nums text-muted-foreground">
        {perDay(t.recent.costPerDay)} <span aria-hidden="true">·</span> {tb("card.before", { value: perDay(t.prior.costPerDay) })}
      </span>
    </div>
  );
}

/* ─── Карточка ────────────────────────────────────────────────────────────── */

type CardProps = { p: PatternReport; trader: string | null; canEdit: boolean };

export const PatternCard = React.memo(function PatternCard({ p, trader, canEdit }: CardProps) {
  const [details, setDetails] = React.useState(false);
  const detailsId = React.useId();
  const costTone = toneOf(p.cost);
  const weekly = React.useMemo(() => p.weekly.map((w) => w.cost ?? 0), [p.weekly]);
  const extras = React.useMemo(() => Object.entries(p.extra).filter(([, v]) => v != null), [p.extra]);
  const examples = p.examples.slice(0, 5);
  const insight = p.insight;

  return (
    <article
      className={cn("glass-panel flex min-w-0 flex-col gap-3 rounded-2xl p-4", p.severity === "high" && "ring-1 ring-down/35")}
      aria-labelledby={`${detailsId}-t`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`${detailsId}-t`} className="text-base font-semibold text-foreground">{p.title}</h3>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
        </div>
        <Pill tone={SEVERITY_TONE[p.severity]} dot title={tb("card.severityTitle")}>
          {SEVERITY_LABEL[p.severity]}
        </Pill>
      </header>

      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className={cn("text-[28px] font-semibold leading-tight tabular-nums tracking-tight", toneText(costTone))}>{fmtUsd(p.cost, { signed: true, decimals: "auto" })}</div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {tb("card.costHint", { trades: commonI18n.t("units.trades", { count: p.n }), days: commonI18n.t("units.days", { count: p.days }) })}
          </div>
        </div>
        {weekly.length > 1 && (
          <div className="shrink-0 text-right">
            <Sparkline data={weekly} tone="auto" width={112} height={28} className="w-[112px]" />
            <div className="text-xs text-muted-foreground">{tb("card.byWeek")}</div>
          </div>
        )}
      </div>

      <TrendLine t={p.trend} />

      {insight && (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">{tb("card.why")} </span>{insight.why}
          </p>
          <div className="tile flex flex-col gap-2 border-l-2 border-l-primary p-3">
            <p className="text-sm leading-snug text-foreground">{insight.recommendation}</p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {insight.rule ? tb("card.willRule") : tb("card.willTrigger")}
              </span>
              <MakeRuleButton insight={insight} patternKey={p.key} patternTitle={p.title} trader={trader} canEdit={canEdit} />
            </div>
          </div>
        </>
      )}

      {examples.length > 0 && (
        <ul className="flex flex-col" aria-label={tb("card.examplesAria", { title: p.title })}>
          {examples.map((e) => (
            <li key={e.id} className="group flex min-h-9 items-center gap-1 rounded-lg transition-colors duration-[var(--dur-1)] hover:bg-[var(--glass-hover-bg)]">
              <Link
                href={links.trade(e.id)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={tb("card.openTrade", { ticker: e.ticker, date: fmtDate(e.date, "medium") })}
                title={`${fmtDate(e.date, "medium")}${e.entryMin != null ? " " + fmtClock(e.entryMin) : ""} · ${e.note}`}
              >
                <span className="w-11 shrink-0 tabular-nums text-muted-foreground">{fmtDate(e.date, "dayMonthNumeric")}</span>
                <span className="w-10 shrink-0 tabular-nums text-muted-foreground">{e.entryMin != null ? fmtClock(e.entryMin) : ""}</span>
                <span className="w-12 shrink-0 truncate font-medium text-foreground">{e.ticker}</span>
                <span className={cn("w-14 shrink-0 text-right tabular-nums", toneText(toneOf(e.net)))}>{fmtUsd(e.net, { signed: true, compact: true })}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.note}</span>
              </Link>
              <Link
                href={dayReportHref(e.date, trader)}
                className="mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={tb("card.dayReview", { date: fmtDate(e.date, "medium") })}
                title={tb("card.dayReviewTitle")}
              >
                <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--glass-border)] pt-2 text-xs">
        {p.tradeIds.length > 0 && (
          <Link href={links.trades({ ids: p.tradeIds })} className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
            {tb("card.allInJournal", { trades: commonI18n.t("units.trades", { count: p.n }) })} <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
        <button
          type="button"
          onClick={() => setDetails((v) => !v)}
          aria-expanded={details}
          aria-controls={detailsId}
          className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <Info className="h-3 w-3" aria-hidden="true" /> {tb("card.how")}
        </button>
      </div>

      {details && (
        <div id={detailsId} className="flex flex-col gap-2 text-xs text-muted-foreground">
          <p>
            {tb("card.howCost", { net: fmtUsd(p.net, { signed: true, decimals: "auto" }), n: p.n, group: p.baselineLabel, avg: fmtUsd(p.baselineAvg, { signed: true, decimals: "auto" }) })}{" "}
            {tb("card.howStats", { avg: fmtUsd(p.avgNet, { signed: true, decimals: "auto" }), wr: fmtRate(p.winRate), share: fmtRate(p.share) })}
          </p>
          {extras.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {extras.map(([k, v]) => (
                <Pill key={k} tone="neutral">
                  <span className="text-muted-foreground">{extraLabel(k)}:</span> <span className="text-foreground">{extraValue(k, v)}</span>
                </Pill>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
});

/* ─── Сетка ───────────────────────────────────────────────────────────────── */

export const PatternCards = React.memo(function PatternCards({
  patterns, trader, canEdit,
}: {
  patterns: PatternReport[];
  trader: string | null;
  canEdit: boolean;
}) {
  const [showFree, setShowFree] = React.useState(false);
  const { costly, free } = React.useMemo(() => {
    const costly = patterns.filter((p) => p.cost != null && p.cost < 0).sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0));
    const free = patterns.filter((p) => !(p.cost != null && p.cost < 0)).sort((a, b) => b.n - a.n);
    return { costly, free };
  }, [patterns]);

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      {costly.length > 0 ? (
        <div className="grid grid-cols-1 gap-[var(--grid-gap)] min-[1280px]:grid-cols-2 min-[1800px]:grid-cols-3">
          {costly.map((p) => <PatternCard key={p.key} p={p} trader={trader} canEdit={canEdit} />)}
        </div>
      ) : (
        <p className="py-4 text-sm text-muted-foreground">{tb("card.noneCost")}</p>
      )}

      {free.length > 0 && (
        <div className="flex flex-col gap-[var(--grid-gap)]">
          <button
            type="button"
            onClick={() => setShowFree((v) => !v)}
            aria-expanded={showFree}
            className="flex min-h-9 items-center gap-2 rounded-xl px-2 text-left text-xs text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground"
          >
            {showFree ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{tb("card.free", { count: free.length })}</span>

            {!showFree && (
              <span className="min-w-0 flex-1 truncate">
                {free.map((p) => `${p.title.toLowerCase()} ${p.n ? `(${p.n}, ${fmtUsd(p.cost, { signed: true, compact: true })})` : "(0)"}`).join(" · ")}
              </span>
            )}
          </button>
          {showFree && (
            <div className="grid grid-cols-1 gap-[var(--grid-gap)] min-[1280px]:grid-cols-2 min-[1800px]:grid-cols-3">
              {free.map((p) => <PatternCard key={p.key} p={p} trader={trader} canEdit={canEdit} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
