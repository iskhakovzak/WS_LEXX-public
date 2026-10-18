/**
 * Query factories for endpoints that several features read. Each feature transforms the rows with `select`, so the
 * cache always holds the raw server answer (one request, one cache entry).
 */
import { queryOptions } from "@tanstack/react-query";
import { nyDate } from "@/lib/trading-date";
import type { DailyMe } from "@/lib/daily/types";
import { apiErrorStatus } from "./errors";
import { http } from "./http";
import { KEYS, STALE } from "./keys";

/** Row of GET /api/trades?result=open, as much as the readers need. */
export type OpenTradeRow = {
  id: number;
  ticker: string;
  result: string;
  date?: string | null;
  trader?: string | null;
  side?: string | null;
  horizon?: string | null;
  exitDate?: string | null;
  [key: string]: unknown;
};

export const openTradesQuery = () =>
  queryOptions({
    queryKey: KEYS.openTrades(),
    queryFn: ({ signal }) => http.get<OpenTradeRow[]>("/api/trades", { query: { result: "open" }, signal }),
    staleTime: STALE.short,
  });

export const tradeIdeasQuery = <T = unknown>() =>
  queryOptions({
    queryKey: KEYS.tradeIdeas(),
    queryFn: ({ signal }) => http.get<T[]>("/api/trade-ideas", { signal }),
    staleTime: STALE.default,
  });

/**
 * The viewer's own risk state for the NY trading day (GET /api/risk/me?date=). Each reader types the answer with its own
 * `RiskMe` shape (dashboard, risk page) or narrows it with `select` (shell badge).
 */
export const riskMeQuery = <T = unknown>(date: string = nyDate()) =>
  queryOptions({
    queryKey: KEYS.riskMe(date),
    queryFn: ({ signal }) => http.get<T>("/api/risk/me", { query: { date }, signal }),
    staleTime: STALE.default,
  });

/**
 * The viewer's daily loop (GET /api/daily/me): focus, last finished day's evening card, tier progress. Keyed by the NY
 * day; texts travel as keys (rendered by the web dictionaries), so a language switch needs no refetch. 403 → null
 * (a role without a personal loop).
 */
export const dailyMeQuery = (date: string = nyDate()) =>
  queryOptions({
    queryKey: KEYS.dailyMe(date),
    queryFn: ({ signal }) =>
      http.get<DailyMe>("/api/daily/me", { signal }).catch((e: unknown) => {
        if (apiErrorStatus(e) === 403) return null;
        throw e;
      }),
    staleTime: STALE.default,
    meta: { i18n: false },
  });

/** The viewer's personal plan for `date` (GET /api/game-plan/my?date=); each reader types `doc` with its own shape. */
export const myPlanQuery = <T = unknown>(date: string) =>
  queryOptions({
    queryKey: KEYS.myPlan(date),
    queryFn: ({ signal }) => http.get<T>("/api/game-plan/my", { query: { date }, signal }),
    staleTime: STALE.short,
  });
