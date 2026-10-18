/** Trade-day window for the chart's candle request. Pure (today injectable). */
import { addDays, nyDate, prevWeekday } from "@/lib/trading-date";
import type { TradeLike } from "../types";

/**
 * Trade-day window: from `contextDays` weekdays before the entry day to the exit day (or today for open multi-day).
 * Context never costs resolution, and that is decided by the server: it serves the finest bars the trade day has
 * (permanent candle archive, then what the provider still serves for a day that old) and drops older context days that
 * cannot match instead of coarsening the whole range (range route + lib/candleLimits pickServedInterval).
 * `today` is injectable for tests.
 */
export function tradeWindow(trade: TradeLike, contextDays: number, today: string = nyDate()): { dateKey: string; toKey: string; fromKey: string; multiDay: boolean } {
  const dateKey = (trade.date || "").slice(0, 10);
  const multiDay = trade.horizon === "overnight" || trade.horizon === "swing";
  const exitKey = trade.exitDate ? trade.exitDate.slice(0, 10) : null;
  let toKey = dateKey;
  if (multiDay) {
    if (exitKey && exitKey > dateKey) toKey = exitKey;
    else if (trade.result === "open") toKey = today;
    else toKey = addDays(dateKey, trade.horizon === "swing" ? 5 : 1);
  }
  if (toKey > today) toKey = today;
  let fromKey = dateKey;
  for (let i = 0; i < Math.max(0, contextDays); i++) fromKey = prevWeekday(fromKey);
  return { dateKey, toKey, fromKey, multiDay };
}

