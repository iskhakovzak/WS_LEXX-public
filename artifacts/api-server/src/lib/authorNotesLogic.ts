/**
 * «Сводка автора» — pure helpers behind routes/author-notes.ts (unit-tested in __tests__/authorNotesLogic.test.ts).
 *
 *   daySnapshot()   the author's trading day as shown on a feed card to readers: counts, W/L, Σ R, tickers.
 *                   $ (pnlNet) only for viewers allowed by lib/playbookPrivacy.canSeeTradeMoney (owner / staff).
 *   buildAudience() who of the team has / has not read a note, trainees and juniors first (they need it most).
 */
import { canSeeTradeMoney, type MoneyViewer } from "./playbookPrivacy";
import { netPnl, normResult, signedR, type TradeRowLike } from "./tradeMath";

// ─── Day snapshot ─────────────────────────────────────────────────────────────

export type SnapshotTrade = TradeRowLike & { ticker?: unknown };

export interface DaySnapshot {
  count: number;
  wins: number;
  losses: number;
  /** Σ signed R of closed trades; null when none of them has an R. */
  rSum: number | null;
  /** Unique tickers in trade order, at most MAX_TICKERS. */
  tickers: string[];
  /** Net $ of closed trades — null for viewers who may not see the author's money (see `redacted`). */
  pnlNet: number | null;
  redacted: boolean;
}

export const MAX_SNAPSHOT_TICKERS = 8;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function daySnapshot(trades: SnapshotTrade[], viewer: MoneyViewer, author: string): DaySnapshot | null {
  if (!trades.length) return null;
  const closed = trades.filter((t) => normResult(t.result) !== "open");
  const rs = closed.map((t) => signedR(t)).filter((r): r is number => r != null);
  const nets = closed.map((t) => netPnl(t)).filter((n): n is number => n != null);
  const tickers: string[] = [];
  for (const t of trades) {
    const tk = typeof t.ticker === "string" ? t.ticker.trim().toUpperCase() : "";
    if (tk && !tickers.includes(tk)) tickers.push(tk);
  }
  const money = canSeeTradeMoney(viewer, author);
  return {
    count: trades.length,
    wins: closed.filter((t) => normResult(t.result) === "win").length,
    losses: closed.filter((t) => normResult(t.result) === "loss").length,
    rSum: rs.length ? round2(rs.reduce((s, r) => s + r, 0)) : null,
    tickers: tickers.slice(0, MAX_SNAPSHOT_TICKERS),
    pnlNet: money && nets.length ? round2(nets.reduce((s, n) => s + n, 0)) : null,
    redacted: !money,
  };
}

/** Groups trade rows by `${trader}|${date}` so the feed can attach one snapshot per note. */
export function groupTradesByDay<T extends { trader?: unknown; date?: unknown }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const key = `${String(r.trader ?? "")}|${String(r.date ?? "").slice(0, 10)}`;
    const list = out.get(key);
    if (list) list.push(r); else out.set(key, [r]);
  }
  return out;
}

// ─── Audience ─────────────────────────────────────────────────────────────────

export type AudienceStage = "trainee" | "junior" | "trader" | "senior";

export const STAGE_ORDER: Record<AudienceStage, number> = { trainee: 0, junior: 1, trader: 2, senior: 3 };

export function isAudienceStage(v: unknown): v is AudienceStage {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(STAGE_ORDER, v);
}

export interface AudienceMemberInput {
  name: string;
  role: string;
  stage: AudienceStage | null;
}

export interface AudienceMember {
  name: string;
  role: string;
  stage: AudienceStage | null;
  readAt: string | null;
}

export interface Audience {
  total: number;
  read: number;
  members: AudienceMember[];
}

const isStaff = (role: string) => role === "curator" || role === "admin";

/** Sort rank: academy stage (trainee first) → traders without a stage → staff last. */
function rank(m: AudienceMemberInput): number {
  if (isStaff(m.role)) return 10;
  return m.stage ? STAGE_ORDER[m.stage] : 5;
}

/**
 * The note's audience = every active member except the author. Readers that are no longer members (renamed /
 * deactivated) are dropped from the list but never counted as unread. Order: unread first, then by rank, name.
 */
export function buildAudience(
  members: AudienceMemberInput[],
  reads: { reader: string; read_at: string | Date }[],
  author: string,
): Audience {
  const readAt = new Map<string, string>();
  for (const r of reads) readAt.set(r.reader, r.read_at instanceof Date ? r.read_at.toISOString() : String(r.read_at));
  const seen = new Set<string>();
  const list: (AudienceMember & { _rank: number })[] = [];
  for (const m of members) {
    if (!m.name || m.name === author || seen.has(m.name)) continue;
    seen.add(m.name);
    list.push({ name: m.name, role: m.role, stage: m.stage, readAt: readAt.get(m.name) ?? null, _rank: rank(m) });
  }
  list.sort((a, b) =>
    Number(a.readAt != null) - Number(b.readAt != null) || a._rank - b._rank || a.name.localeCompare(b.name, "ru"),
  );
  return {
    total: list.length,
    read: list.filter((m) => m.readAt != null).length,
    members: list.map(({ _rank, ...m }) => m),
  };
}
