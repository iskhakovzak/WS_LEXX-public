/**
 * Fee columns: detection (known names + heuristic for unknown numeric columns) and owner-configurable
 * include/exclude/rename settings that decide how `totalFees` is summed on every sync.
 *
 * Every fee-like column becomes a key in `FeeBreakdown`: known PropReports names map to the canonical keys in
 * FEE_KEYS (comm, ecn, sec, orf, taf, nfa, cat, nscc, acc, clr, misc); anything else gets a slug of its header
 * (e.g. "Nasdaq Fee" → "nasdaq_fee"). The full breakdown is kept per trade in context_snapshot.feesByType.
 */
import { normHeader, parseNum, round4 } from "./csv";
import { FEE_KEYS, FEE_LABEL_RU, type FeeBreakdown, type RoundTrip } from "./types";
import { propreportsT } from "../../i18n/ns";
import type { Lang } from "../../i18n";

/** Header spellings that are NOT fees (identity / price / qty columns) — never treated as a fee even if numeric. */
export const NON_FEE_HEADERS = new Set([
  "date/time", "datetime", "date time", "time", "exec time", "execution time", "date", "trade date", "tradedate", "session date",
  "account", "account name", "acct", "account id", "b/s", "side", "bs", "type", "qty", "quantity", "shares", "size",
  "symbol", "sym", "ticker", "price", "exec price", "fill price", "route", "exchange", "venue", "order id", "orderid", "ticket",
  "fill id", "fillid", "exec id", "execution id", "propreports id", "propreportsid", "pr id", "status", "liquidity", "currency",
  "multiplier", "spot rate", "notes", "note", "gross", "net", "opened", "closed", "held", "entry", "exit", "avg", "close",
  "unrealized", "unrealized delta", "realized", "qty traded", "orders", "fills", "trade fees", "start balance", "end balance",
  "cash", "groups", "group id", "group name", "first traded", "last traded",
]);

const KNOWN: Array<[RegExp, string]> = [
  [/^(comm|commission|commissions)$/, "comm"],
  [/^(ecn|ecn fee|ecn fees)$/, "ecn"],
  [/^(sec|sec fee)$/, "sec"],
  [/^orf$/, "orf"],
  [/^(taf|taf fee|finra taf)$/, "taf"],
  [/^nfa$/, "nfa"],
  [/^(cat|cat fee)$/, "cat"],
  [/^nscc$/, "nscc"],
  [/^(acc|access|access fee)$/, "acc"],
  [/^(clr|clearing|clearing fee)$/, "clr"],
  [/^(misc|misc fee|other)$/, "misc"],
];

/** Header looks like a fee (used for columns that are not in the known list). */
const FEE_HINT = /fee|comm|finra|nasdaq|nyse|arca|bats|edge|locate|borrow|route|ecn|sec\b|taf|nscc|clr|clear|misc|orf|nfa|cat\b|access|pass.?thr|charge|rebate|margin|interest|short/;

export function feeKeyFor(header: string): { key: string; known: boolean } | null {
  const h = normHeader(header);
  if (!h || NON_FEE_HEADERS.has(h)) return null;
  for (const [re, key] of KNOWN) if (re.test(h)) return { key, known: true };
  if (FEE_HINT.test(h)) return { key: slug(h), known: false };
  return null;
}

export function slug(h: string): string {
  return normHeader(h).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "col";
}

export interface DetectedFeeColumn {
  key: string;
  header: string;
  known: boolean;
  /** true when the column was taken only because every value in it was numeric (heuristic). */
  heuristic: boolean;
}

/**
 * Pick the fee columns of a table: known names, fee-looking headers, plus any unknown column whose non-empty
 * values are all numeric (and which is not an identity column). `rows` is sampled for the heuristic.
 */
export function detectFeeColumns(header: string[], rows: string[][], mapped: Set<number>): DetectedFeeColumn[] {
  const out: DetectedFeeColumn[] = [];
  const seen = new Set<string>();
  header.forEach((raw, i) => {
    if (mapped.has(i)) return;
    const h = normHeader(raw);
    if (!h || NON_FEE_HEADERS.has(h)) return;
    let col = feeKeyFor(raw);
    let heuristic = false;
    if (!col) {
      // unknown column: numeric everywhere it is filled → treat as a fee
      let filled = 0, numeric = 0;
      for (const r of rows.slice(0, 500)) {
        const v = (r[i] ?? "").trim();
        if (!v) continue;
        filled++;
        if (Number.isFinite(parseNum(v))) numeric++;
      }
      if (filled && numeric === filled) { col = { key: slug(raw), known: false }; heuristic = true; }
    }
    if (!col) return;
    let key = col.key;
    while (seen.has(key)) key = `${key}_`;
    seen.add(key);
    out.push({ key, header: raw.trim(), known: col.known, heuristic });
  });
  return out;
}

export function feeLabel(key: string, settings?: FeeSettings | null, lang: Lang = "ru"): string {
  const custom = settings?.columns[key]?.label;
  if (custom) return custom;
  return propreportsT.tryFor(lang, `fee.${key}`) ?? (FEE_LABEL_RU as Record<string, string>)[key] ?? key.replace(/_/g, " ");
}

// ─── settings ───────────────────────────────────────────────────────────────

export interface FeeColumnSetting { include: boolean; label?: string | null; header?: string | null; known?: boolean; heuristic?: boolean; lastSeenAt?: string | null }
export interface FeeSettings {
  /** key → setting; keys missing here are included by default. */
  columns: Record<string, FeeColumnSetting>;
  /** Columns seen in the last applied import/sync (for the UI list). */
  detected: DetectedFeeColumn[];
  confirmedAt: string | null;
}

export const DEFAULT_FEE_SETTINGS: FeeSettings = { columns: {}, detected: [], confirmedAt: null };

export function isFeeIncluded(key: string, settings: FeeSettings | null | undefined): boolean {
  return settings?.columns[key]?.include !== false;
}

export function sumFeesWith(fees: FeeBreakdown, settings: FeeSettings | null | undefined): number {
  let s = 0;
  for (const k of Object.keys(fees)) if (isFeeIncluded(k, settings)) s += fees[k] || 0;
  return s;
}

/** Re-sum totalFees / netPnl / result of every trip according to the owner's include/exclude settings. */
export function applyFeeSettings(trips: RoundTrip[], settings: FeeSettings | null | undefined): RoundTrip[] {
  if (!settings || !Object.keys(settings.columns).length) return trips;
  return trips.map((t) => {
    // 4 decimals: PropReports fees go down to $0.0001 — cent rounding per trade drifts the book (audit P0-1)
    const totalFees = round4(sumFeesWith(t.fees, settings));
    if (Math.abs(totalFees - t.totalFees) < 0.00005) return t;
    const netPnl = round4(t.grossPnl - totalFees);
    const result: RoundTrip["result"] = t.open ? "open" : netPnl > 0 ? "win" : netPnl < 0 ? "loss" : "breakeven";
    const executions = t.executions.map((e) => ({ ...e, fees: round4(sumFeesWith(e.feesByType ?? {}, settings)) }));
    return { ...t, totalFees, netPnl, result, executions };
  });
}

/** Known keys first (canonical order), then detected extras. */
export function orderedFeeKeys(keys: Iterable<string>): string[] {
  const set = new Set(keys);
  const known = FEE_KEYS.filter((k) => set.has(k));
  const rest = [...set].filter((k) => !(FEE_KEYS as readonly string[]).includes(k)).sort();
  return [...known, ...rest];
}
