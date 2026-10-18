import { safeHttpUrl } from "@/lib/url";

/**
 * TradingView link classification — client twin of api-server lib/planMedia.ts `parseTradingViewUrl`
 * (keep the two in sync; both are covered by tests).
 *
 *   https://www.tradingview.com/x/AbCd1234/          → snapshot, image https://s3.tradingview.com/snapshots/a/AbCd1234.png
 *   https://www.tradingview.com/chart/?symbol=NASDAQ:NVDA · /chart/<layout>/?symbol=… · /chart/NVDA/<idea>/ → chart
 *   https://www.tradingview.com/symbols/NASDAQ-NVDA/ → chart
 *
 * Images are loaded by the browser straight from TradingView (img referrerPolicy="no-referrer"); the API never fetches them.
 */
export type TradingViewLink =
  | { kind: "snapshot"; url: string; id: string; imageUrl: string }
  | { kind: "chart"; url: string; symbol: string | null; exchange: string | null }
  | { kind: "other"; url: string };

const TV_HOST = /^(?:[a-z0-9-]+\.)?tradingview\.com$/i;
const SNAPSHOT_ID = /^[A-Za-z0-9]{6,16}$/;
const SYMBOL = /^[A-Za-z0-9._!-]{1,24}$/;

function splitSymbol(raw: string): { symbol: string | null; exchange: string | null } {
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  s = s.trim();
  const m = s.split(/[:-]/);
  if (m.length >= 2 && SYMBOL.test(m[0]!) && SYMBOL.test(m.slice(1).join("-"))) {
    return { exchange: m[0]!.toUpperCase(), symbol: m.slice(1).join("-").toUpperCase() };
  }
  return SYMBOL.test(s) ? { symbol: s.toUpperCase(), exchange: null } : { symbol: null, exchange: null };
}

export function parseTradingViewUrl(raw: string | null | undefined): TradingViewLink | null {
  const safe = safeHttpUrl(raw);
  if (!safe) return null;
  let u: URL;
  try {
    u = new URL(safe);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !TV_HOST.test(u.hostname) || u.username || u.password) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const url = u.toString();
  if (parts[0] === "x" && parts[1] && SNAPSHOT_ID.test(parts[1])) {
    const id = parts[1];
    return { kind: "snapshot", url, id, imageUrl: `https://s3.tradingview.com/snapshots/${id[0]!.toLowerCase()}/${id}.png` };
  }
  if (parts[0] === "chart") {
    const q = u.searchParams.get("symbol");
    if (q) return { kind: "chart", url, ...splitSymbol(q) };
    const seg = parts[1];
    if (seg && parts.length >= 3 && /^[A-Z0-9.!]{1,12}$/.test(seg)) return { kind: "chart", url, symbol: seg, exchange: null };
    return { kind: "chart", url, symbol: null, exchange: null };
  }
  if (parts[0] === "symbols" && parts[1]) return { kind: "chart", url, ...splitSymbol(parts[1]) };
  return { kind: "other", url };
}

/** All TradingView links found in free text (paste of several links). */
export function extractTradingViewUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  const out: string[] = [];
  for (const raw of found) {
    const tv = parseTradingViewUrl(raw.replace(/[),.;]+$/, ""));
    if (tv && !out.includes(tv.url)) out.push(tv.url);
  }
  return out;
}

/** Chart URL for a ticker — fallback «Открыть в TradingView» when no link was saved. */
export function tradingViewChartFor(ticker: string): string {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(ticker.toUpperCase())}`;
}
