/**
 * «Деск на тикере» — data. Mirror of api-server lib/deskDay.ts (GET /api/desk-day/:ticker/:date) and the candle archive
 * day (GET /api/candles/:ticker/day/:date). $ / sizes arrive as null for trades the viewer may not see money for.
 */
import { useQuery } from "@tanstack/react-query";
import { http, type ApiError } from "@/lib/api/http";
import type { Candle, TradeRole } from "@/components/chart-engine/types";

export type Side = "long" | "short";
export type DayResult = "win" | "loss" | "be" | "open";

export type DeskLeg = {
  role: TradeRole;
  price: number;
  at: string | null;
  atEnd: string | null;
  opening: boolean;
  buy: boolean;
  pieces: number;
  inferred: boolean;
  fraction: number | null;
  perShare: number | null;
  r: number | null;
  qty: number | null;
  realized: number | null;
};

export type DeskTrade = {
  id: number;
  trader: string;
  side: Side;
  result: DayResult | null;
  r: number | null;
  firstAt: string | null;
  lastAt: string | null;
  holdSec: number | null;
  avgEntry: number | null;
  avgExit: number | null;
  stopPrice: number | null;
  stopHit: boolean;
  reentryIndex: number;
  adds: number;
  partials: number;
  addedAgainst: boolean;
  fidelity: "fills" | "averages";
  net: number | null;
  qty: number | null;
  redacted: boolean;
  legs: DeskLeg[];
};

export type DeskTrader = {
  name: string;
  me: boolean;
  side: Side | "both";
  trades: number;
  result: DayResult | null;
  r: number | null;
  firstAt: string | null;
  lastAt: string | null;
  holdSec: number | null;
  addedAgainst: boolean;
  net: number | null;
  redacted: boolean;
};

export type DeskTakeaway =
  | { kind: "best"; trader: string; r: number; side: Side; at: string; minutesFromOpen: number }
  | { kind: "averaging"; losers: number; averaged: number }
  | { kind: "timing"; winnersAt: string; losersAt: string; winners: number; losers: number }
  | { kind: "sides"; long: { traders: number; winners: number }; short: { traders: number; winners: number } };

export type DeskDay = {
  ticker: string;
  date: string;
  me: string | null;
  traders: DeskTrader[];
  trades: DeskTrade[];
  takeaways: DeskTakeaway[];
};

export type DayCandles = { ticker: string; date: string; tf: string; candles: Candle[]; prevClose: number | null };

const noRetry = (count: number, err: unknown) => {
  const s = (err as ApiError).status;
  return s !== 422 && s !== 400 && s !== 404 && s !== 401 && s !== 403 && count < 1;
};

export function useDeskDay(ticker: string, date: string, enabled = true) {
  return useQuery<DeskDay, ApiError>({
    queryKey: ["desk-day", ticker, date],
    queryFn: ({ signal }) => http.get<DeskDay>(`/api/desk-day/${encodeURIComponent(ticker)}/${date}`, { signal }),
    enabled: enabled && !!ticker && !!date,
    staleTime: 60_000,
    retry: noRetry,
  });
}

/** The whole archived day (04:00–20:00 ET) at its archived bar size. */
export function useDayCandles(ticker: string, date: string, enabled = true) {
  return useQuery<DayCandles, ApiError>({
    queryKey: ["desk-day", "candles", ticker, date],
    queryFn: ({ signal }) => http.get<DayCandles>(`/api/candles/${encodeURIComponent(ticker)}/day/${date}?extended=1`, { signal }),
    enabled: enabled && !!ticker && !!date,
    staleTime: 10 * 60_000,
    retry: noRetry,
    meta: { i18n: false },
  });
}
