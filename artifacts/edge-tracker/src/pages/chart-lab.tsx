/**
 * Chart workspace for one trade: /chart-lab?trade=<id>&mode=analysis|replay|training&tf=1m[&src=mine|desk]
 * or any ticker and day without a trade: /chart-lab?ticker=AAPL&date=2026-10-14
 *
 * Full-height on desktop (the chart takes the space, the page does not scroll, so the wheel always zooms the chart).
 * The header has the trade picker (search by ticker / day, recent trades), the task settings (source: own trades /
 * the desk's / any ticker-day, bar size, filters) and «Случайная задача» — a random task opened in training, picked
 * by the server only from days that have minute bars (unless «любые» is chosen). In training the header hides the
 * side, result and trader until the reveal. Mode and timeframe live in the chart toolbar and are mirrored to the URL.
 * Reads only: GET /api/trades/:id, GET /api/trades/page, GET /api/training/pool|task|trades/:id.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { CalendarDays, CandlestickChart, ChevronDown, Dices, ListChecks, Search } from "lucide-react";
import { EmptyState } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, http } from "@/lib/api/http";
import { isNotFound } from "@/lib/api/errors";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { TaskSettingsButton } from "@/components/training/TaskSettings";
import {
  TASK_RECENT_KEY, countFor, noTasksMessage, parseRecent, parseTaskSettings, pushRecent, settingsForRole, taskQuery, taskSettingsKey, taskUrl,
  type PickedTask, type PoolCounts, type TaskSettings, type TaskSource,
} from "@/lib/training-tasks";
import { WsChart, TIMEFRAMES, type ChartMode, type Execution, type Timeframe, type TradeLike, type TradeStructureDto } from "@/components/chart-engine";
import { fmtR, fmtUsd } from "@/lib/format";
import { AddToPlaybookButton } from "@/components/add-to-playbook";
import { useAuth } from "@/contexts/auth-context";
import { chartLabI18n } from "@/i18n/ns/chartLab";
import { personName } from "@/i18n";

/** `movePct`: side-aware entry → exit move, % (training payload) — the result when neither $ nor R is available. */
type TradeRow = TradeLike & { rMultiple?: number | string | null; movePct?: number | null };
type PageResp = { items?: TradeRow[] };
type TrainingTradeResp = { trade: TradeRow; executions: Execution[]; structure: TradeStructureDto | null };
type PoolResp = { source: TaskSource; counts: PoolCounts; member: boolean };
type TaskResp = { task: PickedTask; counts: PoolCounts };

const MODES: ChartMode[] = ["analysis", "replay", "training"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;


function readStored<T>(key: string, parse: (raw: string | null) => T): T {
  try { return parse(localStorage.getItem(key)); } catch { return parse(null); }
}
function store(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

/** Stable negative id for a ticker + day chart without a trade (keeps its drawings apart, never fetches fills). */
function adHocId(ticker: string, date: string): number {
  let h = 0;
  for (const ch of `${ticker}|${date}`) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return -Math.max(1, Math.abs(h));
}

/** «AAPL», «2026-10-14» or «AAPL 2026-10-14» → /api/trades/page filters. */
function searchParams(text: string): URLSearchParams {
  const p = new URLSearchParams({ limit: "40", sort: "date", dir: "desc" });
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const date = parts.find((x) => YMD.test(x));
  const rest = parts.filter((x) => x !== date).join(" ");
  if (date) p.set("date", date);
  if (rest) p.set("q", rest);
  return p;
}

const rOf = (t: TradeRow) => {
  const n = Number(t.rMultiple);
  return t.rMultiple != null && Number.isFinite(n) ? n : null;
};

/**
 * Result as the viewer may see it: $ for own trades; for others' (the API nulls their $) R, else the % move, else
 * just win / loss.
 */
function ResultText({ t }: { t: TradeRow }) {
  const { t: tl } = chartLabI18n.useT();
  const r = rOf(t);
  if (!t.redacted && t.pnl != null) return <span className={t.pnl >= 0 ? "text-up" : "text-down"}>{fmtUsd(t.pnl, { signed: true, decimals: "auto" })}</span>;
  if (r != null) return <span className={r >= 0 ? "text-up" : "text-down"}>{fmtR(r)}</span>;
  const pct = t.movePct != null && Number.isFinite(t.movePct) ? t.movePct : null;
  if (pct != null) return <span className={pct >= 0 ? "text-up" : "text-down"} title={tl("result.moveTitle")}>{pct > 0 ? "+" : pct < 0 ? "−" : ""}{Math.abs(pct).toFixed(2)}%</span>;
  const res = String(t.result ?? "").toLowerCase();
  if (res === "win") return <span className="text-up">{tl("result.win")}</span>;
  if (res === "loss") return <span className="text-down">{tl("result.loss")}</span>;
  return <span className="text-muted-foreground">—</span>;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => { const id = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(id); }, [value, ms]);
  return v;
}

function TradePicker({ label, onPick, onTickerDay }: { label: React.ReactNode; onPick: (t: TradeRow) => void; onTickerDay: (ticker: string, date: string) => void }) {
  const { t: tl } = chartLabI18n.useT();
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const q = useDebounced(text, 250);
  const list = useQuery<TradeRow[], Error>({
    queryKey: ["chart-lab", "search", q],
    queryFn: async ({ signal }) => (await http.get<PageResp>(`/api/trades/page?${searchParams(q)}`, { signal })).items ?? [],
    enabled: open,
    staleTime: 30_000,
  });
  const parts = text.trim().toUpperCase().split(/\s+/);
  const tdTicker = parts.find((x) => /^[A-Z][A-Z.\-]{0,9}$/.test(x)) ?? null;
  const tdDate = parts.find((x) => YMD.test(x)) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 min-w-0 max-w-full flex-1 justify-between gap-2 px-3 sm:flex-none" aria-label={tl("picker.aria")}>
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center gap-2 border-b border-[var(--glass-border)] px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={tl("picker.placeholder")}
            className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" aria-label={tl("picker.searchAria")}
            onKeyDown={(e) => { if (e.key === "Enter" && list.data?.[0]) { onPick(list.data[0]); setOpen(false); } }}
          />
        </div>
        {tdTicker && tdDate && (
          <button type="button" className="flex w-full items-center gap-2 border-b border-[var(--glass-border)] px-3 py-2 text-left text-sm hover:bg-[var(--glass-hover-bg)]" onClick={() => { onTickerDay(tdTicker, tdDate); setOpen(false); }}>
            <CandlestickChart className="h-4 w-4 text-primary" aria-hidden="true" /> {tl("picker.openTickerDay", { ticker: tdTicker, date: tdDate })}
          </button>
        )}
        <div className="max-h-[min(22rem,60svh)] overflow-y-auto py-1">
          {list.isLoading ? (
            <div className="flex flex-col gap-1.5 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 rounded-lg" />)}</div>
          ) : list.error ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">{tl("picker.loadFailed", { message: list.error.message })}</p>
          ) : !list.data?.length ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">{text.trim() ? tl("picker.nothing") : tl("picker.noTrades")}</p>
          ) : (
            <ul>
              {list.data.map((t) => (
                <li key={t.id}>
                  <button type="button" className="grid w-full grid-cols-[4.5rem_1fr_auto] items-center gap-2 px-3 py-1.5 text-left text-sm tabular-nums hover:bg-[var(--glass-hover-bg)]" onClick={() => { onPick(t); setOpen(false); }}>
                    <span className="font-semibold">{t.ticker}</span>
                    <span className="truncate text-xs text-muted-foreground">{t.date.slice(0, 10)} · {String(t.side ?? "").toLowerCase() === "short" ? tl("picker.short") : tl("picker.long")}{t.trader ? ` · ${personName(t.trader)}` : ""}</span>
                    <ResultText t={t} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="border-t border-[var(--glass-border)] px-3 py-1.5 text-2xs text-muted-foreground">{tl("picker.othersInR")}</p>
      </PopoverContent>
    </Popover>
  );
}

export default function ChartLabPage() {
  const { t: tl } = chartLabI18n.useT();
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = React.useMemo(() => new URLSearchParams(search), [search]);
  const tradeId = Number(params.get("trade")) || null;
  const adTicker = params.get("ticker")?.trim().toUpperCase() || null;
  const adDate = params.get("date") && YMD.test(params.get("date") as string) ? (params.get("date") as string) : null;
  const modeParam = params.get("mode");
  const mode: ChartMode = MODES.includes(modeParam as ChartMode) ? (modeParam as ChartMode) : "analysis";
  const tfParam = params.get("tf");
  const tf: Timeframe = TIMEFRAMES.includes(tfParam as Timeframe) ? (tfParam as Timeframe) : "1m";

  const setParams = React.useCallback((patch: Record<string, string | null>, replace = true) => {
    const p = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) { if (v == null) p.delete(k); else p.set(k, v); }
    if (p.get("mode") === "analysis") p.delete("mode");
    if (p.get("tf") === "1m") p.delete("tf");
    navigate(`/chart-lab${p.toString() ? `?${p}` : ""}`, { replace });
  }, [search, navigate]);

  const srcParam = params.get("src");
  const taskSource: TaskSource | undefined = srcParam === "mine" || srcParam === "desk" ? srcParam : undefined;
  const training = mode === "training";
  // Training (or a task opened from the desk): the trade, its fills and structure come from the training endpoint,
  // which also serves someone else's trade with $ / size nulled for non-staff.
  const viaTraining = tradeId != null && (training || taskSource != null);

  const trade = useQuery<TrainingTradeResp, Error>({
    queryKey: ["chart-lab", "trade", tradeId, viaTraining],
    queryFn: async () => viaTraining
      ? http.get<TrainingTradeResp>(`/api/training/trades/${tradeId}`)
      : { trade: await http.get<TradeRow>(`/api/trades/${tradeId}`), executions: [], structure: null },
    enabled: tradeId != null,
    retry: false,
    placeholderData: (prev) => (prev && prev.trade.id === tradeId ? prev : undefined),
  });

  // ── Task settings & random task ──────────────────────────────────────────
  // Stored per viewer (role + name): a guest's «тикер-день» must not stick after signing in as a member.
  const { user } = useAuth();
  const isGuest = !user || user.role === "guest";
  const settingsKey = taskSettingsKey(user?.role, user?.traderName);
  const loadSettings = React.useCallback(() => settingsForRole(readStored(settingsKey, parseTaskSettings), !isGuest), [settingsKey, isGuest]);
  const [settings, setSettings] = React.useState<TaskSettings>(loadSettings);
  const settingsKeyRef = React.useRef(settingsKey);
  React.useEffect(() => {
    if (settingsKeyRef.current === settingsKey) return;
    settingsKeyRef.current = settingsKey;
    setSettings(loadSettings());
  }, [settingsKey, loadSettings]);
  const updateSettings = React.useCallback((patch: Partial<TaskSettings>) => setSettings((s) => { const n = { ...s, ...patch }; store(settingsKeyRef.current, n); return n; }), []);
  const poolQs = taskQuery(settings);
  const pool = useQuery<PoolResp, Error>({
    queryKey: ["chart-lab", "training-pool", settingsKey, poolQs],
    queryFn: ({ signal }) => http.get<PoolResp>(`/api/training/pool?${poolQs}`, { signal }),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const member = pool.data?.member ?? true;
  // A guest cannot use trade sources: fall back to ticker-days once the server says so (never on placeholder data —
  // that may still be the previous viewer's answer).
  React.useEffect(() => {
    if (pool.data && !pool.isPlaceholderData && !pool.data.member && settings.source !== "day") updateSettings({ source: "day" });
  }, [pool.data, pool.isPlaceholderData, settings.source, updateSettings]);
  const available = countFor(pool.data?.counts, settings.res);
  // A server without /api/training (not restarted after the update) answers 404 — say so instead of «нет задач».
  const poolError = pool.isError && !pool.data
    ? (isNotFound(pool.error) ? tl("poolNotFound") : tl("poolFailed"))
    : null;
  const [picking, setPicking] = React.useState(false);
  const currentKey = tradeId != null ? `t${tradeId}` : adTicker && adDate ? `d:${adTicker}:${adDate}` : null;

  const pickRandom = React.useCallback(async () => {
    if (picking) return;
    setPicking(true);
    try {
      const recent = readStored(TASK_RECENT_KEY, parseRecent);
      const exclude = currentKey ? pushRecent(recent, currentKey) : recent;
      const { task } = await http.get<TaskResp>(`/api/training/task?${taskQuery(settings, { forTask: true, exclude })}`);
      store(TASK_RECENT_KEY, pushRecent(exclude, task.key));
      navigate(taskUrl(task, tf));
    } catch (e) {
      const notFound = isNotFound(e);
      const description = notFound
        ? noTasksMessage(settings, (e instanceof ApiError ? e.field<PoolCounts>("counts") : undefined) ?? pool.data?.counts)
        : e instanceof Error ? e.message : String(e);
      toast({ title: chartLabI18n.t("noTaskToast"), description, variant: notFound ? "default" : "destructive" });
    } finally {
      setPicking(false);
    }
  }, [picking, currentKey, settings, tf, navigate, pool.data]);

  const adHoc: TradeLike | null = React.useMemo(() => (tradeId == null && adTicker && adDate ? { id: adHocId(adTicker, adDate), ticker: adTicker, date: adDate } : null), [tradeId, adTicker, adDate]);
  const current: TradeRow | null = tradeId != null ? trade.data?.trade ?? null : adHoc;

  // Trader / side / result stay hidden in training until the reveal.
  // Keyed by task: a new task must never inherit the previous one's reveal (the chart reports false only after mount).
  const [revealedKey, setRevealedKey] = React.useState<string | null>(null);
  const onRevealChange = React.useCallback((r: boolean) => setRevealedKey(r ? currentKey : null), [currentKey]);
  const hideHints = training && (revealedKey == null || revealedKey !== currentKey);
  const label = current ? (
    <span className="inline-flex items-center gap-2 tabular-nums">
      <span className="font-semibold">{current.ticker}</span>
      <span className="text-muted-foreground">{current.date.slice(0, 10)}</span>
      {tradeId != null && !hideHints && <><span className="text-muted-foreground">{String(current.side ?? "").toLowerCase() === "short" ? tl("picker.short") : tl("picker.long")}</span><ResultText t={current} /></>}
      {tradeId != null && !hideHints && current.trader && current.redacted && <span className="hidden text-muted-foreground sm:inline">· {personName(current.trader)}</span>}
      {training && tradeId == null && <span className="hidden text-muted-foreground sm:inline">· {tl("picker.noTrade")}</span>}
    </span>
  ) : <span className="text-muted-foreground">{tl("picker.pick")}</span>;

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[var(--page-max)] flex-col gap-2 lg:-mb-[2.25rem] lg:h-[calc(100svh-6.25rem)] lg:min-h-[520px]">
      <header className="flex items-center gap-2">
        <h1 className="sr-only text-lg font-semibold tracking-tight sm:not-sr-only sm:mr-1">{training ? tl("title.training") : mode === "replay" ? tl("title.replay") : tl("title.chart")}</h1>
        <TradePicker
          label={label}
          onPick={(t) => navigate(`/chart-lab?trade=${t.id}${mode !== "analysis" ? `&mode=${mode}` : ""}${tf !== "1m" ? `&tf=${tf}` : ""}`)}
          onTickerDay={(tk, d) => navigate(`/chart-lab?ticker=${encodeURIComponent(tk)}&date=${d}${tf !== "1m" ? `&tf=${tf}` : ""}`)}
        />
        {tradeId != null && current && !hideHints && !current.redacted && (
          // Back to where an own trade is reviewed: its row in «Сделки» and the report of that day.
          <span className="flex shrink-0 items-center">
            <Button variant="ghost" size="icon" className="h-9 w-9" asChild title={tl("openInTrades")}>
              <Link href={links.trade(tradeId)} aria-label={tl("openInTradesAria")}><ListChecks className="h-4 w-4" /></Link>
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9" asChild title={tl("dayReview")}>
              <Link href={links.dayReport(current.date.slice(0, 10), current.trader && current.trader !== user?.traderName ? current.trader : undefined)} aria-label={tl("dayReview")}><CalendarDays className="h-4 w-4" /></Link>
            </Button>
          </span>
        )}
        {tradeId != null && current && !hideHints && !viaTraining && (
          <AddToPlaybookButton payload={{ name: `${current.ticker} ${current.date.slice(0, 10)}`, ticker: current.ticker, sourceType: "trade", sourceId: tradeId }} className="h-9 shrink-0" />
        )}
        <TaskSettingsButton
          settings={settings} onChange={updateSettings} counts={pool.data?.counts ?? null} member={member} loading={pool.isFetching && !pool.data} error={poolError}
          onPick={() => void pickRandom()} picking={picking}
        />
        <Button
          variant={training ? "default" : "outline"} className="h-9 shrink-0 gap-2 px-3" onClick={() => void pickRandom()} disabled={picking || (pool.data != null && !available)}
          title={pool.data && !available ? noTasksMessage(settings, pool.data.counts) : tl("randomTitle")}
        >
          <Dices className={cn("h-4 w-4", picking && "animate-spin")} aria-hidden="true" /> <span className="hidden sm:inline">{tl("random")}</span><span className="sm:hidden">{tl("randomShort")}</span>
        </Button>
      </header>

      {tradeId == null && !adHoc ? (
        <EmptyState
          icon={CandlestickChart}
          title={tl("empty.title")}
          description={tl("empty.description")}
          action={(
            <div className="flex flex-col items-center gap-1.5">
              <Button onClick={() => void pickRandom()} disabled={picking || (pool.data != null && !available)}><Dices className="mr-2 h-4 w-4" /> {tl("random")}</Button>
              {/* Why the button is off, right under it (not only in a tooltip): e.g. no own trades yet → take the desk's. */}
              {pool.data && !available && <p className="max-w-sm text-center text-xs text-[hsl(var(--chart-3))]" role="status">{noTasksMessage(settings, pool.data.counts)}</p>}
            </div>
          )}
        />
      ) : tradeId != null && trade.isLoading ? (
        <Skeleton className="min-h-[420px] flex-1 rounded-2xl" />
      ) : tradeId != null && (trade.error || !trade.data) ? (
        <EmptyState icon={CandlestickChart} title={tl("unavailable", { id: tradeId })} description={trade.error?.message ?? tl("notFound")} />
      ) : current ? (
        <WsChart
          key={`${current.id}`}
          className="lg:min-h-0 lg:flex-1"
          layout="workspace"
          trade={current}
          executions={adHoc ? [] : viaTraining ? trade.data?.executions : undefined}
          structure={viaTraining ? trade.data?.structure ?? null : undefined}
          mode={mode}
          onModeChange={(m) => setParams({ mode: m })}
          initialTimeframe={tf}
          onTimeframeChange={(t) => setParams({ tf: t })}
          onNextTask={available ? () => void pickRandom() : undefined}
          trainingSource={adHoc ? "day" : taskSource}
          onTrainingRevealChange={onRevealChange}
          showModes
        />
      ) : null}
    </div>
  );
}
