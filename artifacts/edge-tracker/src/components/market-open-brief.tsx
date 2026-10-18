import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  Sunrise,
  RefreshCw,
  Zap,
  Brain,
  Copy,
  Check,
  Globe2,
  TrendingUp,
  TrendingDown,
  CalendarDays,
  Newspaper,
  Activity,
  ChevronRight,
} from "lucide-react";
import { useMarketBrief, type MarketBrief } from "@/lib/market-intel";
import { ApiError, http } from "@/lib/api/http";
import { Segmented, Pill, EmptyState, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  WidgetShell,
  IconAction,
  WidgetError,
  SkeletonTiles,
  relTime,
  nySession,
  useNow,
  useStoredState,
  num,
} from "@/components/widgets/widget-kit";
import { fmtDate, fmtPct, fmtPrice } from "@/lib/format";
import { marketWidgetsI18n } from "@/i18n/ns/marketWidgets";

const bt = marketWidgetsI18n.t;
/** Server period label («За последний день» / «Last day») → mid-sentence form. */
const lowerFirst = (s: string) => s.charAt(0).toLocaleLowerCase() + s.slice(1);

/** 9:25–10:30 ET weekdays: the brief opens itself automatically. */
function isMarketOpenWindow(now = new Date()): boolean {
  const s = nySession(now);
  if (s.key === "weekend") return false;
  const [h, m] = s.hhmm.split(":").map(Number);
  const t = h * 60 + m;
  return t >= 9 * 60 + 25 && t <= 10 * 60 + 30;
}

/** Premarket = 4:00–9:35 ET weekdays (live quotes auto-refresh). */
function isPremarketWindow(now = new Date()): boolean {
  const s = nySession(now);
  if (s.key === "weekend") return false;
  const [h, m] = s.hhmm.split(":").map(Number);
  const t = h * 60 + m;
  return t >= 4 * 60 && t <= 9 * 60 + 35;
}

type Quotes = Pick<MarketBrief, "futures" | "overnight" | "macro" | "premarketMovers" | "gapLeaders"> & { quotesAt: string };

type Tab = "markets" | "movers" | "calendar" | "news";
const TABS = ["markets", "movers", "calendar", "news"] as const;

const pctTone = (v: unknown): Tone => {
  const n = num(v);
  return n == null || n === 0 ? "neutral" : n > 0 ? "up" : "down";
};
const pctClass = (v: unknown) => {
  const t = pctTone(v);
  return t === "up" ? "text-up" : t === "down" ? "text-down" : "text-muted-foreground";
};

/** Rule-based risk-on/off read from futures, VIX, DXY and overnight markets. */
function riskSentiment(b: MarketBrief, premarket: boolean): { tone: Tone; label: string; factors: string[] } {
  const factors: string[] = [];
  let score = 0;
  const fut = b.futures
    .map((f) => num(premarket && f.preMarketChangePct != null ? f.preMarketChangePct : f.changePct))
    .filter((x): x is number => x != null);
  if (fut.length) {
    const avg = fut.reduce((a, c) => a + c, 0) / fut.length;
    if (avg > 0.2) { score++; factors.push(bt("brief.futuresUp", { value: fmtPct(avg) })); }
    else if (avg < -0.2) { score--; factors.push(bt("brief.futuresDown", { value: fmtPct(avg) })); }
  }
  const vix = b.macro?.find((m) => m.name === "VIX");
  const vixCh = num(vix?.changePct);
  if (vixCh != null) {
    if (vixCh > 3) { score--; factors.push(bt("brief.vixUp", { value: fmtPct(vixCh, 1) })); }
    else if (vixCh < -3) { score++; factors.push(bt("brief.vixDown", { value: fmtPct(vixCh, 1) })); }
  }
  const dxy = num(b.macro?.find((m) => m.name === "DXY")?.changePct);
  if (dxy != null) {
    if (dxy > 0.3) { score--; factors.push(bt("brief.dollarUp", { value: fmtPct(dxy) })); }
    else if (dxy < -0.3) { score++; factors.push(bt("brief.dollarDown", { value: fmtPct(dxy) })); }
  }
  const ov = (b.overnight ?? []).map((o) => num(o.changePct)).filter((x): x is number => x != null);
  if (ov.length) {
    const avg = ov.reduce((a, c) => a + c, 0) / ov.length;
    if (avg > 0.3) { score++; factors.push(bt("brief.overnightUp", { value: fmtPct(avg) })); }
    else if (avg < -0.3) { score--; factors.push(bt("brief.overnightDown", { value: fmtPct(avg) })); }
  }
  if (score >= 2) return { tone: "up", label: "Risk-on", factors };
  if (score <= -2) return { tone: "down", label: "Risk-off", factors };
  return { tone: "neutral", label: bt("brief.neutral"), factors: factors.length ? factors : [bt("brief.noSignals")] };
}

function Section({ title, icon: Icon, meta, children, className }: { title: string; icon?: typeof Globe2; meta?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
          {title}
        </h3>
        {meta && <span className="text-2xs text-muted-foreground tabular-nums">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function QuoteTile({ name, main, mainClass, sub, sub2, highlight }: { name: string; main: string; mainClass?: string; sub?: React.ReactNode; sub2?: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-xl bg-foreground/[0.04] px-3 py-2", highlight && "ring-1 ring-[hsl(var(--chart-3)/0.45)]")}>
      <div className="truncate text-2xs text-muted-foreground">{name}</div>
      <div className={cn("text-base font-semibold tabular-nums leading-tight", mainClass)}>{main}</div>
      {sub && <div className="truncate text-2xs tabular-nums">{sub}</div>}
      {sub2 && <div className="truncate text-2xs tabular-nums text-muted-foreground">{sub2}</div>}
    </div>
  );
}

function MoverRow({ ticker, pct, sector, catalyst, price }: { ticker: string; pct: number | null; sector?: string | null; catalyst?: string | null; price?: number | null }) {
  const up = (pct ?? 0) >= 0;
  return (
    <li className="flex items-center gap-2 py-1.5">
      <span
        className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full", up ? "bg-up/15 text-up" : "bg-down/15 text-down")}
        aria-hidden="true"
      >
        {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
      </span>
      <span className="w-14 shrink-0 text-sm font-semibold">{ticker}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={catalyst ?? undefined}>
        {[sector, catalyst].filter(Boolean).join(" · ") || "—"}
      </span>
      {price != null && <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">{fmtPrice(price)}</span>}
      <span className={cn("w-16 shrink-0 text-right text-sm font-semibold tabular-nums", pctClass(pct))}>{fmtPct(pct)}</span>
    </li>
  );
}

/** Macro event type → chip label (macro codes like FOMC/CPI stay as is). */
const EVENT_CODES = new Set(["fomc", "cpi", "ppi", "nfp", "opex", "gdp"]);
const eventTypeLabel = (type: string) => (EVENT_CODES.has(type) ? type.toUpperCase() : marketWidgetsI18n.tryT(`brief.eventType.${type}`) ?? type);

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <IconAction
      icon={ok ? Check : Copy}
      label={ok ? bt("brief.copied") : bt("brief.copySummary")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
    />
  );
}

export function MarketOpenBrief({ alwaysShow = false }: { alwaysShow?: boolean }) {
  const { t } = marketWidgetsI18n.useT();
  const now = useNow(30_000);
  const [forceShow, setForceShow] = useState<boolean>(alwaysShow);
  const [tab, setTab] = useStoredState<Tab>("market_brief_tab", "markets", TABS);

  const visible = alwaysShow || forceShow || isMarketOpenWindow(new Date(now));
  const { data, isLoading, isError, refetch, isFetching } = useMarketBrief({ enabled: visible });

  const [quotes, setQuotes] = useState<Quotes | null>(null);
  const [quotesFetching, setQuotesFetching] = useState(false);
  const [quotesError, setQuotesError] = useState<string | null>(null);
  const [nextRefresh, setNextRefresh] = useState(60);
  const premarket = isPremarketWindow(new Date(now));
  const session = nySession(new Date(now));

  // Live quotes only (no AI rebuild) — the old "now" button forced a full brief + AI summary.
  const fetchQuotes = useCallback(async () => {
    setQuotesFetching(true);
    setNextRefresh(60);
    try {
      setQuotes(await http.get<Quotes>("/api/market-brief/quotes"));
      setQuotesError(null);
    } catch (e) {
      setQuotesError(e instanceof ApiError && !e.isNetwork ? bt("brief.quotesUnavailableHttp", { status: e.status }) : bt("brief.quotesUnavailableNet"));
    } finally {
      setQuotesFetching(false);
    }
  }, []);

  // Auto-refresh quotes every 60s during premarket.
  useEffect(() => {
    if (!visible || !premarket) return;
    fetchQuotes();
    const interval = setInterval(fetchQuotes, 60_000);
    return () => clearInterval(interval);
  }, [visible, premarket, fetchQuotes]);

  // Countdown to the next auto-refresh.
  useEffect(() => {
    if (!quotes || !premarket) return;
    const t = setInterval(() => setNextRefresh((n) => (n > 0 ? n - 1 : 60)), 1_000);
    return () => clearInterval(t);
  }, [quotes, premarket]);

  const brief: MarketBrief | null = useMemo(() => {
    if (!data) return null;
    return quotes ? { ...data, ...quotes } : data;
  }, [data, quotes]);

  const sentiment = useMemo(() => (brief ? riskSentiment(brief, premarket) : null), [brief, premarket]);

  /* ───────── Outside the open window: compact teaser ───────── */
  if (!visible) {
    return (
      <div className="glass-panel flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/12 text-primary">
          <Sunrise className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {t("brief.title")}
            <Pill tone={session.tone} dot>
              {session.label} · NY {session.hhmm}
            </Pill>
          </div>
          <div className="text-xs text-muted-foreground">{t("brief.teaser")}</div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setForceShow(true)}>
          {t("brief.showNow")}
        </Button>
      </div>
    );
  }

  const counts = {
    movers: (brief?.premarketMovers?.length ?? 0) + (brief?.gapLeaders?.length ?? 0),
    calendar: (brief?.earningsToday?.length ?? 0) + (brief?.economicEvents?.length ?? 0),
    news: brief?.topNews?.length ?? 0,
  };
  const builtAt = brief?.fetchedAt ?? brief?.generatedAt ?? null;
  const stale = !!(brief as (MarketBrief & { stale?: boolean }) | null)?.stale;

  return (
    <WidgetShell
      icon={Sunrise}
      title={t("brief.title")}
      meta={brief?.date ? fmtDate(brief.date.slice(0, 10), "weekdayDayMonth") : undefined}
      actions={
        <>
          <IconAction
            icon={Zap}
            label={t("brief.refreshQuotes")}
            active={!!quotes}
            disabled={quotesFetching}
            onClick={fetchQuotes}
            className={quotesFetching ? "motion-safe:animate-pulse" : undefined}
          />
          <IconAction
            icon={RefreshCw}
            label={t("brief.refresh")}
            spinning={isFetching}
            disabled={isFetching}
            onClick={() => {
              setQuotes(null);
              setQuotesError(null);
              refetch();
            }}
          />
          {!alwaysShow && !isMarketOpenWindow(new Date(now)) && (
            <Button size="sm" variant="ghost" onClick={() => setForceShow(false)}>
              {t("brief.hide")}
            </Button>
          )}
        </>
      }
    >
      {/* Status line: session, timestamps, live */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <Pill tone={session.tone} dot>
          {session.label} · NY {session.hhmm}
        </Pill>
        {builtAt && (
          <span className="tabular-nums" title={fmtDate(builtAt, "shortDateTime")}>
            {t("brief.builtAt", { time: fmtDate(builtAt, "time"), ago: relTime(builtAt, now) })}
          </span>
        )}
        {stale && <Pill tone="warn">{t("brief.stale")}</Pill>}
        {quotes && (
          <span className="flex items-center gap-1 tabular-nums text-up">
            <Activity className="h-3 w-3 motion-safe:animate-pulse" aria-hidden="true" />
            {t("brief.quotesAt", { time: fmtDate(quotes.quotesAt, "time") })}
            {premarket && <span className="text-muted-foreground">{t("brief.nextRefresh", { count: nextRefresh })}</span>}
          </span>
        )}
      </div>

      {quotesError && <WidgetError message={quotesError} className="mb-3" />}

      {isLoading && !brief ? (
        <div className="space-y-3" aria-busy="true" aria-label={t("brief.building")}>
          <Skeleton className="h-16 w-full rounded-xl" />
          <SkeletonTiles count={4} />
        </div>
      ) : isError && !brief ? (
        <WidgetError message={t("brief.buildFailed")} onRetry={() => refetch()} />
      ) : brief ? (
        <div className="space-y-4">
          {/* Headline: sentiment + AI summary */}
          <div className="grid gap-3 lg:grid-cols-[13rem_minmax(0,1fr)]">
            {sentiment && (
              <div className="rounded-xl bg-foreground/[0.04] px-3 py-2.5">
                <div className="text-2xs text-muted-foreground">{t("brief.sentiment")}</div>
                <div className={cn("text-lg font-semibold", sentiment.tone === "up" ? "text-up" : sentiment.tone === "down" ? "text-down" : "text-foreground")}>
                  {sentiment.label}
                </div>
                <ul className="mt-1 space-y-0.5 text-2xs text-muted-foreground">
                  {sentiment.factors.slice(0, 4).map((f) => (
                    <li key={f}>· {f}</li>
                  ))}
                </ul>
              </div>
            )}
            {brief.aiSummary ? (
              <div className="relative rounded-xl bg-primary/[0.07] px-3 py-2.5">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                    <Brain className="h-3.5 w-3.5" aria-hidden="true" /> {t("brief.aiTitle")}
                  </span>
                  <CopyButton text={brief.aiSummary} />
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{brief.aiSummary}</p>
              </div>
            ) : (
              <div className="flex items-center rounded-xl bg-foreground/[0.04] px-3 py-2.5 text-sm text-muted-foreground">
                {t("brief.aiPending")}
              </div>
            )}
          </div>

          <Segmented<Tab>
            ariaLabel={t("brief.tabsAria")}
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "markets", label: t("brief.tabMarkets") },
              { value: "movers", label: t("brief.tabMovers"), count: counts.movers || undefined },
              { value: "calendar", label: t("brief.tabCalendar"), count: counts.calendar || undefined },
              { value: "news", label: t("brief.tabNews"), count: counts.news || undefined },
            ]}
          />

          {tab === "markets" && (
            <div className="space-y-4">
              {brief.futures?.length > 0 && (
                <Section title={t("brief.futures")} meta={premarket ? t("brief.futuresMetaPre") : t("brief.futuresMetaDay")}>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {brief.futures.map((f) => {
                      const pm = premarket ? f.preMarketChangePct : null;
                      return (
                        <QuoteTile
                          key={f.symbol}
                          name={f.name}
                          main={fmtPct(f.changePct)}
                          mainClass={pctClass(f.changePct)}
                          sub={pm != null ? <span className={pctClass(pm)}>{t("brief.premarket", { value: fmtPct(pm) })}</span> : undefined}
                          sub2={fmtPrice(premarket && f.preMarketPrice != null ? f.preMarketPrice : f.price)}
                          highlight={pm != null}
                        />
                      );
                    })}
                  </div>
                </Section>
              )}
              {(brief.macro?.length ?? 0) > 0 && (
                <Section title={t("brief.macro")}>
                  <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
                    {brief.macro!.map((m) => (
                      <QuoteTile
                        key={m.symbol}
                        name={m.name}
                        main={fmtPrice(m.price)}
                        sub={<span className={pctClass(m.changePct)}>{fmtPct(m.changePct)}</span>}
                      />
                    ))}
                  </div>
                </Section>
              )}
              {(brief.overnight?.length ?? 0) > 0 && (
                <Section title={t("brief.overnight")} icon={Globe2}>
                  <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                    {brief.overnight!.map((o) => (
                      <li key={o.symbol} className="flex items-center justify-between gap-2 border-b border-border/40 py-1.5 text-sm last:border-0">
                        <span className="min-w-0 truncate">
                          {o.name} <span className="text-2xs text-muted-foreground">{o.region === "Asia" ? t("brief.asia") : o.region === "Europe" ? t("brief.europe") : o.region}</span>
                        </span>
                        <span className={cn("font-medium tabular-nums", pctClass(o.changePct))}>{fmtPct(o.changePct)}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              {(brief.sectorRotation?.length ?? 0) > 0 && (
                <Section title={t("brief.rotation")}>
                  <div className="flex flex-wrap gap-1.5">
                    {brief.sectorRotation.slice(0, 3).map((s) => (
                      <Pill key={s.symbol} tone="up">{s.symbol} {fmtPct(s.changePct, 1)}</Pill>
                    ))}
                    {brief.sectorRotation.length > 3 &&
                      brief.sectorRotation.slice(-3).map((s) => (
                        <Pill key={s.symbol} tone="down">{s.symbol} {fmtPct(s.changePct, 1)}</Pill>
                      ))}
                  </div>
                </Section>
              )}
            </div>
          )}

          {tab === "movers" && (
            <div className="space-y-4">
              <Section title={t("brief.pmMovers")} meta={brief.premarketMovers?.length ? t("brief.tickersCount", { count: brief.premarketMovers.length }) : undefined}>
                {brief.premarketMovers?.length ? (
                  <ul className="divide-y divide-border/40">
                    {brief.premarketMovers.map((p) => (
                      <MoverRow key={p.ticker} ticker={p.ticker} pct={p.preMarketPct} sector={p.sector} catalyst={p.catalyst} price={p.preMarketPrice} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("brief.noPmMoves")}</p>
                )}
              </Section>
              <Section title={t("brief.gaps")} meta={brief.gapLeaders?.length ? t("brief.tickersCount", { count: brief.gapLeaders.length }) : undefined}>
                {brief.gapLeaders?.length ? (
                  <ul className="divide-y divide-border/40">
                    {brief.gapLeaders.map((g) => (
                      <MoverRow key={g.ticker} ticker={g.ticker} pct={g.gapPct} sector={g.sector} catalyst={g.catalyst} price={g.price} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("brief.noGaps")}</p>
                )}
              </Section>
              <Link href="/watchlist" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                {t("brief.openWatchlist")} <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          )}

          {tab === "calendar" && (
            <div className="space-y-4">
              <Section title={t("brief.earningsToday")} meta={brief.earningsToday?.length ? `${brief.earningsToday.length}` : undefined}>
                {brief.earningsToday?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {brief.earningsToday.map((e, i) => (
                      <span key={`${e.ticker}-${i}`} title={e.headline ?? undefined}>
                        <Pill tone="accent">{e.ticker}</Pill>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("brief.noEarnings")}</p>
                )}
              </Section>
              <Section title={t("brief.macroEvents")} icon={CalendarDays}>
                {brief.economicEvents?.length ? (
                  <ul className="divide-y divide-border/40">
                    {brief.economicEvents.slice(0, 10).map((e) => {
                      const isToday = e.date?.slice(0, 10) === brief.date;
                      return (
                        <li key={e.id} className="flex items-center gap-2 py-1.5 text-sm">
                          <span className={cn("w-24 shrink-0 text-xs tabular-nums", isToday ? "font-semibold text-primary" : "text-muted-foreground")}>
                            {isToday ? t("brief.today") : fmtDate(e.date.slice(0, 10), "weekdayDayMonth")}
                          </span>
                          <span className="min-w-0 flex-1 truncate" title={e.description ?? undefined}>{e.name}</span>
                          <Pill tone={e.importance === "high" ? "down" : e.importance === "medium" ? "warn" : "neutral"}>
                            {eventTypeLabel(e.type)}
                          </Pill>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("brief.noEvents")}</p>
                )}
              </Section>
              <Link href="/events" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                {t("brief.allEvents")} <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          )}

          {tab === "news" && (
            <div className="space-y-4">
              <Section title={t("brief.whatMatters", { period: brief.lookback?.label ? lowerFirst(brief.lookback.label) : t("brief.lastDay") })} icon={Newspaper}>
                {brief.topNews?.length ? (
                  <ul className="divide-y divide-border/40">
                    {brief.topNews.map((n, i) => {
                      const mv = num(n.percent_move);
                      return (
                        <li key={i} className="flex items-start gap-2 py-1.5">
                          <span className="w-14 shrink-0 text-sm font-semibold">{n.ticker}</span>
                          <span className="min-w-0 flex-1 text-sm leading-snug text-foreground/90">{n.headline}</span>
                          <span className="shrink-0 text-right">
                            {mv != null && <span className={cn("block text-sm font-semibold tabular-nums", pctClass(mv))}>{fmtPct(mv)}</span>}
                            <span className="block text-2xs tabular-nums text-muted-foreground">{n.date ? fmtDate(n.date.slice(0, 10), "dayMonthNumeric") : ""}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("brief.noNews")}</p>
                )}
              </Section>
              {brief.yesterdayThemes?.what_works_now && (
                <Section title={t("brief.whatWorked", { period: brief.lookback?.label ? lowerFirst(brief.lookback.label) : t("brief.yesterday") })}>
                  <p className="text-sm leading-relaxed text-foreground/90">{brief.yesterdayThemes.what_works_now}</p>
                  {brief.yesterdayThemes.best_tickers && (
                    <div className="flex flex-wrap gap-1.5">
                      {brief.yesterdayThemes.best_tickers
                        .split(/[,\s]+/)
                        .filter(Boolean)
                        .slice(0, 12)
                        .map((t) => (
                          <Pill key={t} tone="up">{t}</Pill>
                        ))}
                    </div>
                  )}
                </Section>
              )}
            </div>
          )}
        </div>
      ) : (
        <EmptyState icon={Sunrise} title={t("brief.emptyTitle")} description={t("brief.emptyText")} className="py-6" />
      )}
    </WidgetShell>
  );
}
