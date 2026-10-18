/**
 * WS Chart — trade analysis / replay / training chart on lightweight-charts 5 (panes + primitives).
 *
 * Layouts:
 *  - "inline" (default): toolbar, a chart of `height` px, the replay dock and (in replay / training) the side panels
 *    stacked under it — for sheets and cards.
 *  - "workspace": fills its parent (give the parent a height): toolbar on top, the chart + a right column with the
 *    position / fills / summary / training ticket, the dock under the chart. Hotkeys work page-wide.
 *
 * The chart instance is built once per (bars, timeframe, theme); cursor, overlays, drawings and the paper position are
 * pushed into it through refs, so replay stepping never rebuilds the chart. Volume is an overlay at the bottom of the
 * price pane (capped at p98 so the opening print does not flatten everything); the P&L pane is optional.
 *
 * Money: `trade.redacted` (another trader's trade, $ nulled by the API) ⇒ per-share moves and R only, never $.
 */
import * as React from "react";
import {
  createChart, CandlestickSeries, HistogramSeries, BaselineSeries, CrosshairMode,
  type IChartApi, type ISeriesApi, type UTCTimestamp, type Time, type MouseEventParams, type CandlestickData, type WhitespaceData,
  type HistogramData, type BaselineData, type AutoscaleInfo,
} from "lightweight-charts";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import type { Bar, ChartMode, Drawing, DrawingPoint, DrawingType, Execution, Timeframe, TradeLike, TradeStructureDto, TrainingResult } from "./types";
import { TIMEFRAMES, TF_LABEL, TF_SECONDS } from "./types";
import { aggregate, availableTimeframes, barSeconds, baseBarLabel } from "./lib/aggregate";
import { barIndexForTime, etDayKey, fmtEtDateTime, fmtEtDay, fmtEtTime, logicalToTime, tickMarkLabel } from "./lib/time";
import { fmtPrice, fmtUsd, localeTag } from "@/lib/format";
import { buildGeometry, type Geometry } from "./lib/geometry";
import { isOpening, positionAt } from "./lib/position";
import { DRAWING_POINTS, loadDrawings, makeDrawing, saveDrawings } from "./lib/drawings";
import { clockTick, isReplaySpeed, isReplayStart, planAdvance, replayStartIndex, sessionEndIndex, stepSpeed, type ReplaySpeed, type ReplayStart } from "./lib/replay-clock";
import {
  EMPTY_SIM, canBreakeven, idealMove, scoreTraining, simApplyBar, simBreakeven, simOrder, simSetStop, simSetTarget, suggestStop, targetAtRR,
  type SimAction, type SimState, type TrainingOutcome,
} from "./lib/training-sim";
import { buildTradeSummary } from "./lib/trade-summary";
import { capVolumes, daySpanOf, defaultViewRange, followCursor, isViewMode, type ViewMode } from "./lib/view";
import { chartI18n } from "@/i18n/ns/chart";
import { readChartTheme, type ChartTheme } from "./theme";
import { useChartData } from "./hooks/useChartData";
import { useThemeVersion } from "./hooks/useThemeVersion";
import { useTrainingHistory } from "./hooks/useTrainingHistory";
import { useStructureLayer } from "./hooks/useStructureLayer";
import { SessionShadingPrimitive } from "./primitives/SessionShadingPrimitive";
import { FillsPrimitive } from "./primitives/FillsPrimitive";
import { PositionZonePrimitive } from "./primitives/PositionZonePrimitive";
import { StopTargetPrimitive } from "./primitives/StopTargetPrimitive";
import { ExcursionPrimitive } from "./primitives/ExcursionPrimitive";
import { LevelsPrimitive, type LevelLine } from "./primitives/LevelsPrimitive";
import { VwapBandsPrimitive } from "./primitives/VwapBandsPrimitive";
import { VolumeProfilePrimitive } from "./primitives/VolumeProfilePrimitive";
import { EventMarkersPrimitive } from "./primitives/EventMarkersPrimitive";
import { DrawingsPrimitive } from "./primitives/DrawingsPrimitive";
import { SimPositionPrimitive } from "./primitives/SimPositionPrimitive";
import { ChartLegend, type LegendInfo } from "./ui/ChartLegend";
import { ReplayDock, type ReplayMark } from "./ui/ReplayControls";
import { ChartToolbar, DEFAULT_OVERLAYS, DEFAULT_PANES, TRADE_OVERLAYS, type HotkeyRow, type Overlays, type PaneToggles } from "./ui/ChartToolbar";
import { FillLog, PositionCard, SummaryCard } from "./ui/TradePanels";
import { TrainingHistoryCard, TrainingOutcomeCard, TrainingTicket, type DecisionRow, type TicketState } from "./ui/TrainingPanel";
import { FillsKey } from "./ui/FillsKey";

export type WsChartProps = {
  trade: TradeLike;
  /** Fills; when omitted they are fetched from GET /api/trades/:id/executions. */
  executions?: Execution[];
  /** Recognised structure that came with `executions` (e.g. from GET /api/training/trades/:id). */
  structure?: TradeStructureDto | null;
  /** Training: where the task came from (stored with the attempt). A trade with id <= 0 is a ticker-day task. */
  trainingSource?: "mine" | "desk" | "day";
  /** Training: reports when the real trade is revealed / hidden again («Ещё раз»), so the page can show its trader. */
  onTrainingRevealChange?: (revealed: boolean) => void;
  /** Target price (e.g. from the linked trade idea). */
  target?: number | null;
  initialTimeframe?: Timeframe;
  /** Initial mode (the toolbar switches it; `onModeChange` reports the switch). */
  mode?: ChartMode;
  onModeChange?: (m: ChartMode) => void;
  onTimeframeChange?: (tf: Timeframe) => void;
  /** Called once per finished training attempt (also stored in this browser's history). */
  onTrainingResult?: (result: TrainingResult) => void;
  /** «Следующая задача» after a training attempt (the page picks another trade). */
  onNextTask?: () => void;
  /** Inline layout only: chart height in px. */
  height?: number;
  className?: string;
  /** Trading days of context loaded before the entry day (default 2; dropped when it would cost resolution). */
  contextDays?: number;
  /** Replay starts this many bars before the entry until the viewer picks a start preset. */
  startBarsBefore?: number;
  layout?: "inline" | "workspace";
  /** Hotkeys without focusing the chart first (default: on in the workspace layout). */
  globalHotkeys?: boolean;
  /** Show the analysis / replay / training switch in the toolbar (default true). */
  showModes?: boolean;
  /** Extra content at the bottom of the side column. */
  asideExtra?: React.ReactNode;
};

type ChartRefs = {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram"> | null;
  pnl: ISeriesApi<"Baseline"> | null;
  prims: {
    session: SessionShadingPrimitive; fills: FillsPrimitive; zone: PositionZonePrimitive; stopTarget: StopTargetPrimitive;
    excursion: ExcursionPrimitive; levels: LevelsPrimitive; vwap: VwapBandsPrimitive; avwap: VwapBandsPrimitive; profile: VolumeProfilePrimitive;
    events: EventMarkersPrimitive; drawings: DrawingsPrimitive; sim: SimPositionPrimitive;
  };
  full: CandlestickData<UTCTimestamp>[];
  ws: WhitespaceData<UTCTimestamp>[];
  volFull: HistogramData<UTCTimestamp>[];
  pnlFull: BaselineData<UTCTimestamp>[];
  pnlByTime: Map<number, BaselineData<UTCTimestamp>>;
  /** Last applied reveal limit (−1 = nothing, −2 = force a full push). */
  revealed: number;
  theme: ChartTheme;
};

const OVERLAYS_KEY = "ws-chart:overlays:v3";
const PANES_KEY = "ws-chart:panes:v2";
const REPLAY_KEY = "ws-chart:replay:v2";
/** Default zoom of a trade: the whole day (owner: «график должен полностью показываться за тот день»). */
const VIEW_KEY = "ws-chart:view:v1";
const TICKET_KEY = "ws-chart:ticket:v1";
type ReplayPrefs = { speed: ReplaySpeed; start: ReplayStart; trainStart: ReplayStart; pauseOnFills: boolean };
const DEFAULT_REPLAY: ReplayPrefs = { speed: 5, start: "15", trainStart: "30", pauseOnFills: true };

function loadJson(key: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(localStorage.getItem(key) ?? "null");
    return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
  } catch { return null; }
}
function loadReplayPrefs(): ReplayPrefs {
  const p = loadJson(REPLAY_KEY);
  if (!p) return DEFAULT_REPLAY;
  return {
    speed: isReplaySpeed(p.speed) ? (Number(p.speed) as ReplaySpeed) : DEFAULT_REPLAY.speed,
    start: isReplayStart(p.start) ? p.start : DEFAULT_REPLAY.start,
    trainStart: isReplayStart(p.trainStart) ? p.trainStart : DEFAULT_REPLAY.trainStart,
    pauseOnFills: typeof p.pauseOnFills === "boolean" ? p.pauseOnFills : DEFAULT_REPLAY.pauseOnFills,
  };
}
function loadBools<T extends object>(key: string, defaults: T): T {
  const p = loadJson(key);
  if (!p) return defaults;
  const out = { ...defaults } as Record<string, unknown>;
  for (const k of Object.keys(defaults)) if (typeof p[k] === "boolean") out[k] = p[k];
  return out as T;
}
function loadTicket(): TicketState {
  const p = loadJson(TICKET_KEY);
  const qty = Number(p?.qty);
  const rr = Number(p?.targetRR);
  return {
    qty: Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 100,
    autoStop: typeof p?.autoStop === "boolean" ? p.autoStop : true,
    stopText: "",
    targetRR: rr === 1 || rr === 2 || rr === 3 ? rr : 0,
    targetText: "",
  };
}
function save(key: string, value: object): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const STRETCH = { price: 76, pnl: 24 } as const;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
};

export function WsChart({
  trade, executions, structure, trainingSource, onTrainingRevealChange, target, initialTimeframe = "1m", mode: modeProp = "analysis", onModeChange, onTimeframeChange, onTrainingResult, onNextTask,
  height = 520, className, contextDays = 2, startBarsBefore, layout = "inline", globalHotkeys, showModes = true, asideExtra,
}: WsChartProps) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const refs = React.useRef<ChartRefs | null>(null);
  const themeVersion = useThemeVersion();
  const data = useChartData(trade, { executions, structure, contextDays });
  const redacted = !!trade.redacted;
  const history = useTrainingHistory();

  // ── Timeframe & bars ─────────────────────────────────────────────────────
  const timeframes = React.useMemo(() => availableTimeframes(data.baseSec, TIMEFRAMES), [data.baseSec]);
  const [tfState, setTfState] = React.useState<Timeframe>(initialTimeframe);
  const tf: Timeframe = timeframes.includes(tfState) ? tfState : timeframes[0] ?? "D";
  const setTf = React.useCallback((t: Timeframe) => { setTfState(t); onTimeframeChange?.(t); }, [onTimeframeChange]);
  const useDaily = tf === "D";
  const requestDaily = data.daily.request;
  React.useEffect(() => { if (useDaily) requestDaily(); }, [useDaily, requestDaily]);
  const intraday = !useDaily && data.baseSec < 86400;
  const barSec = useDaily ? 86400 : barSeconds(tf, data.baseSec);
  const bars: Bar[] = React.useMemo(() => {
    if (useDaily && data.daily.bars.length) return data.daily.bars.map((b) => ({ ...b, n: 1 }));
    return aggregate(data.bars, data.baseSec, tf);
  }, [data.bars, data.baseSec, data.daily.bars, tf, useDaily]);
  const last = Math.max(0, bars.length - 1);

  const geo: Geometry = React.useMemo(() => buildGeometry({
    bars, barSec, baseBars: tf === "1m" || data.baseSec >= TF_SECONDS[tf] ? bars : data.bars, baseSec: data.baseSec,
    trade, executions: data.executions, prevClose: data.prevClose, dateKey: data.dateKey, target, events: data.events, intraday, structure: data.structure,
  }), [bars, barSec, data.bars, data.baseSec, data.executions, data.prevClose, data.dateKey, data.events, data.structure, trade, target, intraday, tf]);
  const hasTrade = geo.entryIdx != null;

  // ── Mode ─────────────────────────────────────────────────────────────────
  const [mode, setModeState] = React.useState<ChartMode>(modeProp);
  React.useEffect(() => { setModeState(modeProp); }, [modeProp, trade.id]);
  const setMode = React.useCallback((m: ChartMode) => { setModeState(m); onModeChange?.(m); }, [onModeChange]);
  const replayActive = mode !== "analysis";
  const training = mode === "training";

  // ── Replay state ─────────────────────────────────────────────────────────
  const [prefs, setPrefs] = React.useState<ReplayPrefs>(loadReplayPrefs);
  const updatePrefs = React.useCallback((patch: Partial<ReplayPrefs>) => setPrefs((p) => { const n = { ...p, ...patch }; save(REPLAY_KEY, n); return n; }), []);
  const speed = prefs.speed;
  const [startChosen, setStartChosen] = React.useState(startBarsBefore == null);
  const startPreset = training ? prefs.trainStart : prefs.start;
  const dayKey = data.dateKey;
  const startIdx = React.useMemo(() => {
    if (!bars.length) return 0;
    if (!intraday) return Math.max(0, (geo.entryIdx ?? last) - 20);
    if (!startChosen && startBarsBefore != null && geo.entryIdx != null) return Math.max(0, geo.entryIdx - startBarsBefore);
    return replayStartIndex(bars, startPreset, { dayKey, entryIdx: geo.entryIdx, entryTime: geo.entryTime });
  }, [bars, intraday, geo.entryIdx, geo.entryTime, last, startChosen, startBarsBefore, startPreset, dayKey]);
  const sessionEnd = React.useMemo(() => (intraday && bars.length ? sessionEndIndex(bars, dayKey) : last), [intraday, bars, dayKey, last]);

  // Training paper position.
  const [sim, setSim] = React.useState<SimState>(EMPTY_SIM);
  const [outcome, setOutcome] = React.useState<TrainingOutcome | null>(null);
  const [idealT, setIdealT] = React.useState<{ from: number; to: number; side: "long" | "short" } | null>(null);
  const revealed = training && outcome != null;
  /** Training before the reveal: everything about the real trade is hidden. */
  const hideReal = training && !revealed;
  const revealAll = !replayActive || revealed;
  const revealRef = React.useRef(onTrainingRevealChange);
  revealRef.current = onTrainingRevealChange;
  React.useEffect(() => { revealRef.current?.(revealed); }, [revealed]);

  const [cursorTime, setCursorTime] = React.useState<number | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const cursorIdx = React.useMemo(() => {
    if (!replayActive || cursorTime == null || !bars.length) return null;
    let i = barIndexForTime(bars, cursorTime, barSec);
    // Training on a coarser timeframe: never show a bar that is not finished yet at the cursor time.
    if (hideReal && i > 0 && bars[i].t + barSec > cursorTime + data.baseSec) i -= 1;
    return clamp(i, startIdx, last);
  }, [replayActive, cursorTime, bars, barSec, hideReal, data.baseSec, startIdx, last]);
  const structureLayer = useStructureLayer(geo, hideReal, revealAll ? null : cursorIdx);
  const cursorRef = React.useRef<number | null>(null);
  if (!playing) cursorRef.current = cursorIdx;
  const limitIdx = training ? sessionEnd : last;
  const setCursor = React.useCallback((idx: number) => {
    if (!bars.length) return;
    const i = clamp(idx, startIdx, last);
    cursorRef.current = i;
    setCursorTime(bars[i].t);
  }, [bars, startIdx, last]);

  // (Re)start whenever the mode, the trade or the start point changes.
  const simAppliedRef = React.useRef(0);
  const sessionKey = `${trade.id}:${mode}:${startIdx}:${bars.length > 0}`;
  const initialisedFor = React.useRef<string | null>(null);
  const resetSession = React.useCallback(() => {
    setPlaying(false); setSim(EMPTY_SIM); setOutcome(null); setIdealT(null);
    simAppliedRef.current = startIdx;
    if (bars.length) { cursorRef.current = startIdx; setCursorTime(bars[startIdx].t); }
  }, [bars, startIdx]);
  React.useEffect(() => {
    if (!replayActive) { initialisedFor.current = null; setPlaying(false); setOutcome(null); return; }
    if (initialisedFor.current === sessionKey || !bars.length) return;
    initialisedFor.current = sessionKey;
    resetSession();
  }, [sessionKey, replayActive, bars.length, resetSession]);
  // A timeframe switch mid-play pauses (bar indices change meaning).
  React.useEffect(() => { setPlaying(false); simAppliedRef.current = cursorRef.current ?? 0; }, [barSec]);

  // Fills the viewer may see now: none of the real ones in training before the reveal.
  const visibleFills = React.useMemo(() => (hideReal ? [] : geo.fills), [geo.fills, hideReal]);
  const pauseIdx = React.useMemo(() => visibleFills.map((f) => f.idx), [visibleFills]);

  // Latest values for the play loop and chart callbacks (bound once).
  const live = React.useRef({ mode, tool: null as DrawingType | null, bars, barSec, cursorIdx, revealAll, replayActive, startIdx, speed, last, limitIdx, pauseIdx, pauseOnFills: prefs.pauseOnFills, hideReal });
  // (tool is filled in below once declared)

  // ── Play loop: a ~60 Hz timer + carried fractional bars, exact pace at any tick rate. A timer (not rAF) so it keeps
  // its pace in a background tab instead of freezing; clockTick clamps long gaps so it never jumps far.
  React.useEffect(() => {
    if (!playing) return;
    let lastTs = performance.now(), carry = 0;
    const id = window.setInterval(() => {
      const st = live.current;
      const ts = performance.now();
      const dt = ts - lastTs;
      lastTs = ts;
      const { steps, carry: c } = clockTick(carry, dt, st.speed);
      carry = c;
      if (steps <= 0) return;
      const cur = cursorRef.current ?? st.startIdx;
      const r = planAdvance(cur, steps, { last: st.last, limit: st.limitIdx, pauseOn: st.pauseOnFills && !st.hideReal ? st.pauseIdx : null });
      if (r.next !== cur && st.bars[r.next]) { cursorRef.current = r.next; setCursorTime(st.bars[r.next].t); }
      if (r.stopped) setPlaying(false);
    }, 16);
    return () => window.clearInterval(id);
  }, [playing]);

  const atLimit = cursorIdx != null && cursorIdx >= limitIdx;
  const togglePlay = React.useCallback(() => {
    if (cursorIdx == null) return;
    if (playing) { setPlaying(false); return; }
    if (atLimit) {
      if (training) return;
      setCursor(startIdx);
    }
    setPlaying(true);
  }, [cursorIdx, playing, atLimit, training, setCursor, startIdx]);
  const step = React.useCallback((delta: number) => {
    if (cursorIdx == null || (training && delta < 0) || (revealed && delta !== 0 && false)) return;
    setPlaying(false);
    setCursor(Math.min(cursorIdx + delta, limitIdx));
  }, [cursorIdx, training, revealed, setCursor, limitIdx]);
  const seek = React.useCallback((idx: number) => { if (training) return; setPlaying(false); setCursor(idx); }, [training, setCursor]);
  const nextFill = cursorIdx != null && !hideReal ? visibleFills.find((f) => f.idx > cursorIdx) ?? null : null;
  const jumpNextFill = React.useCallback(() => { if (training) return; setPlaying(false); if (nextFill) setCursor(nextFill.idx); }, [training, nextFill, setCursor]);
  const jumpEntry = React.useCallback(() => { if (training) return; setPlaying(false); if (geo.entryIdx != null) setCursor(geo.entryIdx); }, [training, geo.entryIdx, setCursor]);
  const jumpExit = React.useCallback(() => { if (training) return; setPlaying(false); if (geo.exitIdx != null) setCursor(geo.exitIdx); }, [training, geo.exitIdx, setCursor]);
  const chooseStart = React.useCallback((v: ReplayStart) => {
    setStartChosen(true);
    updatePrefs(training ? { trainStart: v } : { start: v });
  }, [updatePrefs, training]);

  // ── Training ─────────────────────────────────────────────────────────────
  const [ticket, setTicket] = React.useState<TicketState>(loadTicket);
  const updateTicket = React.useCallback((patch: Partial<TicketState>) => setTicket((t) => { const n = { ...t, ...patch }; save(TICKET_KEY, { qty: n.qty, autoStop: n.autoStop, targetRR: n.targetRR }); return n; }), []);
  // Stops are checked on every bar revealed after the order bar.
  React.useEffect(() => {
    if (!training || revealed || cursorIdx == null) return;
    if (cursorIdx <= simAppliedRef.current) { simAppliedRef.current = Math.min(simAppliedRef.current, cursorIdx); return; }
    const from = simAppliedRef.current + 1;
    simAppliedRef.current = cursorIdx;
    setSim((s) => {
      let n = s;
      for (let i = from; i <= cursorIdx && n.pos !== 0; i++) n = simApplyBar(n, bars[i], i);
      return n;
    });
  }, [cursorIdx, training, revealed, bars]);
  const placeOrder = React.useCallback((action: SimAction) => {
    if (!training || revealed || cursorIdx == null || !bars[cursorIdx] || cursorIdx >= limitIdx) return;
    setPlaying(false);
    const bar = bars[cursorIdx];
    setSim((s) => {
      let stop: number | null = null;
      let tgt: number | null = null;
      if (action === "buy" || action === "sell") {
        const signed = action === "buy" ? ticket.qty : -ticket.qty;
        const dir = Math.sign(s.pos + signed);
        // A new position (or a reversal) gets the ticket's stop; adding keeps the open one unless a stop is typed.
        const opensNew = dir !== 0 && (s.pos === 0 || Math.sign(s.pos) !== dir);
        if (dir !== 0) {
          const manual = Number(ticket.stopText.replace(",", "."));
          const manualOk = ticket.stopText.trim() !== "" && Number.isFinite(manual) && manual > 0;
          stop = !ticket.autoStop && manualOk ? manual : ticket.autoStop && opensNew ? suggestStop(bars, cursorIdx, dir as 1 | -1) : null;
          if (opensNew && ticket.targetRR > 0) tgt = targetAtRR(bar.c, stop, ticket.targetRR);
        }
      }
      return simOrder(s, { action, idx: cursorIdx, t: bar.t, price: bar.c, qty: ticket.qty, stop, target: tgt });
    });
    if (ticket.stopText && (action === "buy" || action === "sell")) updateTicket({ stopText: "" });
    simAppliedRef.current = cursorIdx;
  }, [training, revealed, cursorIdx, bars, limitIdx, ticket, updateTicket]);
  const applyStop = React.useCallback(() => {
    if (cursorIdx == null || !bars[cursorIdx]) return;
    const v = Number(ticket.stopText.replace(",", "."));
    if (!Number.isFinite(v) || v <= 0) return;
    setSim((s) => simSetStop(s, v, bars[cursorIdx].c));
    updateTicket({ stopText: "" });
  }, [cursorIdx, bars, ticket.stopText, updateTicket]);
  const applyTarget = React.useCallback(() => {
    if (cursorIdx == null || !bars[cursorIdx]) return;
    const v = Number(ticket.targetText.replace(",", "."));
    if (!Number.isFinite(v) || v <= 0) return;
    setSim((s) => simSetTarget(s, v, bars[cursorIdx].c));
    updateTicket({ targetText: "" });
  }, [cursorIdx, bars, ticket.targetText, updateTicket]);
  const targetByRR = React.useCallback((rr: number) => {
    if (cursorIdx == null || !bars[cursorIdx]) return;
    setSim((s) => simSetTarget(s, targetAtRR(s.avg, s.stop, rr), bars[cursorIdx].c));
  }, [cursorIdx, bars]);
  const clearTarget = React.useCallback(() => {
    if (cursorIdx == null || !bars[cursorIdx]) return;
    setSim((s) => simSetTarget(s, null, bars[cursorIdx].c));
  }, [cursorIdx, bars]);
  const breakeven = React.useCallback(() => {
    if (!training || revealed || cursorIdx == null || !bars[cursorIdx]) return;
    setSim((s) => simBreakeven(s, bars[cursorIdx].c));
  }, [training, revealed, cursorIdx, bars]);
  const reveal = React.useCallback(() => {
    if (!training || revealed || cursorIdx == null || !bars[cursorIdx]) return;
    setPlaying(false);
    const closes = bars.map((b) => b.c);
    const ideal = idealMove(closes, startIdx, cursorIdx);
    const o = scoreTraining(sim, {
      lastClose: bars[cursorIdx].c,
      ideal,
      real: hasTrade ? { side: geo.side, avgEntry: geo.avgEntry, avgExit: geo.exitIdx != null ? geo.avgExit : null, risk: geo.risk } : null,
    });
    setOutcome(o);
    setIdealT(ideal ? { from: bars[ideal.fromIdx].t, to: bars[ideal.toIdx].t, side: ideal.side } : null);
    const rec: TrainingResult = {
      at: Date.now(), tradeId: Math.max(0, trade.id), ticker: trade.ticker, day: dayKey, score: o.score, pnlUsd: o.pnlUsd, r: o.r, perShare: o.perShare,
      vsRealPerShare: o.vsRealPerShare, trades: o.trades, source: trainingSource ?? (trade.id > 0 ? undefined : "day"), realPerShare: o.realPerShare, realR: o.realR,
    };
    history.add(rec);
    onTrainingResult?.(rec);
  }, [training, revealed, cursorIdx, bars, startIdx, sim, geo, hasTrade, trade.id, trade.ticker, dayKey, history, onTrainingResult, trainingSource]);

  // ── Overlays / drawings ──────────────────────────────────────────────────
  const [overlays, setOverlays] = React.useState<Overlays>(() => loadBools(OVERLAYS_KEY, DEFAULT_OVERLAYS));
  const setOverlay = React.useCallback((k: keyof Overlays, v: boolean) => setOverlays((o) => { const n = { ...o, [k]: v }; save(OVERLAYS_KEY, n); return n; }), []);
  const [panes, setPanes] = React.useState<PaneToggles>(() => loadBools(PANES_KEY, DEFAULT_PANES));
  const setPane = React.useCallback((k: keyof PaneToggles, v: boolean) => setPanes((o) => { const n = { ...o, [k]: v }; save(PANES_KEY, n); return n; }), []);
  const ov = React.useMemo(() => {
    if (!hideReal) return overlays;
    const o = { ...overlays };
    for (const k of TRADE_OVERLAYS) o[k] = false;
    return o;
  }, [overlays, hideReal]);
  const showPnlPane = panes.pnl && !hideReal && geo.position.length > 0;

  const [drawings, setDrawings] = React.useState<Drawing[]>(() => loadDrawings(trade.id));
  const drawingsLoadedFor = React.useRef(trade.id);
  React.useEffect(() => {
    if (drawingsLoadedFor.current === trade.id) return;
    drawingsLoadedFor.current = trade.id;
    setDrawings(loadDrawings(trade.id));
  }, [trade.id]);
  const updateDrawings = React.useCallback((fn: (d: Drawing[]) => Drawing[]) => setDrawings((d) => { const n = fn(d); saveDrawings(trade.id, n); return n; }), [trade.id]);
  const [tool, setTool] = React.useState<DrawingType | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const clearDrawings = React.useCallback(() => { updateDrawings(() => []); setSelected(null); }, [updateDrawings]);
  const pendingRef = React.useRef<DrawingPoint[]>([]);
  const [pendingCount, setPendingCount] = React.useState(0);
  // Hovered bar lives outside React state: the crosshair updates only the legend, not the whole chart + panels.
  const [hoverStore] = React.useState(createHoverStore);

  live.current = { mode, tool, bars, barSec, cursorIdx, revealAll, replayActive, startIdx, speed, last, limitIdx, pauseIdx, pauseOnFills: prefs.pauseOnFills, hideReal };

  // ── View ─────────────────────────────────────────────────────────────────
  const { t: tc } = chartI18n.useT();
  const [viewMode, setViewModeState] = React.useState<ViewMode>(() => {
    try { const v = localStorage.getItem(VIEW_KEY); return isViewMode(v) ? v : "day"; } catch { return "day"; }
  });
  const setViewMode = React.useCallback((v: ViewMode) => {
    setViewModeState(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ }
  }, []);
  // Every bar of the trade's day(s): premarket → after-hours of the entry day … the exit day (context days excluded).
  const daySpan = React.useMemo(
    () => (intraday && bars.length ? daySpanOf(bars.map((b) => etDayKey(b.t)), data.dateKey, data.toKey || data.dateKey) : null),
    [intraday, bars, data.dateKey, data.toKey],
  );
  /** «День / Сделка» only makes sense for a trade on intraday bars outside replay (replay follows its cursor). */
  const showViewSwitch = hasTrade && daySpan != null && !replayActive;
  const fitView = React.useCallback(() => {
    const r = refs.current;
    if (!r) return;
    const s = live.current;
    const ts = r.chart.timeScale();
    if (s.replayActive && !s.revealAll && s.cursorIdx != null) ts.setVisibleLogicalRange({ from: s.cursorIdx - 70, to: s.cursorIdx + 30 });
    else {
      const range = defaultViewRange({ count: s.bars.length, entryIdx: geo.entryIdx, exitIdx: geo.exitIdx, dayRange: geo.dayRange, daySpan, mode: hasTrade ? viewMode : "trade" });
      if (range) ts.setVisibleLogicalRange(range); else ts.fitContent();
    }
    r.chart.priceScale("right").applyOptions({ autoScale: true });
  }, [geo.entryIdx, geo.exitIdx, geo.dayRange, daySpan, viewMode, hasTrade]);
  const fitRef = React.useRef(fitView);
  fitRef.current = fitView;
  // Switching «День / Сделка» re-frames at once (the chart itself is not rebuilt).
  const viewInit = React.useRef(true);
  React.useEffect(() => {
    if (viewInit.current) { viewInit.current = false; return; }
    fitRef.current();
  }, [viewMode]);

  // ── Chart build ──────────────────────────────────────────────────────────
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || !bars.length) return;
    const theme = readChartTheme();
    const chart = createChart(el, {
      width: el.clientWidth || 320, height: el.clientHeight || height,
      layout: {
        background: { color: "transparent" }, textColor: theme.muted(), fontFamily: theme.font, fontSize: 11, attributionLogo: false,
        panes: { separatorColor: theme.border(0.9), separatorHoverColor: theme.primary(0.25), enableResize: true },
      },
      grid: { vertLines: { color: theme.border(theme.dark ? 0.22 : 0.35) }, horzLines: { color: theme.border(theme.dark ? 0.22 : 0.35) } },
      timeScale: {
        timeVisible: intraday, secondsVisible: false, borderColor: theme.border(), rightOffset: 8, barSpacing: 8, minBarSpacing: 0.5,
        shiftVisibleRangeOnNewBar: false,
        tickMarkFormatter: (time: Time, type: number) => (typeof time === "number" ? tickMarkLabel(time, type) : ""),
      },
      localization: { locale: localeTag(), timeFormatter: (time: Time) => (typeof time === "number" ? fmtEtDateTime(time) : String(time)), priceFormatter: (p: number) => fmtPrice(p) },
      rightPriceScale: { borderColor: theme.border(), scaleMargins: { top: 0.08, bottom: 0.2 } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: theme.muted(0.45), labelBackgroundColor: theme.labelBg, width: 1, style: 3 },
        horzLine: { color: theme.muted(0.45), labelBackgroundColor: theme.labelBg, width: 1, style: 3 },
      },
      handleScale: { axisPressedMouseMove: true, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });

    const full = bars.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }));
    const ws = bars.map((b) => ({ time: b.t as UTCTimestamp }));
    const capped = capVolumes(bars.map((b) => b.v)).values;
    const volFull = bars.map((b, i) => {
      const rv = geo.rvol[i];
      const a = rv != null && rv >= 2 ? 0.62 : 0.34;
      return { time: b.t as UTCTimestamp, value: capped[i], color: b.c >= b.o ? theme.up(a) : theme.down(a) };
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: theme.up(), downColor: theme.down(), borderUpColor: theme.up(), borderDownColor: theme.down(), wickUpColor: theme.up(0.9), wickDownColor: theme.down(0.9),
      priceLineVisible: false, lastValueVisible: true,
      // Replay: fit the price scale to ALL bars in view so revealing bars does not jump the scale.
      // Training: default autoscale over revealed bars only (the future stays unknown).
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
        const s = live.current;
        if (s.mode !== "replay" || s.revealAll) return original();
        const r = chart.timeScale().getVisibleLogicalRange();
        if (!r) return original();
        const from = Math.max(0, Math.floor(r.from)), to = Math.min(bars.length - 1, Math.ceil(r.to));
        let lo = Infinity, hi = -Infinity;
        for (let i = from; i <= to; i++) { if (bars[i].l < lo) lo = bars[i].l; if (bars[i].h > hi) hi = bars[i].h; }
        return Number.isFinite(lo) ? { priceRange: { minValue: lo, maxValue: hi } } : original();
      },
    }, 0);
    chart.panes()[0]?.setStretchFactor(STRETCH.price);

    const prims: ChartRefs["prims"] = {
      session: new SessionShadingPrimitive(theme),
      fills: new FillsPrimitive(theme), zone: new PositionZonePrimitive(theme, { zOrder: "bottom" }), stopTarget: new StopTargetPrimitive(theme),
      excursion: new ExcursionPrimitive(theme), levels: new LevelsPrimitive(theme, { zOrder: "bottom" }),
      vwap: new VwapBandsPrimitive(theme, { color: theme.c5, bands: [], title: "VWAP" }),
      avwap: new VwapBandsPrimitive(theme, { color: theme.primary, bands: [], title: "AVWAP", dash: [5, 3] }),
      profile: new VolumeProfilePrimitive(theme), events: new EventMarkersPrimitive(theme), drawings: new DrawingsPrimitive(theme, { zOrder: "top" }),
      sim: new SimPositionPrimitive(theme),
    };
    const seriesPrims = [prims.levels, prims.zone, prims.profile, prims.vwap, prims.avwap, prims.stopTarget, prims.excursion, prims.fills, prims.sim, prims.drawings];
    chart.panes()[0]?.attachPrimitive(prims.session);
    chart.panes()[0]?.attachPrimitive(prims.events);
    structureLayer.attach(candles, theme);
    for (const p of seriesPrims) candles.attachPrimitive(p);
    prims.session.setBars(bars, intraday);
    prims.drawings.setScale(bars, barSec);

    refs.current = { chart, candles, volume: null, pnl: null, prims, full, ws, volFull, pnlFull: [], pnlByTime: new Map(), revealed: -2, theme };

    const s = live.current;
    applyReveal(refs.current, s.revealAll ? null : s.cursorIdx);
    fitRef.current();

    // Crosshair → legend (rAF-throttled) + drawing preview.
    let raf = 0;
    let lastHover: number | null = null;
    let hasPreview = false;
    const onMove = (param: MouseEventParams) => {
      const st = live.current;
      let idx: number | null = null;
      if (param.logical != null && param.point) {
        const i = Math.round(Number(param.logical));
        if (i >= 0 && i < bars.length && (st.revealAll || (st.cursorIdx != null && i <= st.cursorIdx))) idx = i;
      }
      if (idx !== lastHover) {
        lastHover = idx;
        if (!raf) raf = window.requestAnimationFrame(() => { raf = 0; hoverStore.set(lastHover); });
      }
      if (st.tool && pendingRef.current.length && param.point && param.paneIndex === 0 && param.logical != null) {
        const price = candles.coordinateToPrice(param.point.y);
        if (price != null) {
          const time = logicalToTime(bars, Number(param.logical), barSec);
          prims.drawings.setPreview(makeDrawing(st.tool, [...pendingRef.current, { time, price: Number(price) }], theme.c1(1)));
          hasPreview = true;
        }
      } else if (hasPreview) { prims.drawings.setPreview(null); hasPreview = false; }
    };
    const onClick = (param: MouseEventParams) => {
      const st = live.current;
      if (!param.point || param.paneIndex !== 0 || param.logical == null) return;
      if (!st.tool) {
        const id = typeof param.hoveredObjectId === "string" && param.hoveredObjectId.startsWith("drawing:") ? param.hoveredObjectId.slice(8) : null;
        setSelected(id);
        return;
      }
      const price = candles.coordinateToPrice(param.point.y);
      if (price == null) return;
      const time = logicalToTime(bars, Number(param.logical), barSec);
      const pts = [...pendingRef.current, { time, price: Number(price) }];
      if (pts.length >= DRAWING_POINTS[st.tool]) {
        const d = makeDrawing(st.tool, pts, theme.c1(1));
        pendingRef.current = [];
        setPendingCount(0);
        prims.drawings.setPreview(null);
        hasPreview = false;
        updateDrawings((list) => [...list, d]);
        setSelected(d.id);
        setTool(null);
      } else {
        pendingRef.current = pts;
        setPendingCount(pts.length);
      }
    };
    chart.subscribeCrosshairMove(onMove);
    chart.subscribeClick(onClick);

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
      chart.unsubscribeCrosshairMove(onMove);
      chart.unsubscribeClick(onClick);
      structureLayer.detach(candles);
      for (const p of seriesPrims) candles.detachPrimitive(p);
      chart.remove();
      refs.current = null;
      hoverStore.set(null);
    };
    // Rebuild only when the bar set, timeframe or theme changes; everything else is pushed by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, barSec, intraday, themeVersion]);

  // ── Volume overlay / P&L pane ────────────────────────────────────────────
  React.useEffect(() => {
    const r = refs.current;
    if (!r) return;
    const th = r.theme;
    if (r.volume) { r.chart.removeSeries(r.volume); r.volume = null; }
    if (r.pnl) { r.chart.removeSeries(r.pnl); r.pnl = null; }
    if (panes.volume) {
      r.volume = r.chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 0);
      r.chart.priceScale("vol", 0).applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
    }
    r.candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: panes.volume ? 0.2 : 0.06 } });
    if (showPnlPane) {
      r.pnl = r.chart.addSeries(BaselineSeries, {
        baseValue: { type: "price", price: 0 },
        topLineColor: th.up(1), topFillColor1: th.up(0.3), topFillColor2: th.up(0.03),
        bottomLineColor: th.down(1), bottomFillColor1: th.down(0.03), bottomFillColor2: th.down(0.3),
        lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
        priceFormat: { type: "custom", formatter: (p: number) => fmtUsd(p, { decimals: 0 }), minMove: 0.01 },
        title: "P&L",
      }, 1);
      r.pnl.getPane().setStretchFactor(STRETCH.pnl);
    }
    r.chart.panes()[0]?.setStretchFactor(STRETCH.price);
    r.pnlFull = geo.position.map((p) => ({ time: p.t as UTCTimestamp, value: Math.round(p.total * 100) / 100 }));
    r.pnlByTime = new Map(r.pnlFull.map((p) => [Number(p.time), p]));
    r.revealed = -2;
    const s = live.current;
    applyReveal(r, s.revealAll ? null : s.cursorIdx);
  }, [panes.volume, showPnlPane, geo.position, bars]);

  // ── Push geometry + overlay visibility ───────────────────────────────────
  React.useEffect(() => {
    const r = refs.current;
    if (!r) return;
    const { prims } = r;
    const th = r.theme;
    prims.fills.setFills(geo.fills, geo.side);
    const multiple = geo.fills.filter((f) => isOpening(f.kind)).length > 1;
    prims.zone.set(geo.entryIdx != null && geo.avgEntry != null ? {
      fromIdx: geo.entryIdx, toIdx: geo.exitIdx, avgEntry: geo.avgEntry, avgExit: geo.avgExit,
      positive: geo.grossUsd != null ? geo.grossUsd >= 0 : null, side: geo.side, multipleEntries: multiple,
    } : null);
    prims.zone.setVisible(ov.zone);
    prims.stopTarget.set({ stop: geo.stop, target: geo.target, avgEntry: geo.avgEntry, side: geo.side });
    prims.stopTarget.setVisible(ov.stopTarget);
    prims.excursion.set(geo.excursion && geo.avgEntry != null ? { result: geo.excursion, avgEntry: geo.avgEntry, mfeIdx: geo.mfeIdx, maeIdx: geo.maeIdx } : null);
    prims.excursion.setVisible(ov.excursion);
    const lv: LevelLine[] = [];
    const L = geo.levels;
    if (ov.levels) {
      if (L.pdh != null) lv.push({ key: "pdh", price: L.pdh, text: "PDH", color: th.c3(0.75) });
      if (L.pdl != null) lv.push({ key: "pdl", price: L.pdl, text: "PDL", color: th.c3(0.75) });
      if (L.pdc != null) lv.push({ key: "pdc", price: L.pdc, text: "PDC", color: th.muted(0.8), dash: [6, 4] });
      if (L.pmh != null) lv.push({ key: "pmh", price: L.pmh, text: "PMH", color: th.c1(0.75) });
      if (L.pml != null) lv.push({ key: "pml", price: L.pml, text: "PML", color: th.c1(0.75) });
    }
    if (ov.orb && geo.dayRange) {
      if (L.orb5) { lv.push({ key: "orb5h", price: L.orb5.h, text: "ORB5 H", color: th.c2(0.8), fromIdx: geo.dayRange.from }); lv.push({ key: "orb5l", price: L.orb5.l, text: "ORB5 L", color: th.c2(0.8), fromIdx: geo.dayRange.from }); }
      if (L.orb15) { lv.push({ key: "orb15h", price: L.orb15.h, text: "ORB15 H", color: th.c5(0.8), dash: [4, 3], fromIdx: geo.dayRange.from }); lv.push({ key: "orb15l", price: L.orb15.l, text: "ORB15 L", color: th.c5(0.8), dash: [4, 3], fromIdx: geo.dayRange.from }); }
    }
    prims.levels.set(lv);
    prims.vwap.setOptions({ bands: ov.vwapBands ? [1, 2] : [] });
    prims.vwap.set(geo.vwap); prims.vwap.setVisible(ov.vwap);
    prims.avwap.set(geo.avwap); prims.avwap.setVisible(ov.avwap);
    prims.profile.set(geo.profile); prims.profile.setVisible(ov.profile);
    prims.events.set(geo.events); prims.events.setVisible(ov.events);
    prims.session.setEnabled(ov.session);
  }, [geo, ov]);

  // ── Reveal (replay cursor) ───────────────────────────────────────────────
  React.useEffect(() => {
    const r = refs.current;
    if (!r) return;
    const limit = revealAll ? null : cursorIdx;
    applyReveal(r, limit);
    r.prims.fills.setLimit(limit);
    r.prims.fills.setHidden(hideReal ? geo.fills.map((f) => f.id) : []);
    r.prims.zone.setCursor(limit, limit != null ? bars[limit]?.c ?? null : null);
    r.prims.vwap.setLimit(limit);
    r.prims.avwap.setLimit(limit);
    if (limit != null) {
      const ts = r.chart.timeScale();
      const next = followCursor(ts.getVisibleLogicalRange(), limit);
      if (next) ts.setVisibleLogicalRange(next);
    }
  }, [cursorIdx, revealAll, hideReal, geo.fills, bars]);

  // ── Paper position (training) ────────────────────────────────────────────
  React.useEffect(() => {
    const r = refs.current;
    if (!r) return;
    if (!training) { r.prims.sim.set(null); return; }
    const toIdx = (t: number) => barIndexForTime(bars, t, barSec);
    const openFill = sim.pos !== 0 ? [...sim.fills].reverse().find((f, i, arr) => {
      // the fill that opened the current position: the last fill after which the position was flat before
      const rest = arr.slice(i + 1).reduce((s, x) => s + x.qty, 0);
      return Math.abs(rest) < 1e-9 && Math.sign(f.qty) === Math.sign(sim.pos);
    }) : null;
    const ideal = idealT && bars.length ? { fromIdx: toIdx(idealT.from), toIdx: toIdx(idealT.to), fromPrice: bars[toIdx(idealT.from)].c, toPrice: bars[toIdx(idealT.to)].c, side: idealT.side } : null;
    r.prims.sim.set({
      fills: sim.fills.map((f) => ({ idx: toIdx(f.t), price: f.price, qty: f.qty, reason: f.reason })),
      pos: sim.pos, avg: sim.avg, stop: sim.stop, target: sim.target,
      openIdx: openFill ? toIdx(openFill.t) : null,
      cursor: cursorIdx,
      ideal,
    });
  }, [training, sim, cursorIdx, idealT, bars, barSec]);

  // ── Drawings → primitive ─────────────────────────────────────────────────
  React.useEffect(() => { refs.current?.prims.drawings.setDrawings(drawings); }, [drawings, bars]);
  React.useEffect(() => { refs.current?.prims.drawings.setSelected(selected); }, [selected, bars]);
  React.useEffect(() => {
    if (!tool) { pendingRef.current = []; setPendingCount(0); refs.current?.prims.drawings.setPreview(null); }
  }, [tool]);

  // ── Fullscreen ───────────────────────────────────────────────────────────
  const [fullscreen, setFullscreen] = React.useState(false);
  React.useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === rootRef.current && rootRef.current != null);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFullscreen = React.useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen?.().catch(() => undefined);
  }, []);

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const cycleTf = React.useCallback(() => {
    if (timeframes.length < 2) return;
    setTf(timeframes[(timeframes.indexOf(tf) + 1) % timeframes.length]);
  }, [timeframes, tf, setTf]);
  const handleKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const code = e.code;
    if (k === "Escape") { if (tool || selected) { e.preventDefault(); setTool(null); setSelected(null); } return; }
    if ((k === "Delete" || k === "Backspace") && selected) { e.preventDefault(); updateDrawings((d) => d.filter((x) => x.id !== selected)); setSelected(null); return; }
    if (code === "KeyF") { e.preventDefault(); if (e.shiftKey) toggleFullscreen(); else fitView(); return; }
    if (code === "KeyT") { e.preventDefault(); cycleTf(); return; }
    if (!replayActive && showViewSwitch && (code === "KeyD" || code === "KeyZ")) { e.preventDefault(); setViewMode(code === "KeyD" ? "day" : "trade"); return; }
    if (!replayActive) return;
    const btn = (e.target as HTMLElement | null)?.tagName === "BUTTON";
    if (k === " " || code === "Space") { e.preventDefault(); togglePlay(); return; }
    if (k === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 10 : 1); return; }
    if (k === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -10 : -1); return; }
    if (k === "+" || k === "=" || code === "Equal" || code === "NumpadAdd") { e.preventDefault(); updatePrefs({ speed: stepSpeed(speed, 1) }); return; }
    if (k === "-" || k === "_" || code === "Minus" || code === "NumpadSubtract") { e.preventDefault(); updatePrefs({ speed: stepSpeed(speed, -1) }); return; }
    if (k === "Home") { e.preventDefault(); if (training) resetSession(); else { setPlaying(false); setCursor(startIdx); } return; }
    if (training) {
      if (code === "KeyB") { e.preventDefault(); placeOrder("buy"); }
      else if (code === "KeyS") { e.preventDefault(); placeOrder("sell"); }
      else if (code === "KeyC") { e.preventDefault(); placeOrder("flat"); }
      else if (code === "KeyH") { e.preventDefault(); placeOrder("half"); }
      else if (code === "KeyE") { e.preventDefault(); breakeven(); }
      else if (k === "Enter" && !btn) { e.preventDefault(); reveal(); }
      else if (code === "KeyN" && revealed && onNextTask) { e.preventDefault(); onNextTask(); }
      return;
    }
    if (code === "KeyE") { e.preventDefault(); jumpEntry(); }
    else if (code === "KeyX") { e.preventDefault(); jumpExit(); }
    else if (code === "KeyN") { e.preventDefault(); jumpNextFill(); }
    else if (code === "KeyP") { e.preventDefault(); updatePrefs({ pauseOnFills: !prefs.pauseOnFills }); }
  };
  const keyRef = React.useRef(handleKey);
  keyRef.current = handleKey;
  const global = globalHotkeys ?? layout === "workspace";
  React.useEffect(() => {
    if (!global) return;
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target)) return;
      // Inside an open popover / dialog the keys belong to it.
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[role='dialog'],[role='menu'],[role='listbox']")) return;
      keyRef.current(e);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [global]);

  // ── Screenshot ───────────────────────────────────────────────────────────
  const screenshot = React.useCallback(() => {
    const r = refs.current;
    if (!r) return;
    try {
      const canvas = r.chart.takeScreenshot(true, false);
      const name = `WS-${trade.ticker}-${data.dateKey}-${tf}.png`;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      }, "image/png");
    } catch { /* canvas tainted or unsupported — ignore */ }
  }, [trade.ticker, data.dateKey, tf]);

  // ── Derived panel data ───────────────────────────────────────────────────
  const sinceEntryAt = React.useCallback((idx: number) => {
    const bar = bars[idx];
    const entryT = geo.entryTime;
    if (!bar || entryT == null || geo.entryIdx == null || idx < geo.entryIdx) return null;
    return Math.max(0, (idx === geo.entryIdx ? bar.t + Math.min(barSec, 60) : bar.t + barSec) - entryT);
  }, [bars, geo.entryTime, geo.entryIdx, barSec]);

  const legendAt = React.useCallback((hover: number | null): LegendInfo | null => {
    if (!bars.length) return null;
    const idx = hover ?? (cursorIdx != null && !revealAll ? cursorIdx : (cursorIdx ?? (geo.exitIdx ?? last)));
    const bar = bars[idx];
    if (!bar) return null;
    const pos = hideReal ? null : positionAt(visibleFills, idx, geo.side, bar.c, trade.qty ?? null);
    const v = ov.vwap && geo.vwap.length ? bsearch(geo.vwap, idx) : null;
    const av = ov.avwap && geo.avwap.length ? bsearch(geo.avwap, idx) : null;
    return { bar, idx, hovered: hover != null, position: pos, sinceEntry: sinceEntryAt(idx), vwap: v, avwap: av?.vwap ?? null, rvol: geo.rvol[idx] ?? null, risk: geo.risk, side: geo.side, prevClose: geo.levels.pdc ?? data.prevClose, redacted };
  }, [bars, cursorIdx, revealAll, geo, last, hideReal, visibleFills, trade.qty, ov.vwap, ov.avwap, sinceEntryAt, data.prevClose, redacted]);

  const marks: ReplayMark[] = React.useMemo(() => visibleFills.map((f) => ({ idx: f.idx, kind: f.kind, label: f.label })), [visibleFills]);
  const livePosition = React.useMemo(() => {
    if (cursorIdx == null || !bars[cursorIdx] || hideReal) return null;
    return positionAt(visibleFills, cursorIdx, geo.side, bars[cursorIdx].c, trade.qty ?? null);
  }, [cursorIdx, bars, visibleFills, geo.side, trade.qty, hideReal]);
  const summary = React.useMemo(() => (hasTrade ? buildTradeSummary({
    side: geo.side, avgEntry: geo.avgEntry, avgExit: geo.exitIdx != null ? geo.avgExit : null, risk: geo.risk, excursion: geo.excursion,
    entryTime: geo.entryTime, exitTime: geo.exitTime, pnlUsd: redacted ? null : (trade.pnl ?? geo.grossUsd),
  }) : null), [hasTrade, geo, redacted, trade.pnl]);
  const suggestLong = cursorIdx != null && training ? suggestStop(bars, cursorIdx, 1) : null;
  const suggestShort = cursorIdx != null && training ? suggestStop(bars, cursorIdx, -1) : null;

  const hasNextTask = !!onNextTask;
  const hotkeys: HotkeyRow[] = React.useMemo(() => {
    const rows: HotkeyRow[] = [];
    if (replayActive) {
      rows.push([[tc("hotkeys.keySpace")], tc("hotkeys.playPause")], [["→"], tc("hotkeys.stepForward")]);
      if (!training) rows.push([["←"], tc("hotkeys.stepBack")]);
      rows.push([["+", "−"], tc("hotkeys.speed")]);
      if (training) {
        rows.push([["B"], tc("hotkeys.buy")], [["S"], tc("hotkeys.sell")], [["H"], tc("hotkeys.half")], [["E"], tc("hotkeys.breakeven")], [["C"], tc("hotkeys.flat")], [["Enter"], tc("hotkeys.reveal")]);
        if (hasNextTask) rows.push([["N"], tc("hotkeys.nextTask")]);
      }
      else rows.push([["E"], tc("hotkeys.toEntry")], [["X"], tc("hotkeys.toExit")], [["N"], tc("hotkeys.nextFill")], [["P"], tc("hotkeys.pauseOnFills")]);
      rows.push([["Home"], tc("hotkeys.toStart")]);
    }
    if (showViewSwitch) rows.push([["D"], tc("hotkeys.day")], [["Z"], tc("hotkeys.trade")]);
    rows.push([["T"], tc("hotkeys.cycleTf")], [["F"], tc("hotkeys.fit")], [["Shift", "F"], tc("hotkeys.fullscreen")], [[tc("hotkeys.keyWheel")], tc("hotkeys.zoom")], [["Esc"], tc("hotkeys.cancelDrawing")]);
    return rows;
  }, [replayActive, training, hasNextTask, showViewSwitch, tc]);

  // ── Render ───────────────────────────────────────────────────────────────
  const isWorkspace = layout === "workspace" || fullscreen;
  const chartBoxCls = cn(
    "relative w-full min-w-0 overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] shadow-[var(--glass-shadow-sm)]",
    isWorkspace && "h-[58svh] min-h-[280px] shrink-0 lg:h-auto lg:min-h-[320px] lg:flex-1 lg:shrink",
  );

  if (data.loading) {
    return (
      <div className={cn("flex w-full min-w-0 flex-col gap-2", isWorkspace && "h-full min-h-0", className)} aria-busy="true">
        <Skeleton className="h-8 w-full max-w-[34rem] rounded-full" />
        <Skeleton className={cn("rounded-2xl", isWorkspace && "min-h-[280px] flex-1")} style={isWorkspace ? undefined : { height }} />
        <span className="sr-only" role="status">{tc("engine.loading")}</span>
      </div>
    );
  }
  if (data.error || !bars.length) {
    const err = data.error;
    const reason = err?.field<string>("reason");
    const text = reason === "weekend" ? tc("engine.weekend", { date: data.dateKey })
      : reason === "future" ? tc("engine.future", { date: data.dateKey })
      : err?.status === 404 ? tc("engine.noCandlesRange", { ticker: trade.ticker, from: data.fromKey, to: data.toKey })
      : err ? tc("engine.loadFailed", { message: err.message })
      : useDaily && data.daily.loading ? tc("engine.loadingDaily")
      : tc("engine.noCandles", { date: data.dateKey });
    return (
      <div className={cn("flex items-center gap-2 rounded-2xl bg-[var(--glass-bg)] px-4 py-6 text-sm text-muted-foreground", className)} role="status">
        <AlertTriangle className="h-4 w-4 shrink-0 text-[hsl(var(--chart-3))]" aria-hidden="true" /> {text}
      </div>
    );
  }

  // A multi-day trade (overnight / swing) spans several days: the replay labels carry the day too.
  const fmtBarTime = (t: number) => (intraday ? (data.multiDay ? fmtEtDateTime(t) : `${fmtEtTime(t)} ET`) : fmtEtDay(t));
  const dockEnd = training ? sessionEnd : Math.min(last, Math.max(sessionEnd, geo.exitIdx ?? 0));
  const hint = tool ? (pendingCount ? tc("engine.secondPoint") : tc("engine.firstPoint")) : selected ? tc("engine.deleteDrawing") : null;
  const replayDone = mode === "replay" && cursorIdx != null && geo.exitIdx != null && cursorIdx >= geo.exitIdx;

  let aside: React.ReactNode[] = [];
  if (mode === "analysis") {
    if (isWorkspace && summary) aside = [<SummaryCard key="sum" s={summary} redacted={redacted} />, <FillLog key="log" fills={geo.fills} cursor={null} redacted={redacted} onJump={(i) => refs.current?.chart.timeScale().setVisibleLogicalRange({ from: i - 50, to: i + 30 })} />];
  } else if (mode === "replay" && cursorIdx != null) {
    if (replayDone && summary) aside.push(<SummaryCard key="sum" s={summary} redacted={redacted} onJumpBest={geo.mfeIdx != null ? () => setCursor(geo.mfeIdx as number) : undefined} />);
    else if (hasTrade) aside.push(<PositionCard key="pos" position={livePosition} side={geo.side} mark={bars[cursorIdx]?.c ?? null} risk={geo.risk} redacted={redacted} sinceEntry={sinceEntryAt(cursorIdx)} entered={geo.entryIdx != null && cursorIdx >= geo.entryIdx} />);
    if (hasTrade) aside.push(<FillLog key="log" fills={geo.fills} cursor={cursorIdx} redacted={redacted} onJump={(i) => { setPlaying(false); setCursor(i); }} />);
  } else if (training && cursorIdx != null) {
    if (outcome) {
      const decisions: DecisionRow[] = sim.fills.map((f) => ({ idx: barIndexForTime(bars, f.t, barSec), time: data.multiDay ? `${fmtEtDay(f.t)} ${fmtEtTime(f.t)}` : fmtEtTime(f.t), price: f.price, qty: f.qty, reason: f.reason }));
      aside.push(
        <TrainingOutcomeCard
          key="out" o={outcome} decisions={decisions} traderName={hasTrade ? (trade.trader ?? undefined) : null}
          onJump={(i) => refs.current?.chart.timeScale().setVisibleLogicalRange({ from: i - 50, to: i + 30 })}
          onRestart={resetSession} onNext={onNextTask}
        />,
      );
      if (summary) aside.push(<SummaryCard key="sum" s={summary} redacted={redacted} />);
    } else {
      aside.push(
        <TrainingTicket
          key="ticket" price={bars[cursorIdx]?.c ?? null} sim={sim} ticket={ticket} onTicket={updateTicket}
          suggestLong={suggestLong} suggestShort={suggestShort} onOrder={placeOrder} onApplyStop={applyStop}
          onBreakeven={breakeven} canBE={canBreakeven(sim, bars[cursorIdx]?.c ?? null)} onApplyTarget={applyTarget} onTargetRR={targetByRR} onClearTarget={clearTarget}
          onReveal={reveal} atLimit={atLimit} started={cursorIdx > startIdx || sim.fills.length > 0}
        />,
      );
    }
    aside.push(<TrainingHistoryCard key="hist" list={history.list} />);
  }
  if (asideExtra) aside.push(<React.Fragment key="extra">{asideExtra}</React.Fragment>);
  const showAside = aside.length > 0;

  return (
    <div
      ref={rootRef}
      className={cn("ws-chart flex w-full min-w-0 max-w-full flex-col gap-2 outline-none", isWorkspace && "h-full min-h-0", fullscreen && "bg-background p-3", className)}
      tabIndex={-1}
      onKeyDown={global ? undefined : (e) => { if (!isTyping(e.target)) keyRef.current(e.nativeEvent); }}
      aria-label={tc("engine.aria")}
    >
      <ChartToolbar
        timeframe={tf} timeframes={timeframes} allTimeframes={TIMEFRAMES} baseSec={data.baseSec} onTimeframe={setTf}
        mode={mode} onMode={setMode} showModes={showModes}
        overlays={overlays} onOverlay={setOverlay} panes={panes} onPane={setPane} hasPosition={geo.position.length > 0}
        hasEvents={geo.events.length > 0} hasStopOrTarget={geo.stop != null || geo.target != null} lockTrade={hideReal}
        tool={tool} onTool={setTool} drawingsCount={drawings.length} onClearDrawings={clearDrawings}
        onScreenshot={screenshot} onFit={fitView} onFullscreen={toggleFullscreen} fullscreen={fullscreen}
        view={showViewSwitch ? viewMode : undefined} onView={setViewMode}
        fetching={data.fetching || (useDaily && data.daily.loading)} hotkeys={hotkeys}
      />
      <div className={cn("flex min-w-0 flex-col gap-2", isWorkspace && "min-h-0 flex-1 lg:flex-row")}>
        <div className={cn("flex min-w-0 flex-col gap-2", isWorkspace && "min-h-0 lg:flex-1")}>
          <div className={chartBoxCls} style={isWorkspace ? undefined : { height }}>
            <div ref={containerRef} className={cn("absolute inset-0 isolate overflow-hidden tabular-nums", tool && "cursor-crosshair")} />
            <LiveLegend store={hoverStore} build={legendAt} ticker={trade.ticker} tfLabel={TF_LABEL[tf]} />
            <FillsKey fills={visibleFills} structure={hideReal ? null : geo.structure} layer={structureLayer} />
            {hint && <div className="pointer-events-none absolute bottom-8 left-2 z-raised rounded-full bg-background/90 px-2.5 py-1 text-xs text-muted-foreground">{hint}</div>}
            {((training && hideReal) || (data.baseSec > 60 && intraday)) && (
              <div className="pointer-events-none absolute bottom-8 right-[4.5rem] z-raised flex max-w-[calc(100%-6rem)] flex-wrap justify-end gap-1">
                {training && hideReal && <span className="rounded-full bg-background/90 px-2 py-0.5 text-xs text-muted-foreground">{tc("engine.futureHidden")}</span>}
                {data.baseSec > 60 && intraday && (
                  // Honest bar size: an old day may only exist in 5-minute / hourly bars.
                  <span className="pointer-events-auto cursor-help rounded-full bg-background/90 px-2 py-0.5 text-xs text-[hsl(var(--chart-3))]" title={tc("bars.coarseTitle")}>
                    {tc("bars.coarse", { tf: baseBarLabel(data.baseSec) })}
                  </span>
                )}
              </div>
            )}
          </div>
          {replayActive && cursorIdx != null && (
            <ReplayDock
              playing={playing} speed={speed} cursor={cursorIdx} start={startIdx} end={dockEnd} training={training && !revealed}
              marks={marks} timeLabel={fmtBarTime(bars[cursorIdx].t)} startLabel={fmtBarTime(bars[startIdx].t)} endLabel={fmtBarTime(bars[dockEnd]?.t ?? bars[last].t)}
              startPreset={startPreset} onStartPreset={chooseStart} hasEntry={hasTrade} intraday={intraday}
              hasExit={geo.exitIdx != null} nextFillLabel={nextFill?.label ?? null} pauseOnFills={prefs.pauseOnFills} onPauseOnFills={(v) => updatePrefs({ pauseOnFills: v })}
              atLimit={atLimit}
              onToggle={togglePlay} onStep={step} onSpeed={(v) => updatePrefs({ speed: v })} onSeek={seek}
              onNextFill={jumpNextFill} onEntry={jumpEntry} onExit={jumpExit} onRestart={() => { if (training) resetSession(); else { setPlaying(false); setCursor(startIdx); } }}
            />
          )}
        </div>
        {showAside && (
          <aside
            className={cn("flex min-w-0 flex-col gap-2", isWorkspace ? "lg:min-h-0 lg:w-[320px] lg:shrink-0 lg:overflow-y-auto lg:pr-0.5" : "sm:grid sm:grid-cols-2 sm:items-start")}
            aria-label={training ? tc("engine.asideTraining") : tc("engine.asideTrade")}
          >
            {aside}
          </aside>
        )}
      </div>
    </div>
  );
}

/** Push candles / volume / P&L for a reveal limit (null = everything). Small forward steps use `update` instead of `setData`. */
function applyReveal(r: ChartRefs, limit: number | null): void {
  const n = r.full.length;
  const target = limit == null ? n - 1 : Math.max(-1, Math.min(n - 1, limit));
  if (r.revealed === target) return;
  const prev = r.revealed;
  if (prev >= -1 && target > prev && target - prev <= 24) {
    for (let i = prev + 1; i <= target; i++) {
      r.candles.update(r.full[i], true);
      r.volume?.update(r.volFull[i], true);
      const p = r.pnl ? r.pnlByTime.get(Number(r.full[i].time)) : undefined;
      if (p) r.pnl!.update(p, true);
    }
  } else {
    r.candles.setData(target >= n - 1 ? r.full : [...r.full.slice(0, target + 1), ...r.ws.slice(target + 1)]);
    r.volume?.setData(target >= n - 1 ? r.volFull : [...r.volFull.slice(0, target + 1), ...r.ws.slice(target + 1)]);
    if (r.pnl) {
      const limitT = target >= 0 ? Number(r.full[target].time) : -Infinity;
      r.pnl.setData(target >= n - 1 ? r.pnlFull : r.pnlFull.filter((p) => Number(p.time) <= limitT));
    }
  }
  r.revealed = target;
}

/** Hovered bar index as a tiny external store (see `hoverStore` in WsChart). */
function createHoverStore() {
  let value: number | null = null;
  const subs = new Set<() => void>();
  return {
    get: (): number | null => value,
    set: (v: number | null): void => { if (v === value) return; value = v; for (const f of subs) f(); },
    subscribe: (f: () => void): (() => void) => { subs.add(f); return () => { subs.delete(f); }; },
  };
}
type HoverStore = ReturnType<typeof createHoverStore>;

/** The legend is the only thing that follows the mouse: it alone re-renders on hover. */
function LiveLegend({ store, build, ticker, tfLabel }: { store: HoverStore; build: (hover: number | null) => LegendInfo | null; ticker: string; tfLabel: string }) {
  const hover = React.useSyncExternalStore(store.subscribe, store.get);
  const info = React.useMemo(() => build(hover), [build, hover]);
  return <ChartLegend info={info} ticker={ticker} tfLabel={tfLabel} />;
}

/** Last point with idx <= i, or null (points sorted by idx). */
function bsearch<T extends { idx: number }>(pts: readonly T[], i: number): T | null {
  let lo = 0, hi = pts.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m].idx <= i) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? pts[ans] : null;
}
