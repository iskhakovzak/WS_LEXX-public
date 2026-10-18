/**
 * «Деск на тикере» — data. Mirror of api-server lib/deskDay.ts (GET /api/desk-day/:ticker/:date) and the candle archive
 * day (GET /api/candles/:ticker/day/:date). $ / sizes arrive as null for trades the viewer may not see money for.
 *
 * Views (server lib/deskDay.ts): "staff" — names + $; "anonymous" — a trader while names are hidden: trader keys are
 * "t<alias>" (rendered «Трейдер {n}», the viewer's own row «я») and $ is shown; "named" — names, others' $ hidden.
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
  /** Real name (staff / named view) or the alias key "t<alias>" (anonymous view). */
  name: string;
  /** Day alias (same person = same number on every ticker that day; the `alias` URL param). */
  alias: number | null;
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

export type DeskView = "staff" | "anonymous" | "named";

export type OfficeZone = { from: string; to: string; low: number; high: number; vwap: number };

/** The whole desk as one position on the ticker-day (server lib/deskOffice.ts). % = signed share of the day's peak. */
export type DeskOffice = {
  side: Side;
  traders: number;
  peakAt: string;
  /** Staff only. */
  peakShares: number | null;
  startPct: number;
  /** Net position after every minute with a fill (minute start, epoch s). */
  path: { t: number; pct: number; shares: number | null }[];
  avgEntry: number | null;
  avgExit: number | null;
  build: OfficeZone | null;
  exit: OfficeZone | null;
  net: number | null;
  contributors: { trader: string; alias: number | null; me: boolean; share: number }[];
  against: number;
  coverage: number;
};

export type DeskDay = {
  ticker: string;
  date: string;
  view: DeskView;
  me: string | null;
  traders: DeskTrader[];
  trades: DeskTrade[];
  takeaways: DeskTakeaway[];
  office: DeskOffice | null;
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
