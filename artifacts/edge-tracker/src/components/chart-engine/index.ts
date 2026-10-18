/**
 * WS Chart — public API.
 *
 *   import { WsChart, TradeSparkline } from "@/components/chart-engine";
 *   <WsChart trade={trade} target={target} initialTimeframe="1m" mode="analysis" height={520} />
 *   <TradeSparkline tradeId={trade.id} />           // or trade={trade} / data={sparkData}
 *
 * `WsChart` accepts the same `trade` / `target` / `height` / `className` props as components/replay/ReplayChart,
 * so it can be swapped in one line. Pure helpers (no React, no DOM) are re-exported from ./lib for reuse/tests.
 */
export { WsChart, type WsChartProps } from "./WsChart";
export { TradeSparkline, invalidateSparkline, type TradeSparklineProps } from "./TradeSparkline";
export { useChartData, tradeWindow, type ChartData, type ChartError } from "./hooks/useChartData";
export { readChartTheme, type ChartTheme } from "./theme";

export type {
  Candle, Bar, Timeframe, ApiInterval, Session, Side, ExecutionKind, Execution, Fill, TradeLike, PositionPoint, PositionState,
  ExcursionResult, VwapPoint, DayLevels, VolumeProfile, MarketEventLite, DrawingType, DrawingPoint, Drawing, ChartMode, TrainingResult, SparkData, TradeStructureDto,
} from "./types";
export { TIMEFRAMES, TF_SECONDS, TF_LABEL, API_INTERVAL_SECONDS } from "./types";

// Pure functions (chart-engine/lib/*): time, aggregation, indicators, position maths, drawings, sparkline.
export {
  etParts, sessionOf, sessionOfMinutes, etDayKey, etWallToEpoch, isoToEpoch, fmtEtTime, fmtEtDay, fmtEtDayFull, fmtEtDateTime, tickMarkLabel,
  formatDuration, findBarIndex, barIndexForTime, timeToLogical, logicalToTime, RTH_OPEN_MIN, RTH_CLOSE_MIN, PRE_OPEN_MIN, POST_CLOSE_MIN,
} from "./lib/time";
export { aggregate, bucketStart, availableTimeframes, barSeconds } from "./lib/aggregate";
export { sessionVwap, anchoredVwap } from "./lib/vwap";
export { dayLevels } from "./lib/levels";
export { volumeProfile, type ProfileOptions } from "./lib/profile";
export { rvolSeries } from "./lib/rvol";
export {
  KIND_LABEL, sideOf, toNum, isOpening, resolveFills, firstEntryIdx, lastExitIdx, avgEntryPrice, avgExitPrice, positionSize, positionAt, positionSeries,
  excursion, riskPerShare, grossFromFills,
} from "./lib/position";
export { buildGeometry, type Geometry, type GeometryInput } from "./lib/geometry";
export { FIB_LEVELS, DRAWING_LABEL, DRAWING_POINTS, makeDrawing, isValidDrawing, serializeDrawings, parseDrawings, drawingsStorageKey, loadDrawings, saveDrawings } from "./lib/drawings";
export { buildSparkData, type SparkInput } from "./lib/sparkline";
