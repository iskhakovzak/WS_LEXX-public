/**
 * Trade structure — what every fill of a trade did, and how consecutive trades of one symbol connect. Pure.
 *
 *   classifyTrade(executions, ctx)  one trade's fills → legs with a role each + per-trade stats
 *   linkTrades(heads)               trades of the same account+symbol+session → re-entry / flip links
 *
 * Roles (ROLE_LABEL_RU): Вход · Перезаход · Переворот · Добор · Частичный фикс · Выход · Стоп.
 *
 * Legs. Fills of one order that land together (same order id, or — without order ids — the same second and the same
 * direction) are ONE leg: an order of 300 filled as 100+200 is a single «Вход», not «Вход + Добор». The leg price is
 * the VWAP of its pieces.
 *
 * Position walk (average-cost method, the same as PropReports and round-trips.ts): an opening leg raises the
 * position (first one = entry, later ones = add), a closing leg lowers it (to zero = exit, otherwise
 * partial_exit). A position carried in from before the first known fill (overnight carry, ctx.carriedIn) starts the
 * walk from that size/average; a closing leg with nothing open and no carry is an exit of an unknown position.
 *
 * Stops. With a stop price (trade.stop, or derived from risk_usd) a closing leg at/through the stop is «Стоп».
 * Without one the final exit can be marked as an INFERRED stop (`inferred: true`, with a reason):
 *   - a losing full exit within 5 minutes of an add that averaged the position down/up against the trade, or
 *   - a losing full exit that gave back ≥ 80 % of the worst adverse excursion of the hold (ctx.adverseExtreme from
 *     cached candles, when known) — the trader got out near the bottom (long) / top (short), as a stop does.
 *
 * Fidelity. Trades imported from the PropReports «Trades» report carry only average entry/exit prices
 * (source "report"): the walk then sees one entry and one exit. An average that is not a whole cent proves the
 * side was built from at least two fills at different prices (`scaledEntryLikely` / `scaledExitLikely`).
 *
 * Texts (labels, reasons, notes, summary) come from the server `tradeStructure` namespace in `ctx.lang` (default RU).
 * Reasons and notes are also kept as data (`reasonItem`, `stats.noteItems`, `stats.stopReasonItem`) so a persisted
 * structure can be shown in another language (localizeStats).
 */
import { tradeStructureT } from "../i18n/ns";
import type { Lang, Params } from "../i18n";

/** A reason / note as data: key in the `tradeStructure` namespace + params. */
export type TextItem = { key: string; params?: Params };
const tsText = (lang: Lang, item: TextItem) => tradeStructureT.tryFor(lang, item.key, item.params) ?? item.key;

export type ExecKind = "entry" | "add" | "trim" | "exit" | "stop";
export type LegRole = "entry" | "reentry" | "flip" | "add" | "partial_exit" | "exit" | "stop";
export type TradeSource = "fills" | "report" | "manual";
export type Side = "long" | "short";

const ROLES: readonly LegRole[] = ["entry", "reentry", "flip", "add", "partial_exit", "exit", "stop"];
/** Role label in `lang`. */
export function roleLabel(role: LegRole, lang: Lang = "ru"): string {
  return tradeStructureT.tFor(lang)(`role.${role}`);
}
/** RU labels (kept for older imports). */
export const ROLE_LABEL_RU = Object.fromEntries(ROLES.map((r) => [r, roleLabel(r)])) as Record<LegRole, string>;

/** Opening roles raise the position; the rest lower it. */
export function isOpeningRole(role: LegRole, opening: boolean): boolean {
  return role === "flip" ? opening : role === "entry" || role === "reentry" || role === "add";
}

export interface ExecIn {
  id: number;
  kind: ExecKind;
  price: number;
  /** Shares; null when unknown (manual entry without qty, or redacted). */
  qty: number | null;
  /** ISO instant; null when only the price is known. */
  at: string | null;
  orderId?: string | null;
  sortOrder?: number;
}

export interface TradeLink {
  prevId: number | null;
  nextId: number | null;
  /** 0 = first trade of the symbol in the session, 1 = first re-entry, … */
  reentryIndex: number;
  /** Opened in the same second the previous trade (other side) closed: a reversal through zero. */
  flipIn: boolean;
  /** The next trade opened in the same second this one closed, on the other side. */
  flipOut: boolean;
}

export interface TradeCtx {
  side: Side;
  source: TradeSource;
  stop?: number | null;
  riskUsd?: number | null;
  /** Trade size from the trade row — only used for notes when fills carry no qty. */
  tradeQty?: number | null;
  link?: TradeLink | null;
  /** Most adverse price printed between the first entry and the final exit (from candles), when known. */
  adverseExtreme?: number | null;
  /** Position already open before the first known fill (overnight carry). */
  carriedIn?: { qty: number; avg: number } | null;
  /** Language of labels / reasons / notes (default RU = the persisted fallback). */
  lang?: Lang;
}

export interface Leg {
  index: number;
  role: LegRole;
  label: string;
  /** true = raised the position. */
  opening: boolean;
  executionIds: number[];
  /** Fills folded into this leg (> 1 = one order filled in pieces). */
  pieces: number;
  /** VWAP of the pieces. */
  price: number;
  qty: number | null;
  at: string | null;
  atEnd: string | null;
  positionBefore: number | null;
  positionAfter: number | null;
  /** Average cost of what is still open after the leg (null when flat or unknown). */
  avgAfter: number | null;
  /** Share of the maximum position this leg moved (0–1). */
  fraction: number | null;
  /** Closing legs: per-share result against the average cost at that moment. */
  perShare: number | null;
  /** Closing legs: realised gross $ of this leg. */
  realized: number | null;
  /** Closing legs: realised R of this leg (sum over legs = trade R). */
  r: number | null;
  /** The role is a guess (stop heuristics). */
  inferred: boolean;
  /** Explanation for stop / flip / re-entry roles (in ctx.lang). */
  reason: string | null;
  /** The same explanation as data. */
  reasonItem?: TextItem | null;
}

export interface StructureStats {
  v: 2;
  source: TradeSource;
  /** "fills" = every fill known; "averages" = only average entry/exit prices (Trades report). */
  fidelity: "fills" | "averages";
  side: Side;
  legs: number;
  /** Opening legs (entry + adds). */
  entries: number;
  adds: number;
  partials: number;
  /** Closing legs (partials + final exit/stop). */
  exits: number;
  /** Fills folded into multi-piece legs (partial fills of one order). */
  splitFills: number;
  avgEntry: number | null;
  avgExit: number | null;
  maxPosition: number | null;
  openQty: number | null;
  realized: number | null;
  rTotal: number | null;
  riskPerShare: number | null;
  stopPrice: number | null;
  stopHit: boolean;
  stopInferred: boolean;
  stopReason: string | null;
  /** stopReason as data (localizeStats). */
  stopReasonItem?: TextItem | null;
  reentryIndex: number;
  prevId: number | null;
  nextId: number | null;
  flipIn: boolean;
  flipOut: boolean;
  carriedIn: boolean;
  scaledEntryLikely: boolean;
  scaledExitLikely: boolean;
  firstAt: string | null;
  lastAt: string | null;
  notes: string[];
  /** notes as data (localizeStats). */
  noteItems?: TextItem[];
}

export interface TradeStructure {
  legs: Leg[];
  stats: StructureStats;
  /** Execution id → its leg's role / index. */
  byExecution: Record<number, { role: LegRole; legIndex: number; inferred: boolean }>;
}

const EPS = 1e-9;
const OPENING_KINDS: ReadonlySet<ExecKind> = new Set(["entry", "add"]);
/** A losing exit this soon after an adverse add reads as «averaged down, then stopped». */
const STOP_AFTER_ADD_SECONDS = 300;
/** A losing exit that gave back at least this share of the trade's worst adverse excursion reads as a stop. */
const STOP_NEAR_WORST_SHARE = 0.8;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const epochOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t / 1000 : null;
};

/** True when a price (≥ $1, sub-penny quotes excluded) is not a whole cent — an average of fills at different prices. */
export function isFractionalCent(price: number | null | undefined): boolean {
  if (price == null || !Number.isFinite(price) || price < 1) return false;
  const c = round4(price) * 100;
  return Math.abs(c - Math.round(c)) > 1e-6;
}

function fmt(p: number): string {
  return p >= 1 ? p.toFixed(2) : p.toFixed(4);
}

/** Chronological order when every fill is timed, else the logged order (sortOrder, id). */
function ordered(execs: readonly ExecIn[]): ExecIn[] {
  const allTimed = execs.length > 0 && execs.every((e) => epochOf(e.at) != null);
  return [...execs].sort((a, b) => {
    if (allTimed) {
      const d = (epochOf(a.at) as number) - (epochOf(b.at) as number);
      if (d !== 0) return d;
    }
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id;
  });
}

/** Do two consecutive fills belong to one order (→ one leg)? */
function sameOrder(a: ExecIn, b: ExecIn): boolean {
  if (OPENING_KINDS.has(a.kind) !== OPENING_KINDS.has(b.kind)) return false;
  if (a.orderId && b.orderId) return a.orderId === b.orderId;
  const ta = epochOf(a.at), tb = epochOf(b.at);
  return ta != null && tb != null && Math.floor(ta) === Math.floor(tb);
}

type RawLeg = { opening: boolean; execs: ExecIn[]; price: number; qty: number | null; explicitStop: boolean };

function groupLegs(execs: readonly ExecIn[]): RawLeg[] {
  const legs: RawLeg[] = [];
  for (const e of ordered(execs)) {
    const last = legs[legs.length - 1];
    if (last && sameOrder(last.execs[last.execs.length - 1], e)) last.execs.push(e);
    else legs.push({ opening: OPENING_KINDS.has(e.kind), execs: [e], price: 0, qty: null, explicitStop: false });
  }
  for (const l of legs) {
    const known = l.execs.every((e) => e.qty != null && e.qty > 0);
    const w = (e: ExecIn) => (known ? (e.qty as number) : 1);
    const tw = l.execs.reduce((s, e) => s + w(e), 0);
    l.price = l.execs.reduce((s, e) => s + e.price * w(e), 0) / tw;
    l.qty = known ? l.execs.reduce((s, e) => s + (e.qty as number), 0) : null;
    l.explicitStop = l.execs.some((e) => e.kind === "stop");
  }
  return legs;
}

export function classifyTrade(execs: readonly ExecIn[], ctx: TradeCtx): TradeStructure {
  const dir = ctx.side === "short" ? -1 : 1;
  const raw = groupLegs(execs.filter((e) => Number.isFinite(e.price) && e.price > 0));
  const qtyKnown = raw.length > 0 && raw.every((l) => l.qty != null);
  const carry = ctx.carriedIn && ctx.carriedIn.qty > 0 ? ctx.carriedIn : null;
  const link = ctx.link ?? null;
  const lang: Lang = ctx.lang ?? "ru";
  const noteItems: TextItem[] = [];

  // ── position walk ──
  let pos = qtyKnown && carry ? carry.qty : 0;
  let avg: number | null = qtyKnown && carry ? carry.avg : null;
  let maxPos = pos;
  let unknownCarryExit = false;
  const legs: Leg[] = [];
  const lastClosingIdx = (() => { for (let i = raw.length - 1; i >= 0; i--) if (!raw[i].opening) return i; return -1; })();
  let openingSeen = carry ? 1 : 0;
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i];
    const first = l.execs[0], lastE = l.execs[l.execs.length - 1];
    const leg: Leg = {
      index: i, role: "entry", label: "", opening: l.opening, executionIds: l.execs.map((e) => e.id), pieces: l.execs.length,
      price: round4(l.price), qty: l.qty, at: first.at, atEnd: lastE.at,
      positionBefore: qtyKnown ? pos : null, positionAfter: null, avgAfter: null, fraction: null,
      perShare: null, realized: null, r: null, inferred: false, reason: null, reasonItem: null,
    };
    if (l.opening) {
      const flatBefore = qtyKnown ? pos <= EPS : openingSeen === 0;
      leg.role = openingSeen === 0 || flatBefore ? (openingSeen === 0 ? "entry" : "reentry") : "add";
      if (leg.role === "reentry") leg.reasonItem = { key: "reason.reentryInTrade" };
      openingSeen++;
      if (qtyKnown) {
        const q = l.qty as number;
        avg = pos + q > EPS ? ((avg ?? l.price) * pos + l.price * q) / (pos + q) : l.price;
        pos += q;
        maxPos = Math.max(maxPos, pos);
      }
    } else {
      const avgForLeg = qtyKnown ? avg : openingAvg(raw);
      if (avgForLeg != null) leg.perShare = round4(dir * (l.price - avgForLeg));
      if (qtyKnown) {
        const q = l.qty as number;
        if (pos <= EPS) unknownCarryExit = true;
        const closed = Math.min(q, Math.max(0, pos));
        if (avg != null && closed > 0) leg.realized = round4(dir * (l.price - avg) * closed);
        pos = Math.max(0, pos - q);
        leg.role = pos <= EPS ? "exit" : "partial_exit";
      } else {
        leg.role = i === lastClosingIdx ? "exit" : "partial_exit";
      }
      if (l.explicitStop) { leg.role = "stop"; leg.reasonItem = { key: "reason.markedStop" }; }
    }
    if (qtyKnown) {
      leg.positionAfter = round4(pos);
      leg.avgAfter = pos > EPS && avg != null ? round4(avg) : null;
      if (pos <= EPS) avg = null;
    }
    legs.push(leg);
  }
  if (qtyKnown && maxPos > EPS) for (const leg of legs) if (leg.qty != null) leg.fraction = round4(Math.min(1, leg.qty / maxPos));

  // ── links: first entry = re-entry / flip, final exit = flip ──
  const firstOpen = legs.find((l) => l.opening);
  if (firstOpen && firstOpen.role === "entry" && !carry && link) {
    if (link.flipIn) { firstOpen.role = "flip"; firstOpen.reasonItem = { key: "reason.flipIn" }; }
    else if (link.reentryIndex > 0) { firstOpen.role = "reentry"; firstOpen.reasonItem = { key: "reason.reentryN", params: { n: link.reentryIndex } }; }
  }
  const finalExit = qtyKnown
    ? legs.find((l) => !l.opening && l.positionAfter != null && l.positionAfter <= EPS && l.index === lastClosingIdx)
    : legs[lastClosingIdx];
  if (finalExit && link?.flipOut && finalExit.role !== "stop") { finalExit.role = "flip"; finalExit.reasonItem = { key: "reason.flipOut" }; }

  // ── stop: known level, derived from risk $, or inferred ──
  const openingLegs = legs.filter((l) => l.opening);
  const firstEntryPrice = openingLegs[0]?.price ?? (carry ? carry.avg : null);
  const maxPosition = qtyKnown ? round4(maxPos) : ctx.tradeQty != null && ctx.tradeQty > 0 ? ctx.tradeQty : null;
  let stopPrice = ctx.stop != null && Number.isFinite(ctx.stop) && ctx.stop > 0 ? ctx.stop : null;
  let stopFromRisk = false;
  if (stopPrice == null && ctx.riskUsd != null && ctx.riskUsd > 0 && maxPosition && firstEntryPrice != null) {
    stopPrice = round4(firstEntryPrice - dir * (ctx.riskUsd / maxPosition));
    stopFromRisk = stopPrice > 0;
    if (!stopFromRisk) stopPrice = null;
  }
  const riskPerShare = stopPrice != null && firstEntryPrice != null && Math.abs(firstEntryPrice - stopPrice) > EPS ? round4(Math.abs(firstEntryPrice - stopPrice)) : null;
  let stopHit = legs.some((l) => l.role === "stop");
  let stopInferred = false;
  let stopReasonItem: TextItem | null = stopHit ? { key: "reason.markedStop" } : null;
  if (stopPrice != null && riskPerShare != null) {
    const tol = Math.max(0.01, 0.1 * riskPerShare);
    for (const l of legs) {
      if (l.opening || l.role === "flip" || l.role === "stop") continue;
      const through = dir === 1 ? l.price <= stopPrice + tol : l.price >= stopPrice - tol;
      if (through && (l.perShare == null || l.perShare < 0)) {
        l.role = "stop";
        l.reasonItem = { key: stopFromRisk ? "reason.atStopFromRisk" : "reason.atStop", params: { price: fmt(stopPrice) } };
        stopHit = true;
        stopReasonItem = l.reasonItem;
      }
    }
  } else if (finalExit && finalExit.role === "exit" && finalExit.perShare != null && finalExit.perShare < 0) {
    const prev = legs[finalExit.index - 1];
    const tExit = epochOf(finalExit.at), tPrev = prev ? epochOf(prev.atEnd) : null;
    const adverseAdd = prev && prev.role === "add" && firstEntryPrice != null && dir * (prev.price - firstEntryPrice) < 0;
    const extreme = ctx.adverseExtreme;
    const avgIn = weighted(openingLegs) ?? firstEntryPrice;
    const excursion = extreme != null && Number.isFinite(extreme) && avgIn != null ? dir * (avgIn - extreme) : 0;
    const loss = avgIn != null ? dir * (avgIn - finalExit.price) : 0;
    const atWorst = excursion > EPS && loss > EPS && loss >= STOP_NEAR_WORST_SHARE * excursion;
    if (adverseAdd && tExit != null && tPrev != null && tExit - tPrev <= STOP_AFTER_ADD_SECONDS) {
      finalExit.reasonItem = { key: "reason.inferredAfterAdd" };
    } else if (atWorst) {
      finalExit.reasonItem = { key: "reason.inferredAtWorst", params: { price: fmt(extreme as number), pct: Math.round((loss / excursion) * 100) } };
    }
    if (finalExit.reasonItem) {
      finalExit.role = "stop"; finalExit.inferred = true;
      stopHit = true; stopInferred = true; stopReasonItem = finalExit.reasonItem;
    }
  }

  // ── R per leg ──
  const riskUsd = ctx.riskUsd != null && ctx.riskUsd > 0 ? ctx.riskUsd : riskPerShare != null && maxPosition ? riskPerShare * maxPosition : null;
  const closingLegs = legs.filter((l) => !l.opening);
  for (const l of closingLegs) {
    if (l.realized != null && riskUsd) l.r = round4(l.realized / riskUsd);
    else if (!qtyKnown && closingLegs.length === 1 && l.perShare != null && riskPerShare) l.r = round4(l.perShare / riskPerShare);
  }

  for (const l of legs) {
    l.label = roleLabel(l.role, lang);
    l.reason = l.reasonItem ? tsText(lang, l.reasonItem) : null;
  }

  // ── stats ──
  const avgEntry = weighted(openingLegs) ?? (carry ? carry.avg : null);
  const avgExit = weighted(closingLegs);
  const realized = qtyKnown && closingLegs.length ? round4(closingLegs.reduce((s, l) => s + (l.realized ?? 0), 0)) : null;
  const rTotal = closingLegs.length && closingLegs.every((l) => l.r != null) ? round4(closingLegs.reduce((s, l) => s + (l.r as number), 0)) : null;
  const fidelity: StructureStats["fidelity"] = ctx.source === "report" ? "averages" : "fills";
  const scaledEntryLikely = fidelity === "averages" && openingLegs.length === 1 && isFractionalCent(openingLegs[0].price);
  const scaledExitLikely = fidelity === "averages" && closingLegs.length === 1 && isFractionalCent(closingLegs[0].price);
  const timed = legs.map((l) => l.at).filter((x): x is string => !!x);
  const lastTimed = legs.map((l) => l.atEnd).filter((x): x is string => !!x);

  if (fidelity === "averages") noteItems.push({ key: "note.averages" });
  if (scaledEntryLikely) noteItems.push({ key: "note.scaledEntry", params: { price: String(openingLegs[0].price) } });
  if (scaledExitLikely) noteItems.push({ key: "note.scaledExit", params: { price: String(closingLegs[0].price) } });
  if (carry) noteItems.push({ key: "note.carry" });
  if (unknownCarryExit) noteItems.push({ key: "note.unknownCarry" });
  if (!qtyKnown && raw.length) noteItems.push({ key: "note.noQty" });
  const split = legs.reduce((s, l) => s + (l.pieces > 1 ? l.pieces - 1 : 0), 0);
  if (split) noteItems.push({ key: "note.split", params: { count: split } });
  if (stopInferred && stopReasonItem) noteItems.push(stopReasonItem);
  const notes = noteItems.map((it) => tsText(lang, it));
  const stopReason = stopReasonItem ? tsText(lang, stopReasonItem) : null;

  const stats: StructureStats = {
    v: 2,
    source: ctx.source,
    fidelity,
    side: ctx.side,
    legs: legs.length,
    entries: openingLegs.length,
    adds: legs.filter((l) => l.role === "add").length,
    partials: legs.filter((l) => l.role === "partial_exit").length,
    exits: closingLegs.length,
    splitFills: split,
    avgEntry: avgEntry != null ? round4(avgEntry) : null,
    avgExit: avgExit != null ? round4(avgExit) : null,
    maxPosition,
    openQty: qtyKnown ? round4(pos) : null,
    realized,
    rTotal,
    riskPerShare,
    stopPrice,
    stopHit,
    stopInferred,
    stopReason,
    stopReasonItem,
    reentryIndex: link?.reentryIndex ?? 0,
    prevId: link?.prevId ?? null,
    nextId: link?.nextId ?? null,
    flipIn: !!link?.flipIn,
    flipOut: !!link?.flipOut,
    carriedIn: !!carry || unknownCarryExit,
    scaledEntryLikely,
    scaledExitLikely,
    firstAt: timed[0] ?? null,
    lastAt: lastTimed[lastTimed.length - 1] ?? null,
    notes,
    noteItems,
  };
  const byExecution: TradeStructure["byExecution"] = {};
  for (const l of legs) for (const id of l.executionIds) byExecution[id] = { role: l.role, legIndex: l.index, inferred: l.inferred };
  return { legs, stats, byExecution };
}

function weighted(legs: readonly Leg[]): number | null {
  if (!legs.length) return null;
  const known = legs.every((l) => l.qty != null);
  let s = 0, q = 0;
  for (const l of legs) { const w = known ? (l.qty as number) : 1; s += l.price * w; q += w; }
  return q > 0 ? s / q : null;
}

/** Unit-weighted average of the opening legs (fills without qty). */
function openingAvg(raw: readonly RawLeg[]): number | null {
  const o = raw.filter((l) => l.opening);
  return o.length ? o.reduce((s, l) => s + l.price, 0) / o.length : null;
}

// ─── links between trades ────────────────────────────────────────────────────────────────────────────────────────

export interface TradeHead {
  id: number;
  /** Account (or trader) the position lives in — trades of different accounts never link. */
  group: string;
  symbol: string;
  /** Session (trade) date "YYYY-MM-DD"; re-entries are counted per session. */
  session: string;
  side: Side;
  /** ISO instants of the first and last fill. */
  openedAt: string | null;
  closedAt: string | null;
}

/** Seconds of slack for «closed and reopened in the same second» (fills are stored to the second). */
const FLIP_SLACK_SECONDS = 1;

export function linkTrades(heads: readonly TradeHead[]): Map<number, TradeLink> {
  const groups = new Map<string, TradeHead[]>();
  for (const h of heads) {
    const k = `${h.group}\u0000${h.symbol.toUpperCase()}\u0000${h.session}`;
    const g = groups.get(k);
    if (g) g.push(h); else groups.set(k, [h]);
  }
  const out = new Map<number, TradeLink>();
  for (const g of groups.values()) {
    g.sort((a, b) => (epochOf(a.openedAt) ?? Infinity) - (epochOf(b.openedAt) ?? Infinity) || a.id - b.id);
    g.forEach((h, i) => out.set(h.id, { prevId: i > 0 ? g[i - 1].id : null, nextId: i < g.length - 1 ? g[i + 1].id : null, reentryIndex: i, flipIn: false, flipOut: false }));
    for (let i = 1; i < g.length; i++) {
      const prev = g[i - 1], cur = g[i];
      const pc = epochOf(prev.closedAt), co = epochOf(cur.openedAt);
      if (pc != null && co != null && Math.abs(co - pc) <= FLIP_SLACK_SECONDS && prev.side !== cur.side) {
        out.get(cur.id)!.flipIn = true;
        out.get(prev.id)!.flipOut = true;
      }
    }
  }
  return out;
}

/** One-line summary for lists in `lang`: «2 добора · частичный фикс · перезаход №1». */
export function structureSummary(s: Pick<StructureStats, "adds" | "partials" | "stopHit" | "stopInferred" | "reentryIndex" | "flipIn" | "flipOut" | "scaledEntryLikely" | "scaledExitLikely" | "fidelity">, lang: Lang = "ru"): string {
  const t = tradeStructureT.tFor(lang);
  const parts: string[] = [];
  if (s.flipIn) parts.push(t("summary.flip"));
  else if (s.reentryIndex > 0) parts.push(t("summary.reentry", { n: s.reentryIndex }));
  if (s.adds) parts.push(t("summary.adds", { count: s.adds }));
  else if (s.scaledEntryLikely) parts.push(t("summary.scaledEntry"));
  if (s.partials) parts.push(t("summary.partials", { count: s.partials }));
  else if (s.scaledExitLikely) parts.push(t("summary.scaledExit"));
  if (s.stopHit) parts.push(t(s.stopInferred ? "summary.stopInferred" : "summary.stop"));
  if (s.flipOut) parts.push(t("summary.flipOut"));
  return parts.join(" · ");
}

/** Persisted / computed stats with notes, stop reason (and `summary`, when present) re-rendered in `lang`. */
export function localizeStats<T extends Partial<StructureStats> & { summary?: string }>(stats: T, lang: Lang): T {
  if (lang === "ru" || !stats) return stats;
  const out = { ...stats };
  if (Array.isArray(stats.noteItems)) out.notes = stats.noteItems.map((it) => tsText(lang, it));
  if (stats.stopReasonItem) out.stopReason = tsText(lang, stats.stopReasonItem);
  if (typeof stats.summary === "string" && typeof stats.adds === "number") out.summary = structureSummary(stats as StructureStats, lang);
  return out;
}
