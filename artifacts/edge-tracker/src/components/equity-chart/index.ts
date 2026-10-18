/**
 * Equity curve on our own canvas engine.
 *
 *   import { EquityChart, buildDayCandles } from "@/components/equity-chart";
 *   <EquityChart days={buildDayCandles(trades, "net")} unit="net" trader="Ориф" storageKey="analytics.equity" />
 */
export { EquityChart, type EquityChartProps, type EquityPeriodControl } from "./EquityChart";
export { aggregate, derive, fromDashboardDays, fromOhlc, toMonthCandles, windowStats, type EquityAgg, type DashboardDayLike } from "./model";
export { buildDayCandles, soleTrader, type EquityCandle, type EquityUnit, type EquityTradeInput } from "@/components/equity-candles/lib";
