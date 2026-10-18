/**
 * Big 7 — mega-cap context screen for a US intraday trader.
 *
 * Market tone (risk-on / risk-off) → 7 compact tiles → leadership vs QQQ (RS, gap/premarket, time-of-day
 * RVOL, VWAP, nearest levels, correlation, contribution to QQQ) → own results on these tickers →
 * catalysts of the week. A tile or row opens the detail sheet with the chart and levels.
 *
 * Data: 5-minute extended-hours candles from the server cache (past days stored, today refreshed every
 * 5 min) — re-polled every 3 min only in premarket/regular hours; quotes every 60 s only during the
 * regular session; daily stats once per 20 min. Nothing polls on a closed session.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useListBig7Tickers } from "@workspace/api-client-react";
import type { Big7Ticker } from "@workspace/api-client-react";
import { AlertTriangle, Flame, Layers, Loader2, Plus, RefreshCw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Page, PageHeader, UpdatedAgo, usePersistentState } from "@/components/ds";
import { WriteOnly, useAuth } from "@/contexts/auth-context";
import { cn } from "@/lib/utils";
import { TickerTile, TileSkeleton } from "@/components/big7/TickerTile";
import { ToneBar } from "@/components/big7/ToneBar";
import { LeadershipTable } from "@/components/big7/LeadershipTable";
import { MyStatsPanel, type StatsPeriod } from "@/components/big7/MyStatsPanel";
import { DetailSheet } from "@/components/big7/DetailSheet";
import { CatalystDialog, CatalystSheet, CatalystWeek, emptyDraft, type CatalystDraft } from "@/components/big7/catalysts";
import { TickerManagerSheet, useSeedBig7 } from "@/components/big7/TickerManagerSheet";
import {
  useAutoEarnings, useBig7Today, useCatalysts, useGapRisk, useMyStats, useNow, useQuotes, useSessionBars,
} from "@/components/big7/use-big7";
import { DEFAULT_BIG7, lsRaw, lsRawSet, mergeCatalysts, type BoardTicker, type MergedCatalyst } from "@/components/big7/lib";
import { big7I18n } from "@/i18n/ns/big7";
import { commonI18n } from "@/i18n/ns/common";
import {
  boardAgg, buildRow, buildSnap, marketTone, phaseOf, referenceSession, windowStart, type Big7Row, type SessionSnap,
} from "@/components/big7/context";
import { nextEarnings } from "@/components/big7/ui";
import { fmtDate } from "@/lib/format";

const BENCH = ["QQQ", "SPY"] as const;
/** Max symbols that get intraday bars (board + hot); keeps the server/Yahoo load bounded. */
const MAX_BAR_SYMBOLS = 14;

function isTypingTarget(el: EventTarget | null) {
  const n = el as HTMLElement | null;
  if (!n) return false;
  const tag = n.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || n.isContentEditable;
}

const sessionLabel = (day: string) => fmtDate(day, "weekdayDayMonth").replace(/\.$/, "");

export default function Big7() {
  const { t } = big7I18n.useT();
  const { canEdit } = useAuth();
  const now = useNow(60_000);

  // Session the board describes and whether it is live.
  const nowDate = useMemo(() => new Date(now), [now]);
  const session = referenceSession(nowDate);
  const sessionPhase = phaseOf(session, nowDate);
  const live = sessionPhase === "pre" || sessionPhase === "rth";
  const from = windowStart(session, 3);

  const { data: tickers = [], isLoading: tickersLoading, isError: tickersError, error: tickersErr, refetch: refetchTickers } = useListBig7Tickers();
  const { seed, seeding } = useSeedBig7();

  // Hot list: per day, local (managed in the ticker sheet). Rolls over at the NY date change in an open tab.
  const today = useBig7Today();
  const HOT_KEY = `big7_hot_${today}`;
  const readHot = (key: string): string[] => {
    try {
      const v = JSON.parse(lsRaw(key) || "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch { return []; }
  };
  const [hotSymbols, setHotSymbols] = useState<string[]>(() => readHot(HOT_KEY));
  const [hotKeyLoaded, setHotKeyLoaded] = useState(HOT_KEY);
  if (hotKeyLoaded !== HOT_KEY) { setHotKeyLoaded(HOT_KEY); setHotSymbols(readHot(HOT_KEY)); }
  const saveHot = useCallback((syms: string[]) => {
    const unique = [...new Set(syms.map((s) => s.toUpperCase()))];
    setHotSymbols(unique);
    lsRawSet(HOT_KEY, JSON.stringify(unique));
  }, [HOT_KEY]);

  const core: BoardTicker[] = useMemo(
    () => (tickers as Big7Ticker[])
      .filter((t) => t.groupName === "core")
      .map((t) => ({ symbol: t.symbol, name: t.name, exchange: t.exchange, group: "core" as const, id: t.id, position: t.position })),
    [tickers],
  );
  const hot: BoardTicker[] = useMemo(
    () => hotSymbols.filter((s) => !core.some((c) => c.symbol === s)).map((s, i) => ({ symbol: s, name: s, exchange: "", group: "hot" as const, id: -1, position: 1000 + i })),
    [hotSymbols, core],
  );
  const board = useMemo(() => [...core, ...hot], [core, hot]);
  const boardSymbols = useMemo(() => board.map((t) => t.symbol), [board]);

  // ── data ────────────────────────────────────────────────────────────────
  const barSymbols = useMemo(
    () => Array.from(new Set([...BENCH, ...boardSymbols])).slice(0, MAX_BAR_SYMBOLS),
    [boardSymbols],
  );
  const bars = useSessionBars(board.length ? barSymbols : [], from, session, live);
  const quoteSymbols = useMemo(() => Array.from(new Set([...boardSymbols, ...BENCH])).slice(0, 50), [boardSymbols]);
  const quotesQ = useQuotes(board.length ? quoteSymbols : [], sessionPhase === "rth");
  const quotes = useMemo(() => quotesQ.data ?? {}, [quotesQ.data]);
  const gapQ = useGapRisk(boardSymbols.slice(0, 30));
  const gap = gapQ.data ?? null;
  const catalystsQ = useCatalysts();
  const autoEarnings = useAutoEarnings(boardSymbols);
  const merged = useMemo(() => mergeCatalysts(catalystsQ.data ?? [], autoEarnings.data), [catalystsQ.data, autoEarnings.data]);

  // ── model ───────────────────────────────────────────────────────────────
  const snaps = useMemo(() => {
    const m: Record<string, SessionSnap | null> = {};
    for (const s of barSymbols) m[s] = buildSnap(bars.data[s]?.candles ?? []);
    return m;
    // `bars.version` changes whenever any symbol's data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars.version, barSymbols]);

  const effectiveDay = snaps.QQQ?.day ?? session;
  const phase = phaseOf(effectiveDay, nowDate);

  const model = useMemo(() => {
    const bench = (s: "QQQ" | "SPY") => buildRow({ symbol: s, snap: snaps[s] ?? null, quote: quotes[s], stats: gap?.benchmarks[s] ?? undefined, phase, qqq: { snap: null, chg: null } });
    const qqq = bench("QQQ");
    const spy = bench("SPY");
    const rows: Big7Row[] = board.map((t) =>
      buildRow({ symbol: t.symbol, snap: snaps[t.symbol] ?? null, quote: quotes[t.symbol], stats: gap?.symbols[t.symbol], phase, qqq: { snap: snaps.QQQ ?? null, chg: qqq.chg } }),
    );
    const coreSet = new Set(core.map((c) => c.symbol));
    const agg = boardAgg(rows.filter((r) => coreSet.has(r.symbol)), qqq.chg);
    const sma20 = gap?.benchmarks.QQQ?.sma20 ?? null;
    const tone = marketTone({
      qqqChg: qqq.chg, spyChg: spy.chg, qqqVwapDist: qqq.vwapDist,
      qqqAboveSma20: sma20 != null && qqq.price != null ? qqq.price > sma20 : null,
      agg, phase,
    });
    return { qqq, spy, rows, agg, tone };
  }, [snaps, quotes, gap, phase, board, core]);

  const rowBySymbol = useMemo(() => new Map(model.rows.map((r) => [r.symbol, r])), [model.rows]);
  const coreRows = useMemo(() => core.map((t) => rowBySymbol.get(t.symbol)).filter((r): r is Big7Row => !!r), [core, rowBySymbol]);
  const hotRows = useMemo(() => hot.map((t) => rowBySymbol.get(t.symbol)).filter((r): r is Big7Row => !!r), [hot, rowBySymbol]);
  const earningsBy = useMemo(() => {
    const m: Record<string, ReturnType<typeof nextEarnings>> = {};
    for (const s of boardSymbols) m[s] = nextEarnings(s, merged);
    return m;
  }, [boardSymbols, merged]);

  // Own results (the server scopes to the signed-in trader); the all-time query decides whether the block exists.
  const [period, setPeriod] = usePersistentState<StatsPeriod>("big7.statsPeriod", "90");
  const myAll = useMyStats(boardSymbols, 0, null);
  const my90 = useMyStats(boardSymbols, 90, null);
  const myShown = period === "0" ? myAll.data : my90.data;
  const hasMyTrades = (myAll.data?.total.n ?? 0) > 0;
  const myBy = useMemo(() => new Map((myAll.data?.tickers ?? []).map((t) => [t.ticker, t])), [myAll.data]);

  // ── sheets / dialogs ────────────────────────────────────────────────────
  const [openSym, setOpenSym] = useState<string | null>(null);
  const openRow = openSym ? rowBySymbol.get(openSym) ?? null : null;
  const step = useCallback((dir: 1 | -1) => {
    if (!boardSymbols.length) return;
    const i = openSym ? boardSymbols.indexOf(openSym) : -1;
    setOpenSym(boardSymbols[(i + dir + boardSymbols.length) % boardSymbols.length]);
  }, [boardSymbols, openSym]);

  const [managerOpen, setManagerOpen] = useState(false);
  const [catSheetOpen, setCatSheetOpen] = useState(false);
  const [catDraft, setCatDraft] = useState<CatalystDraft | null>(null);
  const addCatalyst = useCallback((p: Partial<CatalystDraft> = {}) => setCatDraft(emptyDraft(p)), []);
  const editCatalyst = useCallback((c: MergedCatalyst) => {
    if (c.id == null) return;
    setCatDraft({ id: c.id, ticker: c.ticker, date: c.date, type: c.type, description: c.description ?? "", impact: c.impact });
  }, []);

  // Keyboard: 1–9 open a ticker, C catalyst, T tickers. Arrows inside the sheet are handled there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const k = e.key;
      if (/^[1-9]$/.test(k)) { const s = boardSymbols[Number(k) - 1]; if (s) setOpenSym(s); }
      else if ((k === "c" || k === "C") && canEdit) { e.preventDefault(); addCatalyst(); }
      else if ((k === "t" || k === "T") && canEdit) { e.preventDefault(); setManagerOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [boardSymbols, canEdit, addCatalyst]);

  const coreEmpty = !tickersLoading && !tickersError && core.length === 0;
  const dataLoading = tickersLoading || (bars.loading && !snaps.QQQ);
  const cols = Math.min(8, Math.max(1, coreRows.length || 7));
  const refreshing = bars.fetching || quotesQ.isFetching;

  const tileGrid = (rows: Big7Row[], offset: number, hotGroup = false) => (
    <div
      className="grid grid-cols-2 gap-[var(--grid-gap)] @min-[672px]:grid-cols-4 @min-[1200px]:grid-cols-[repeat(var(--cols),minmax(0,1fr))]"
      style={{ ["--cols" as string]: String(hotGroup ? Math.max(cols, 7) : cols) }}
    >
      {rows.map((r, i) => (
        <TickerTile key={r.symbol} row={r} hot={hotGroup} earnings={earningsBy[r.symbol] ?? null} index={offset + i} onOpen={setOpenSym} />
      ))}
    </div>
  );

  return (
    <Page>
      <PageHeader
        title="Big 7"
        icon={Star}
        description={t("page.description")}
        meta={
          board.length > 0 ? (
            <>
              <span className="tabular-nums">{t("page.session", { day: sessionLabel(effectiveDay), phase: t(`page.phase.${phase}`) })}</span>
              {bars.updatedAt > 0 && <UpdatedAgo at={bars.updatedAt} />}
            </>
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("page.refresh")}
              title={t("page.refresh")}
              onClick={() => { void bars.refetch(); void quotesQ.refetch(); }}
              disabled={refreshing || !board.length}
            >
              <RefreshCw className={cn(refreshing && "motion-safe:animate-spin")} />
            </Button>
            <WriteOnly>
              <Button variant="outline" size="sm" onClick={() => setManagerOpen(true)} title={t("page.keyT")}>
                <Layers /> {t("page.tickers")} <span className="tabular-nums text-muted-foreground">{board.length}</span>
              </Button>
              <Button size="sm" onClick={() => addCatalyst()} title={t("page.keyC")}>
                <Plus /> {t("page.catalyst")}
              </Button>
            </WriteOnly>
          </>
        }
      />

      {tickersError && !tickersLoading && (
        <div role="alert" className="glass-panel flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3">
          <span className="flex min-w-0 items-center gap-2 text-sm text-down">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {tickersErr instanceof Error && tickersErr.message ? t("page.loadFailedWith", { error: tickersErr.message }) : t("page.loadFailed")}
          </span>
          <Button size="sm" variant="outline" onClick={() => refetchTickers()}><RefreshCw /> {commonI18n.t("actions.retry")}</Button>
        </div>
      )}

      {coreEmpty && (
        <div className="glass-panel rounded-2xl">
          <EmptyState
            icon={Star}
            title={t("page.emptyTitle")}
            description={t("page.emptyText", { list: DEFAULT_BIG7.map((d) => d.symbol).join(", ") })}
            action={
              canEdit ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={() => seed([])} disabled={seeding}>
                    {seeding ? <Loader2 className="animate-spin" /> : <Star />} {t("page.seed")}
                  </Button>
                  <Button variant="outline" onClick={() => setManagerOpen(true)}><Plus /> {t("page.customList")}</Button>
                </div>
              ) : <p className="text-xs text-muted-foreground">{t("page.askCurator")}</p>
            }
          />
        </div>
      )}

      {(tickersLoading || board.length > 0) && (
        <>
          <ToneBar tone={model.tone} agg={model.agg} qqq={model.qqq} spy={model.spy} phase={phase} loading={dataLoading} />

          <section aria-label={t("page.tilesAria")} className="@container flex flex-col gap-[var(--grid-gap)]">
            {tickersLoading ? (
              <div className="grid grid-cols-2 gap-[var(--grid-gap)] @min-[672px]:grid-cols-4 @min-[1200px]:grid-cols-7" aria-busy="true" aria-label={t("page.tilesLoading")}>
                {Array.from({ length: 7 }, (_, i) => <TileSkeleton key={i} />)}
              </div>
            ) : (
              <>
                {coreRows.length > 0 && tileGrid(coreRows, 0)}
                {hotRows.length > 0 && (
                  <>
                    <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                      <Flame className="h-4 w-4 text-primary" aria-hidden="true" /> {t("page.hotToday")}
                    </h2>
                    {tileGrid(hotRows, coreRows.length, true)}
                  </>
                )}
              </>
            )}
          </section>

          <LeadershipTable rows={model.rows} loading={tickersLoading} onOpen={setOpenSym} preOpen={phase === "pre"} />

          {hasMyTrades && myShown && (
            <MyStatsPanel stats={myShown} period={period} onPeriod={setPeriod} onOpen={setOpenSym} />
          )}

          {board.length > 0 && (
            <CatalystWeek
              merged={merged}
              boardSymbols={boardSymbols}
              onSelectTicker={setOpenSym}
              onAdd={(date) => addCatalyst({ date })}
              onOpenAll={() => setCatSheetOpen(true)}
              isError={catalystsQ.isError}
              onRetry={() => catalystsQ.refetch()}
            />
          )}
        </>
      )}

      <DetailSheet
        row={openRow}
        name={board.find((t) => t.symbol === openSym)?.name}
        session={effectiveDay}
        phase={phase}
        quote={openSym ? quotes[openSym] : undefined}
        stats={openSym ? gap?.symbols[openSym] : undefined}
        merged={merged}
        mine={openSym ? myBy.get(openSym) : undefined}
        earnings={openSym ? earningsBy[openSym] ?? null : null}
        open={openRow != null}
        onOpenChange={(v) => { if (!v) setOpenSym(null); }}
        onStep={step}
        onAddCatalyst={(s) => addCatalyst({ ticker: s })}
        onEditCatalyst={editCatalyst}
      />
      <TickerManagerSheet open={managerOpen} onOpenChange={setManagerOpen} tickers={tickers as Big7Ticker[]} hotSymbols={hotSymbols} onHotChange={saveHot} />
      <CatalystSheet open={catSheetOpen} onOpenChange={setCatSheetOpen} merged={merged} onAdd={() => addCatalyst()} onEdit={editCatalyst} />
      <CatalystDialog draft={catDraft} onClose={() => setCatDraft(null)} boardSymbols={boardSymbols} />
    </Page>
  );
}
