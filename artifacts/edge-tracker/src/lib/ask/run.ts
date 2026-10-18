// «Спроси журнал» — loading and execution.
// The book is loaded once per scope and cached by react-query under ASK_BOOK_KEY; every question then runs
// synchronously on the client. GET only, no AI.
//
// Scope: the signed-in trader's own book by default (small — loads in well under a second). Staff get the whole desk
// only when the question needs it (names another trader, «весь деск», «по трейдерам», compare traders) or when they
// have no trades of their own — see askBookScope.
//
// Source: GET /api/ask/book?enc=2 — one SQL query, only the fields the engine reads, rows as tuples with repeated
// strings dictionary-encoded and clock stamps as seconds, gzipped (api-server routes/ask.ts, lib/askBook.ts). Fallback while an older API is running (404): cursor paging over /api/trades/page, scoped the same
// way, ≤ ASK_MAX_PAGES × ASK_PAGE_LIMIT trades.

import { http, apiErrorFromResponse } from "@/lib/api/http";
import { links } from "@/lib/links";
import {
  applyFilter, buildAnswer, buildCompare, indexBook, MAX_LINK_IDS,
  type AskAnswer, type AskLinkParams, type AskTrade, type BookIndex,
} from "./aggregate";
import { filterOf, type AskFilter, type AskQuery } from "./parse";
import { askI18n } from "@/i18n/ns/ask";

export const ASK_PAGE_LIMIT = 500;
export const ASK_MAX_PAGES = 10;
/** Starts with "/api/trades" ⇒ invalidated together with every trade-dependent query. */
export const ASK_BOOK_KEY = ["/api/trades/ask-book"] as const;

/** "mine" = the viewer's own trades; "desk" = everything the session may read (staff: the whole desk). */
export type AskBookScope = "mine" | "desk";

export const askBookKey = (scope: AskBookScope) => [...ASK_BOOK_KEY, scope] as const;

export interface AskLoadProgress {
  /** Bytes (or trades, in the fallback) received so far. */
  loaded: number;
  /** Total when known. */
  total: number | null;
}

type PageResponse = { items?: AskTrade[]; page?: { hasMore?: boolean; nextCursor?: string | null } };
type Cell = string | number | null;
type CompactResponse = {
  cols?: string[];
  rows?: Cell[][];
  truncated?: boolean;
  /** enc=2: column → dictionary; the column's cells are indexes into it. */
  dicts?: Record<string, string[]>;
  /** enc=2: column → base date column; numeric cells are seconds since midnight of that date (closedAt falls back to date). */
  clock?: Record<string, string>;
};

export interface TupleEncoding {
  dicts?: Record<string, string[]>;
  clock?: Record<string, string>;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Seconds since midnight on `base` → "YYYY-MM-DDTHH:MM:SS" (the exact stamp the API encoded). */
function clockStamp(base: string, sec: number): string {
  return `${base}T${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
}

/** Undo the enc=2 encoding: dictionary indexes → strings, then clock seconds → stamps (reads the decoded dates). */
export function decodeTuples(cols: readonly string[], rows: ReadonlyArray<ReadonlyArray<Cell>>, enc: TupleEncoding = {}): Cell[][] {
  const dicts = Object.entries(enc.dicts ?? {})
    .map(([k, list]) => ({ i: cols.indexOf(k), list }))
    .filter((d) => d.i >= 0);
  const iDate = cols.indexOf("date");
  const clocks = Object.entries(enc.clock ?? {})
    .map(([k, baseCol]) => ({ i: cols.indexOf(k), b: cols.indexOf(baseCol) }))
    .filter((c) => c.i >= 0);
  if (!dicts.length && !clocks.length) return rows as Cell[][];
  return rows.map((src) => {
    const r = src.slice();
    for (const d of dicts) {
      const v = r[d.i];
      if (typeof v === "number") r[d.i] = d.list[v] ?? null;
    }
    for (const c of clocks) {
      const v = r[c.i];
      if (typeof v !== "number") continue;
      const base = (c.b >= 0 ? r[c.b] : null) ?? (iDate >= 0 ? r[iDate] : null);
      r[c.i] = typeof base === "string" ? clockStamp(base, v) : null;
    }
    return r;
  });
}

export interface AskBook {
  trades: AskTrade[];
  truncated: boolean;
  index: BookIndex;
  /** Tickers by trade count (desc). */
  tickers: Array<{ value: string; n: number }>;
  setups: Array<{ value: string; n: number }>;
  traders: Array<{ value: string; n: number }>;
  firstDate: string | null;
  lastDate: string | null;
}

function countBy(values: Array<string | null | undefined>): Array<{ value: string; n: number }> {
  const m = new Map<string, { value: string; n: number }>();
  for (const v of values) {
    const s = (v ?? "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    const e = m.get(k) ?? { value: s, n: 0 };
    e.n++;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
}

export function makeBook(trades: AskTrade[], truncated = false): AskBook {
  const dates = trades.map((t) => t.date).filter(Boolean).sort();
  return {
    trades,
    truncated,
    index: indexBook(trades),
    tickers: countBy(trades.map((t) => (t.ticker ?? "").toUpperCase())),
    setups: countBy(trades.map((t) => t.setup)),
    traders: countBy(trades.map((t) => t.trader)),
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  };
}

/** Which book a question needs. Traders always read their own; staff widen to the desk only when asked to. */
export function askBookScope(q: AskQuery | null, opts: { me: string | null; isStaff: boolean; ownEmpty?: boolean }): AskBookScope {
  if (!opts.isStaff) return "mine";
  if (!opts.me || opts.ownEmpty) return "desk";
  if (!q || !q.ok) return "mine";
  const other = (q.trader != null && q.trader !== opts.me)
    || (q.compare?.dim === "trader");
  const wide = q.allTraders || q.groupBy === "trader" || q.target === "trader";
  return other || wide ? "desk" : "mine";
}

/** Tuples from /api/ask/book → AskTrade (openedAt / closedAt go back into contextSnapshot, where the engine reads them). */
export function tradesFromTuples(cols: readonly string[], encoded: ReadonlyArray<ReadonlyArray<Cell>>, enc?: TupleEncoding): AskTrade[] {
  const rows = decodeTuples(cols, encoded, enc);
  const at = (k: string) => cols.indexOf(k);
  const i = {
    id: at("id"), ticker: at("ticker"), date: at("date"), exitDate: at("exitDate"), side: at("side"), trader: at("trader"),
    setup: at("setup"), holdTime: at("holdTime"), qty: at("qty"), result: at("result"), entry: at("entry"), exit: at("exit"),
    stop: at("stop"), rMultiple: at("rMultiple"), pnl: at("pnl"), fees: at("fees"), riskUsd: at("riskUsd"),
    horizon: at("horizon"), openedAt: at("openedAt"), closedAt: at("closedAt"),
  };
  const v = <T,>(r: ReadonlyArray<string | number | null>, k: number) => (k < 0 ? null : (r[k] ?? null)) as T | null;
  return rows.map((r) => ({
    id: Number(r[i.id]),
    ticker: String(v<string>(r, i.ticker) ?? ""),
    date: String(v<string>(r, i.date) ?? ""),
    exitDate: v<string>(r, i.exitDate),
    side: v<string>(r, i.side),
    trader: v<string>(r, i.trader),
    setup: v<string>(r, i.setup),
    holdTime: v<string>(r, i.holdTime),
    qty: v<number>(r, i.qty),
    result: v<string>(r, i.result),
    entry: v<number>(r, i.entry),
    exit: v<number>(r, i.exit),
    stop: v<number>(r, i.stop),
    rMultiple: v<number>(r, i.rMultiple),
    pnl: v<number>(r, i.pnl),
    fees: v<number>(r, i.fees),
    riskUsd: v<number>(r, i.riskUsd),
    horizon: v<string>(r, i.horizon),
    contextSnapshot: { openedAt: v<string>(r, i.openedAt), closedAt: v<string>(r, i.closedAt) },
  }));
}

/**
 * Reads a JSON body while reporting bytes received. The body arrives decompressed, so the total is X-Raw-Length
 * (uncompressed size, set when the API gzips) and Content-Length only for an uncompressed response.
 */
async function readJson<T>(r: Response, onProgress?: (p: AskLoadProgress) => void): Promise<T> {
  const raw = r.headers.get("x-raw-length");
  const lenHeader = Number(raw ?? (r.headers.get("content-encoding") ? null : r.headers.get("content-length")));
  const total = Number.isFinite(lenHeader) && lenHeader > 0 ? lenHeader : null;
  if (!onProgress || !r.body) return (await r.json()) as T;
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total });
  }
  const all = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return JSON.parse(new TextDecoder().decode(all)) as T;
}

async function fetchPagedBook(scope: AskBookScope, me: string | null, signal?: AbortSignal, onProgress?: (p: AskLoadProgress) => void): Promise<AskBook> {
  const out: AskTrade[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < ASK_MAX_PAGES; page++) {
    const p = new URLSearchParams({ sort: "date", dir: "desc", limit: String(ASK_PAGE_LIMIT) });
    if (scope === "mine" && me) p.set("trader", me);
    if (cursor) p.set("cursor", cursor);
    const j = await http.get<PageResponse>(`/api/trades/page?${p.toString()}`, { signal });
    out.push(...(j.items ?? []));
    onProgress?.({ loaded: out.length, total: null });
    if (!j.page?.hasMore || !j.page.nextCursor) return makeBook(out, false);
    cursor = j.page.nextCursor;
  }
  return makeBook(out, true);
}

/** The book for `scope` («mine» — the viewer's own trades; «desk» — every trade the session may read). */
export async function fetchAskBook(
  scope: AskBookScope = "desk",
  opts: { me?: string | null; signal?: AbortSignal; onProgress?: (p: AskLoadProgress) => void } = {},
): Promise<AskBook> {
  const { me = null, signal, onProgress } = opts;
  const r = await http.raw(`/api/ask/book?enc=2${scope === "mine" ? "&mine=1" : ""}`, { signal, throwOnError: false });
  // Older API without the route: 404 in dev, the SPA's index.html (200, text/html) in production.
  const isJson = (r.headers.get("content-type") ?? "").includes("json");
  if (r.status === 404 || (r.ok && !isJson)) return fetchPagedBook(scope, me, signal, onProgress);
  if (!r.ok) throw await apiErrorFromResponse(r);
  const j = await readJson<CompactResponse>(r, onProgress);
  return makeBook(tradesFromTuples(j.cols ?? [], j.rows ?? [], { dicts: j.dicts, clock: j.clock }), Boolean(j.truncated));
}

/** href into /trades with the parameters the trades page reads. */
export function tradesHref(l: AskLinkParams): string {
  return links.trades({
    ticker: l.ticker, setup: l.setup, date: l.date, from: l.date ? undefined : l.from, to: l.date ? undefined : l.to,
    ids: l.ids, side: l.side, outcome: l.outcome, trader: l.trader,
  });
}

export interface AskRunOptions {
  /** Signed-in trader name: the default scope unless the question names a trader or the whole desk. */
  me?: string | null;
}

export interface AskRun {
  answer: AskAnswer;
  href: string;
  /** The effective filter (with the default trader applied). */
  filter: AskFilter;
  /** Trader the answer was scoped to by default (not named in the question). */
  defaultTrader: string | null;
}

/** Runs a parsed question over the loaded book (synchronous, pure). */
export function runAsk(q: AskQuery, book: AskBook, opts: AskRunOptions = {}): AskRun {
  const base = filterOf(q);
  const traderNamed = Boolean(q.trader) || q.compare?.dim === "trader";
  const scopeDesk = q.allTraders || q.groupBy === "trader" || q.target === "trader";
  const known = new Set(book.traders.map((t) => t.value));
  const defaultTrader = !traderNamed && !scopeDesk && opts.me && known.has(opts.me) ? opts.me : null;
  const f: AskFilter = { ...base, trader: base.trader ?? defaultTrader };
  const scope = f.trader ? book.trades.filter((t) => t.trader === f.trader) : book.trades;
  const meta = { truncated: book.truncated, maxLinkIds: MAX_LINK_IDS, total: scope.length };

  if (q.intent === "compare" && q.compare) {
    const fa: AskFilter = { ...f, ...q.compare.a.patch };
    const fb: AskFilter = { ...f, ...q.compare.b.patch };
    const ra = applyFilter(book.trades, fa, book.index);
    const rb = applyFilter(book.trades, fb, book.index);
    const notes: string[] = [];
    const noTime = ra.noTime + rb.noTime;
    if (noTime) notes.push(askI18n.t("ans.noTime", { count: noTime }));
    const answer = buildCompare(q, f, ra.kept, rb.kept, book.index, { ...meta, notes });
    return { answer, href: tradesHref(answer.link), filter: f, defaultTrader };
  }

  const r = applyFilter(book.trades, f, book.index);
  const answer = buildAnswer(q, f, r.kept, book.index, { ...meta, noTime: r.noTime, noHold: r.noHold, noPrice: r.noPrice, noQty: r.noQty });
  return { answer, href: tradesHref(answer.link), filter: f, defaultTrader };
}
