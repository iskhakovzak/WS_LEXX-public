/**
 * «Спроси журнал» book — the compact trade list the client-side question engine runs on (routes/ask.ts).
 * Pure helpers only (unit-tested in __tests__/askBook.test.ts).
 *
 * One SQL query instead of the 10 × /trades/page round trips the page used to make: /trades/page computes a summary,
 * curve, streak and facets over the whole filtered set on every page, which is what made «Загружаю сделки…» take
 * a minute for a curator. Here only the fields the engine reads are selected, and rows go out as tuples
 * (`cols` + `rows`) — about a third of the JSON of trade objects.
 *
 * $ privacy (lib/playbookPrivacy): pnl / fees / qty / riskUsd of a trade the viewer may not see are nulled, same rule
 * as /trades and /trades/page. The snapshot qty is folded into `qty` before redaction, so it cannot leak around it.
 */
import { canSeeTradeMoney, type MoneyViewer } from "./playbookPrivacy";

/** Hard cap: the engine runs in the browser; a desk book is ~25k rows today. */
export const ASK_BOOK_MAX_ROWS = 60_000;

export const ASK_BOOK_COLS = [
  "id", "ticker", "date", "exitDate", "side", "trader", "setup", "holdTime", "qty", "result",
  "entry", "exit", "stop", "rMultiple", "pnl", "fees", "riskUsd", "horizon", "openedAt", "closedAt",
] as const;
export type AskBookCol = (typeof ASK_BOOK_COLS)[number];

/** Row as selected by ASK_BOOK_SQL (pg returns numerics as strings). */
export interface AskBookDbRow {
  id: number;
  ticker: string | null;
  date: string | null;
  exit_date: string | null;
  side: string | null;
  trader: string | null;
  setup: string | null;
  hold_time: string | null;
  qty: string | number | null;
  result: string | null;
  entry: string | number | null;
  exit: string | number | null;
  stop: string | number | null;
  r_multiple: string | number | null;
  pnl: string | number | null;
  fees: string | number | null;
  risk_usd: string | number | null;
  horizon: string | null;
  opened_at: string | null;
  closed_at: string | null;
  snap_qty: string | null;
}

/** `scope` null = whole desk (staff), otherwise one trader name (or the guest sentinel, which matches nobody). */
export function askBookQuery(scope: string | null, limit = ASK_BOOK_MAX_ROWS): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let where = "deleted_at IS NULL";
  if (scope != null) {
    params.push(scope);
    where += ` AND trader = $${params.length}`;
  }
  params.push(limit + 1);
  const sql = `SELECT id, ticker, date, exit_date, side, trader, setup, hold_time, qty, result, entry, exit, stop, r_multiple,
      pnl, fees, risk_usd, horizon,
      context_snapshot->>'openedAt' AS opened_at, context_snapshot->>'closedAt' AS closed_at, context_snapshot->>'qty' AS snap_qty
    FROM trades WHERE ${where} ORDER BY date DESC, id DESC LIMIT $${params.length}`;
  return { sql, params };
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

type Cell = string | number | null;

/** One DB row → tuple in ASK_BOOK_COLS order, with $ nulled when the viewer may not see this trade's money. */
export function askBookTuple(r: AskBookDbRow, viewer: MoneyViewer): Cell[] {
  const money = canSeeTradeMoney(viewer, r.trader);
  const qty = numOrNull(r.qty) ?? numOrNull(r.snap_qty);
  return [
    r.id,
    (r.ticker ?? "").toUpperCase(),
    r.date ?? null,
    r.exit_date || null,
    r.side ?? null,
    r.trader ?? null,
    r.setup ?? null,
    r.hold_time ?? null,
    money ? qty : null,
    r.result ?? null,
    numOrNull(r.entry),
    numOrNull(r.exit),
    numOrNull(r.stop),
    numOrNull(r.r_multiple),
    money ? numOrNull(r.pnl) : null,
    money ? numOrNull(r.fees) : null,
    money ? numOrNull(r.risk_usd) : null,
    r.horizon ?? null,
    r.opened_at ?? null,
    r.closed_at ?? null,
  ];
}

export interface AskBookResponse {
  cols: readonly AskBookCol[];
  rows: Cell[][];
  truncated: boolean;
  /** Effective scope: a trader name, or null for the whole desk. */
  scope: string | null;
  /** Some rows had their $ nulled for this viewer. */
  redacted: boolean;
}

export function askBookResponse(dbRows: AskBookDbRow[], viewer: MoneyViewer, scope: string | null, limit = ASK_BOOK_MAX_ROWS): AskBookResponse {
  const truncated = dbRows.length > limit;
  const kept = truncated ? dbRows.slice(0, limit) : dbRows;
  let redacted = false;
  const rows = kept.map((r) => {
    if (!redacted && !canSeeTradeMoney(viewer, r.trader)) redacted = true;
    return askBookTuple(r, viewer);
  });
  return { cols: ASK_BOOK_COLS, rows, truncated, scope, redacted };
}

// ── Compact wire format (?enc=2) ──────────────────────────────────────────────
// The desk book is ~45k rows; as plain tuples that is ~9.5 MB of JSON, two thirds of it repeated strings (setup and
// trader names, dates) and full ISO timestamps. enc=2 sends:
//   • string columns in ASK_BOOK_DICT_COLS as indexes into `dicts[col]` (null stays null);
//   • openedAt / closedAt as seconds since midnight of the trade's date (closedAt: exitDate ?? date) when the stamp is
//     a plain `YYYY-MM-DDTHH:MM:SS` on that day — anything else goes out unchanged as a string.
// The client (edge-tracker lib/ask/run.ts tradesFromTuples) restores the exact strings. Plain tuples stay the default
// so a browser still running an older bundle keeps working against a newer API.

export const ASK_BOOK_DICT_COLS = ["ticker", "date", "exitDate", "side", "trader", "setup", "holdTime", "result", "horizon"] as const satisfies readonly AskBookCol[];
export const ASK_BOOK_CLOCK_COLS = { openedAt: "date", closedAt: "exitDate" } as const satisfies Partial<Record<AskBookCol, AskBookCol>>;

export interface AskBookCompactResponse extends AskBookResponse {
  enc: 2;
  dicts: Partial<Record<AskBookCol, string[]>>;
  /** Columns sent as seconds since midnight of the base date column. */
  clock: Partial<Record<AskBookCol, AskBookCol>>;
}

const STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** Seconds since midnight of `base` when `stamp` is a plain wall-clock stamp on that day, else the stamp itself. */
export function clockCell(stamp: Cell, base: Cell): Cell {
  if (typeof stamp !== "string" || typeof base !== "string") return stamp;
  const m = STAMP_RE.exec(stamp);
  if (!m || m[1] !== base) return stamp;
  return Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export function askBookCompact(resp: AskBookResponse): AskBookCompactResponse {
  const ix = (k: AskBookCol) => ASK_BOOK_COLS.indexOf(k);
  const iDate = ix("date"), iExit = ix("exitDate");
  const clocks = [
    { i: ix("openedAt"), base: (r: Cell[]) => r[iDate] },
    { i: ix("closedAt"), base: (r: Cell[]) => r[iExit] ?? r[iDate] },
  ];
  const dictCols = ASK_BOOK_DICT_COLS.map((k) => ({ k, i: ix(k), idx: new Map<string, number>(), list: [] as string[] }));
  const rows = resp.rows.map((src) => {
    const r = src.slice();
    // Clock first: it reads the raw date strings before they become dictionary indexes.
    for (const c of clocks) r[c.i] = clockCell(src[c.i], c.base(src));
    for (const d of dictCols) {
      const v = src[d.i];
      if (v == null) continue;
      const s = String(v);
      let n = d.idx.get(s);
      if (n === undefined) { n = d.list.length; d.list.push(s); d.idx.set(s, n); }
      r[d.i] = n;
    }
    return r;
  });
  const dicts: Partial<Record<AskBookCol, string[]>> = {};
  for (const d of dictCols) dicts[d.k] = d.list;
  return { ...resp, rows, enc: 2, dicts, clock: { ...ASK_BOOK_CLOCK_COLS } };
}
