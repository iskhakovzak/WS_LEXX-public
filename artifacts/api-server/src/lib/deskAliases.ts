/**
 * Day aliases for anonymous cross-trader views (owner decision 2026-10-18: names hidden from traders on the desk-day
 * chart and the top of the day; staff see names). Every trader active on a day gets a number 1..N for THAT day only
 * («Трейдер 3» is rendered by the client from {alias: 3}); the same day gives the same numbers on every page, so the
 * top list can open the same trader on the chart. The order is a keyed hash, so numbers can't be recomputed from known
 * names, and a new day shuffles them (no tracking one alias across days).
 */
import { createHmac } from "node:crypto";
import { config } from "../config";

function keyed(date: string, trader: string): string {
  return createHmac("sha256", `${config.jwtSecret}:desk-alias`).update(`${date}\u0000${trader}`).digest("hex");
}

/** trader → alias number (1-based) for `date`. Pass every trader active that day (order does not matter). */
export function deskAliases(traders: Iterable<string>, date: string): Map<string, number> {
  const uniq = [...new Set(traders)].filter(Boolean);
  uniq.sort((a, b) => keyed(date, a).localeCompare(keyed(date, b)));
  return new Map(uniq.map((t, i) => [t, i + 1]));
}
