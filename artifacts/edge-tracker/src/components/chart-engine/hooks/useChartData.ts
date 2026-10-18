/**
 * Data for WS Chart: base candles (+ optional daily), executions, trade-day events.
 * Reads only: GET /api/candles/:ticker/range, GET /api/trades/:id/executions, GET /api/events.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { http, type ApiError } from "@/lib/api/http";
import { addDays } from "@/lib/trading-date";
import { tradeWindow } from "../lib/window";
import type { ApiInterval, Candle, Execution, ExecutionsResponse, MarketEventLite, TradeLike, TradeStructureDto } from "../types";
import { API_INTERVAL_SECONDS } from "../types";

export { tradeWindow };

export type RangeResponse = { ticker: string; from: string; to: string; interval: string; candles: Candle[]; prevClose: number | null };

/** `status` = HTTP status; the server's `reason` ("weekend" | "future") is `err.field<string>("reason")`. */
export type ChartError = ApiError;

const noRetry = (count: number, err: unknown) => {
  const s = (err as ChartError).status;
  return s !== 422 && s !== 400 && s !== 404 && s !== 401 && count < 1;
};

export type ChartData = {
  dateKey: string;
  toKey: string;
  fromKey: string;
  /** Base bars as served (sorted, deduplicated by the API). */
  bars: Candle[];
  baseInterval: ApiInterval | null;
  baseSec: number;
  prevClose: number | null;
  executions: Execution[];
  /** Recognised structure of the trade (passed in with the executions, or from the API; null when it sent none). */
  structure: TradeStructureDto | null;
  events: MarketEventLite[];
  daily: { bars: Candle[]; loading: boolean; requested: boolean; request: () => void };
  loading: boolean;
  fetching: boolean;
  error: ChartError | null;
  multiDay: boolean;
};

export function useChartData(trade: TradeLike, opts: { executions?: Execution[]; structure?: TradeStructureDto | null; contextDays?: number; enabled?: boolean } = {}): ChartData {
  const contextDays = opts.contextDays ?? 2;
  const enabled = opts.enabled !== false && Boolean(trade.ticker && trade.date);
  const { dateKey, toKey, fromKey, multiDay } = React.useMemo(() => tradeWindow(trade, contextDays), [trade, contextDays]);
  const ticker = trade.ticker;

  const bars = useQuery<RangeResponse, ChartError>({
    queryKey: ["ws-chart", "range", ticker, fromKey, toKey],
    queryFn: ({ signal }) => http.get<RangeResponse>(`/api/candles/${encodeURIComponent(ticker)}/range?from=${fromKey}&to=${toKey}&interval=1m&extended=1&trim=1`, { signal }),
    enabled, staleTime: 5 * 60 * 1000, retry: noRetry,
  });

  const [dailyRequested, setDailyRequested] = React.useState(false);
  const dailyFrom = React.useMemo(() => addDays(dateKey, -120), [dateKey]);
  const daily = useQuery<RangeResponse, ChartError>({
    queryKey: ["ws-chart", "daily", ticker, dailyFrom, toKey],
    queryFn: ({ signal }) => http.get<RangeResponse>(`/api/candles/${encodeURIComponent(ticker)}/range?from=${dailyFrom}&to=${toKey}&interval=1d`, { signal }),
    enabled: enabled && dailyRequested, staleTime: 10 * 60 * 1000, retry: noRetry,
  });

  const execs = useQuery<ExecutionsResponse, ChartError>({
    queryKey: ["trade-executions", trade.id],
    queryFn: ({ signal }) => http.get<ExecutionsResponse>(`/api/trades/${trade.id}/executions`, { signal }),
    enabled: enabled && opts.executions === undefined && trade.id > 0, staleTime: 30 * 1000, retry: noRetry,
  });

  const events = useQuery<MarketEventLite[], ChartError>({
    queryKey: ["ws-chart", "events", ticker, dateKey, toKey],
    queryFn: async () => {
      try {
        const r = await http.get<unknown>(`/api/events?ticker=${encodeURIComponent(ticker)}&from=${dateKey}&to=${toKey}&limit=50`);
        return Array.isArray(r) ? (r as MarketEventLite[]).filter((e) => e && typeof e.headline === "string" && typeof e.date === "string") : [];
      } catch { return []; }
    },
    enabled, staleTime: 5 * 60 * 1000, retry: false,
  });

  const baseInterval = (bars.data?.interval as ApiInterval | undefined) ?? null;
  const baseSec = baseInterval && API_INTERVAL_SECONDS[baseInterval] ? API_INTERVAL_SECONDS[baseInterval] : 60;
  const barList = React.useMemo(() => {
    const raw = bars.data?.candles ?? [];
    // Keep bars with sane numbers only; the API already sorts/dedups.
    return raw.filter((c) => Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c) && c.h >= c.l);
  }, [bars.data]);
  const executions = React.useMemo(() => opts.executions ?? execs.data?.executions ?? [], [opts.executions, execs.data]);
  const requestDaily = React.useCallback(() => setDailyRequested(true), []);

  return {
    dateKey, toKey, fromKey: bars.data?.from && bars.data.from > fromKey ? bars.data.from : fromKey,
    bars: barList,
    baseInterval, baseSec,
    prevClose: bars.data?.prevClose ?? null,
    executions,
    structure: opts.executions === undefined ? execs.data?.structure ?? null : opts.structure ?? null,
    events: events.data ?? [],
    daily: { bars: daily.data?.candles ?? [], loading: daily.isLoading, requested: dailyRequested, request: requestDaily },
    loading: bars.isLoading || (opts.executions === undefined && execs.isLoading),
    fetching: bars.isFetching,
    error: bars.error ?? null,
    multiDay,
  };
}
