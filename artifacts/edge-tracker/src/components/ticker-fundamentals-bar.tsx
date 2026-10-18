import React, { useEffect, useState, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTickerFundamentals, type TickerFundamentals } from "@/lib/market-intel";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { Pill, toneOf, type Tone } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { RefreshCw, Building2, Moon, CalendarClock } from "lucide-react";
import { fmtDate, fmtNum, fmtPct } from "@/lib/format";
import { marketWidgetsI18n } from "@/i18n/ns/marketWidgets";

type Props = {
  ticker: string;
  onLoaded?: (data: TickerFundamentals) => void;
  className?: string;
  autoFetch?: boolean;
  /** Optional: also load live quote + daily bars for price, ATR % and average overnight gap (default true). */
  showRisk?: boolean;
};

/* ---------- extra data: quote, daily bars (gap stats), upcoming earnings ---------- */

type Quote = {
  price: number | null;
  change: number | null;
  gapPct: number | null;
  atr: number | null;
  relativeVolume: number | null;
};

type Candle = { t: number; o: number | null; h: number | null; l: number | null; c: number | null };

type GapStats = { avgAbsGap: number; maxAbsGap: number; bigGapDays: number; sessions: number; atrPct: number | null };


function gapStats(candles: Candle[]): GapStats | null {
  const bars = candles.filter((c) => c.o != null && c.c != null && c.h != null && c.l != null) as Array<Required<{ [K in keyof Candle]: number }>>;
  if (bars.length < 6) return null;
  const last = bars.slice(-21);
  const gaps: number[] = [];
  const trs: number[] = [];
  for (let i = 1; i < last.length; i++) {
    const prev = last[i - 1].c;
    if (prev > 0) gaps.push(Math.abs((last[i].o - prev) / prev) * 100);
    trs.push(Math.max(last[i].h - last[i].l, Math.abs(last[i].h - prev), Math.abs(last[i].l - prev)));
  }
  if (gaps.length === 0) return null;
  const lastClose = last[last.length - 1].c;
  const atr = trs.length ? trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length) : null;
  return {
    avgAbsGap: gaps.reduce((a, b) => a + b, 0) / gaps.length,
    maxAbsGap: Math.max(...gaps),
    bigGapDays: gaps.filter((g) => g >= 3).length,
    sessions: gaps.length,
    atrPct: atr != null && lastClose > 0 ? (atr / lastClose) * 100 : null,
  };
}

type UpcomingEarnings = { today: string; days: { date: string; items: { ticker?: string; symbol?: string; callType?: string | null; time?: string | null }[] }[] };

function useNextEarnings(ticker: string, enabled: boolean) {
  const q = useQuery({
    queryKey: ["fund-bar-earnings-upcoming"],
    queryFn: () => http.get<UpcomingEarnings>("/api/earnings/upcoming?days=10&limit=60").catch(() => null),
    enabled,
    staleTime: STALE.static,
    retry: false,
  });
  return useMemo(() => {
    const data = q.data;
    if (!data?.days) return null;
    const t = ticker.toUpperCase();
    for (const [i, d] of data.days.entries()) {
      const hit = d.items?.find((it) => (it.ticker ?? it.symbol ?? "").toUpperCase() === t);
      if (hit) return { date: d.date, tradingDaysAway: i, timing: hit.callType ?? hit.time ?? null };
    }
    return { date: null as string | null, tradingDaysAway: null as number | null, timing: null as string | null };
  }, [q.data, ticker]);
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/* ---------- formatting ---------- */

function fmtText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s !== "NaN" && s !== "undefined" && s !== "null" ? s : null;
}

function gapRisk(avg: number): { label: string; tone: Tone } {
  const t = marketWidgetsI18n.t;
  if (avg >= 3) return { label: t("fund.risk.high"), tone: "down" };
  if (avg >= 1.25) return { label: t("fund.risk.mid"), tone: "warn" };
  return { label: t("fund.risk.low"), tone: "up" };
}

/* ---------- UI ---------- */

function Stat({ label, value, sub, tone = "neutral", title }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; title?: string }) {
  return (
    <div
      className="flex min-w-0 flex-col rounded-xl bg-[var(--glass-bg)] px-2.5 py-1.5"
      title={title}
    >
      <span className="truncate text-2xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "truncate text-sm font-semibold tabular-nums",
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-[hsl(var(--chart-3))]" : "text-foreground",
        )}
      >
        {value ?? "—"}
      </span>
      {sub && <span className="truncate text-2xs tabular-nums text-muted-foreground">{sub}</span>}
    </div>
  );
}

export function TickerFundamentalsBar({ ticker, onLoaded, className = "", autoFetch = true, showRisk = true }: Props) {
  const [data, setData] = useState<TickerFundamentals | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastFetchedRef = useRef<string>("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Request versioning to defeat race conditions when user types rapidly
  const reqIdRef = useRef(0);
  const currentTickerRef = useRef<string>(ticker);

  useEffect(() => { currentTickerRef.current = ticker; }, [ticker]);

  async function load(t: string, force = false) {
    if (!t) return;
    const myReqId = ++reqIdRef.current;
    const requestedTicker = t;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTickerFundamentals(requestedTicker, force);
      if (myReqId !== reqIdRef.current) return;
      if (currentTickerRef.current !== requestedTicker) return;
      if (result?.ticker && result.ticker !== requestedTicker) return;
      if (!result) { setError(marketWidgetsI18n.t("fund.noData")); setData(null); lastFetchedRef.current = ""; return; }
      setData(result);
      lastFetchedRef.current = requestedTicker;
      onLoaded?.(result);
    } catch (e: any) {
      if (myReqId === reqIdRef.current) {
        setError(e?.message || marketWidgetsI18n.t("fund.loadFailed"));
        lastFetchedRef.current = "";
      }
    } finally {
      if (myReqId === reqIdRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!autoFetch || !ticker || ticker.length < 1) {
      if (!ticker) { setData(null); setError(null); }
      return;
    }
    if (lastFetchedRef.current === ticker) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(ticker), 700);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, autoFetch]);

  // Market data for risk (price / ATR% / overnight gaps / earnings) — debounced, cached by react-query.
  const sym = useDebounced(ticker.trim().toUpperCase(), 700);
  const symOk = showRisk && autoFetch && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym) && sym === ticker.trim().toUpperCase();
  const quoteQ = useQuery({
    queryKey: ["fund-bar-quote", sym],
    queryFn: () => http.get<Quote>(`/api/stockdata/quote?symbol=${encodeURIComponent(sym)}`).catch(() => null),
    enabled: symOk,
    staleTime: STALE.short,
    retry: false,
  });
  const barsQ = useQuery({
    queryKey: ["fund-bar-daily", sym],
    queryFn: async () => {
      const r = await http.get<{ candles: Candle[] }>(`/api/stockdata/chart?symbol=${encodeURIComponent(sym)}&range=3mo&interval=1d`).catch(() => null);
      return r?.candles ? gapStats(r.candles) : null;
    },
    enabled: symOk,
    staleTime: STALE.static,
    retry: false,
  });
  const earnings = useNextEarnings(sym, symOk);

  if (!ticker) return null;
  const t = marketWidgetsI18n.t;
  const shown = data && (!data.ticker || data.ticker.toUpperCase() === ticker.toUpperCase()) ? data : null;
  const quote = symOk ? quoteQ.data ?? null : null;
  const gaps = symOk ? barsQ.data ?? null : null;
  const price = quote?.price ?? null;
  const atr = quote?.atr ?? shown?.atr ?? null;
  const atrPct = price && atr ? (atr / price) * 100 : gaps?.atrPct ?? null;
  const risk = gaps ? gapRisk(gaps.avgAbsGap) : null;
  const earningsSoon = earnings?.tradingDaysAway != null && earnings.tradingDaysAway <= 5;
  const busy = loading || quoteQ.isFetching || barsQ.isFetching;

  return (
    <section
      aria-label={t("fund.aria", { ticker })}
      className={cn("rounded-2xl border border-[var(--field-border)] bg-[var(--glass-bg)] p-3", className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary">{ticker.toUpperCase()}</span>
        {shown?.longName ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
            <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate text-foreground/90">{shown.longName}</span>
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {shown?.sector && <Pill tone="neutral" className="text-2xs">{shown.sector}</Pill>}
        {price != null && (
          <span className="flex items-center gap-1.5 text-sm font-semibold tabular-nums text-foreground">
            ${price.toFixed(price < 10 ? 3 : 2)}
            {quote?.change != null && <Pill tone={toneOf(quote.change)} className="text-2xs">{fmtPct(quote.change)}</Pill>}
          </span>
        )}
        <button
          type="button"
          onClick={() => { load(ticker, true); quoteQ.refetch(); barsQ.refetch(); }}
          disabled={busy}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          title={t("fund.refreshTitle")}
          aria-label={t("fund.refreshAria", { ticker })}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
        </button>
      </div>

      {error && !shown && !quote && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">{error}</p>
      )}

      {loading && !shown && !error ? (
        <div className="mt-2.5 grid grid-cols-3 gap-1.5 sm:grid-cols-6" role="status" aria-label={t("fund.loading")}>
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-11 rounded-xl" />)}
        </div>
      ) : (shown || quote || gaps) ? (
        <div className="mt-2.5 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          <Stat label={t("fund.marketCap")} value={fmtText(shown?.marketCap)} />
          <Stat label={t("fund.float")} value={fmtText(shown?.float)} sub={shown?.shortInterest != null ? `SI ${fmtNum(shown.shortInterest, 1)}%` : undefined} />
          <Stat
            label={t("fund.avgVolume")}
            value={fmtText(shown?.averageDailyVolume)}
            sub={(quote?.relativeVolume ?? shown?.relativeVolume) != null ? `rVol ${fmtNum(quote?.relativeVolume ?? shown?.relativeVolume, 2)}` : undefined}
            tone={(quote?.relativeVolume ?? 0) >= 2 ? "up" : "neutral"}
          />
          <Stat
            label={t("fund.atr")}
            value={atr != null ? `$${fmtNum(atr, 2)}` : null}
            sub={atrPct != null ? t("fund.atrPct", { value: atrPct.toFixed(1) }) : shown?.beta != null ? `β ${fmtNum(shown.beta, 2)}` : undefined}
            title={t("fund.atrTitle")}
          />
          <Stat
            label={t("fund.avgGap")}
            value={gaps ? `${gaps.avgAbsGap.toFixed(2)}%` : null}
            sub={gaps ? t("fund.maxGap", { value: gaps.maxAbsGap.toFixed(1) }) : undefined}
            tone={risk?.tone ?? "neutral"}
            title={t("fund.gapTitle")}
          />
          <Stat
            label={t("fund.earnings")}
            value={earnings?.date ? fmtDate(earnings.date, "dayMonth") : null}
            sub={earnings?.date ? [earnings.tradingDaysAway === 0 ? t("fund.today") : t("fund.inDays", { count: earnings.tradingDaysAway ?? 0 }), earnings.timing].filter(Boolean).join(" · ") : earnings ? t("fund.notInCalendar") : undefined}
            tone={earningsSoon ? "warn" : "neutral"}
          />
        </div>
      ) : null}

      {(risk || earningsSoon) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          {risk && gaps && (
            <Pill tone={risk.tone} className="gap-1">
              <Moon className="h-3 w-3" aria-hidden="true" />
              {t("fund.overnightRisk", { level: risk.label })}
              {gaps.bigGapDays > 0 && <span className="opacity-90">{t("fund.bigGaps", { count: gaps.bigGapDays, total: gaps.sessions })}</span>}
            </Pill>
          )}
          {earningsSoon && (
            <Pill tone="warn" className="gap-1">
              <CalendarClock className="h-3 w-3" aria-hidden="true" />
              {earnings?.tradingDaysAway === 0 ? t("fund.earningsSoonToday") : t("fund.earningsSoon", { count: earnings?.tradingDaysAway ?? 0 })}
            </Pill>
          )}
        </div>
      )}
    </section>
  );
}
