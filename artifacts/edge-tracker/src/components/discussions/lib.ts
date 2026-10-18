/**
 * Discussions: shared types, comment-text protocol, sorting, unread store.
 *
 * Comment text protocol (kept in the existing `text` column, no schema change):
 *   "[Статус] [re:123] body"  — both prefixes optional.
 * Thread flags pinned/resolved are reserved tags ("закреплено", "решено").
 * Screenshots are stored as `![скриншот](url)` lines at the end of notes.
 */
import type { Discussion, Comment } from "@workspace/api-client-react";
import { matchesAny, prepareQuery } from "@workspace/text-search";
import { fmtDate, fmtDateCustom, fmtRelative } from "@/lib/format";
import { discussionsI18n } from "@/i18n/ns/discussions";
import { personInitials } from "@/i18n";

/** `{ key: label }` whose labels are read in the current language on every access (safe at module scope). */
function liveLabels<K extends string>(keys: readonly K[], label: (k: K) => string): Record<K, string> {
  const o = {} as Record<K, string>;
  for (const k of keys) Object.defineProperty(o, k, { get: () => label(k), enumerable: true });
  return o;
}

export type Thread = Discussion & {
  commentCount?: number;
  lastActivityAt?: string;
  lastActivityBy?: string | null;
  participants?: string[];
  pinned?: boolean;
  resolved?: boolean;
  /** Contextual thread: what it is about (trade / idea / setup / event / journal day). */
  tradeId?: number | null;
  ideaId?: number | null;
  playbookId?: number | null;
  eventId?: number | null;
  journalDate?: string | null;
  acceptedCommentId?: number | null;
  /** Server-side read tracking (discussion_reads) for the signed-in viewer. */
  readAt?: string | null;
  unread?: boolean;
  mentionsMe?: boolean;
  /** Who can read the thread: [] = everyone, else stage / "staff" / "cohort:<id>" tokens (server-enforced). */
  audience?: string[];
};

export type ThreadContext = { tradeId?: number | null; ideaId?: number | null; playbookId?: number | null; eventId?: number | null; journalDate?: string | null };

export type VoteAgg = { upvotes: number; downvotes: number; score: number; myVote: number | null };
export type VoteMap = Record<number, VoteAgg>;
export type TickerStat = { ticker: string; count: number };

// Reserved tag values stored in `discussions.tags` and matched by the server: data, never shown or translated.
export const TAG_PINNED = "закреплено"; // i18n-ignore
export const TAG_RESOLVED = "решено"; // i18n-ignore
const RESERVED = new Set([TAG_PINNED, TAG_RESOLVED]);

export const TYPES = ["setup", "analysis", "strategy", "risk", "review_request", "general"] as const;
export type ThreadType = (typeof TYPES)[number];
/** Type → label in the current language; unknown types are `undefined` (show the code). */
export const TYPE_LABELS: Record<string, string> = liveLabels<ThreadType>(TYPES, (k) => discussionsI18n.t(`type.${k}`));
export const TYPE_TONE: Record<string, "up" | "down" | "accent" | "warn" | "purple" | "neutral"> = {
  strategy: "up",
  risk: "down",
  analysis: "purple",
  setup: "warn",
  review_request: "accent",
  general: "neutral",
};

/** Notes skeletons offered in the create dialog (in the writer's language; the result is their own text). */
export const TEMPLATES: Record<string, string> = liveLabels<ThreadType>(TYPES, (k) => discussionsI18n.t(`template.${k}`));

export type PositionStatus = "observing" | "in_position" | "exited";
const POSITION_STATUSES: readonly PositionStatus[] = ["observing", "in_position", "exited"];
/** Display label in the current language. */
export const STATUS_LABELS: Record<PositionStatus, string> = liveLabels(POSITION_STATUSES, (k) => discussionsI18n.t(`status.${k}`));
/**
 * The machine prefix written into comment text («[Наблюдаю] …»). Stored data read by the server
 * (routes/discussions.ts COMMENT_PREFIX) and by older clients: keep it identical in every UI language.
 */
const STATUS_STORED: Record<PositionStatus, string> = {
  observing: "Наблюдаю", // i18n-ignore
  in_position: "В позиции", // i18n-ignore
  exited: "Вышел", // i18n-ignore
};
export const STATUS_TONE: Record<PositionStatus, "accent" | "up" | "neutral"> = {
  observing: "accent",
  in_position: "up",
  exited: "neutral",
};
const STATUS_FROM_LABEL: Record<string, PositionStatus> = {
  Observing: "observing", "In Position": "in_position", Exited: "exited",
  "Наблюдаю": "observing", "В позиции": "in_position", "Вышел": "exited", // i18n-ignore (stored prefixes)
};

export type ParsedComment = {
  status: PositionStatus | null;
  replyTo: number | null;
  body: string;
  /** Exact prefix to re-attach when editing only the body. */
  prefix: string;
};

// i18n-ignore (stored prefixes)
const COMMENT_RE = /^(\[(Observing|In Position|Exited|Наблюдаю|В позиции|Вышел)\]\s*)?(\[re:(\d+)\]\s*)?([\s\S]*)$/;

export function parseComment(text: string): ParsedComment {
  const m = text.match(COMMENT_RE);
  if (!m) return { status: null, replyTo: null, body: text, prefix: "" };
  return {
    status: m[2] ? STATUS_FROM_LABEL[m[2]] ?? null : null,
    replyTo: m[4] ? Number(m[4]) : null,
    body: m[5] ?? "",
    prefix: `${m[1] ?? ""}${m[3] ?? ""}`,
  };
}

export function buildCommentText(body: string, status: PositionStatus | null, replyTo: number | null): string {
  const s = status ? `[${STATUS_STORED[status]}] ` : "";
  const r = replyTo ? `[re:${replyTo}] ` : "";
  return `${s}${r}${body.trim()}`;
}

export type CommentNode = { comment: Comment; parsed: ParsedComment; replies: { comment: Comment; parsed: ParsedComment; replyToAuthor: string | null }[] };

/** Two-level tree: replies (to anything inside a root's subtree) are attached to that root. */
export function buildCommentTree(comments: Comment[]): CommentNode[] {
  const byId = new Map<number, { comment: Comment; parsed: ParsedComment }>();
  for (const c of comments) byId.set(c.id, { comment: c, parsed: parseComment(c.text) });
  const rootOf = new Map<number, number>();
  const roots: CommentNode[] = [];
  const rootNode = new Map<number, CommentNode>();
  for (const c of comments) {
    const entry = byId.get(c.id)!;
    const parentId = entry.parsed.replyTo;
    const parent = parentId != null ? byId.get(parentId) : undefined;
    if (parent && rootOf.has(parent.comment.id)) {
      const rootId = rootOf.get(parent.comment.id)!;
      rootOf.set(c.id, rootId);
      rootNode.get(rootId)!.replies.push({ ...entry, replyToAuthor: parent.comment.trader ?? null });
    } else {
      rootOf.set(c.id, c.id);
      const node: CommentNode = { ...entry, replies: [] };
      rootNode.set(c.id, node);
      roots.push(node);
    }
  }
  return roots;
}

/** Latest declared position status per trader (from comment prefixes). */
export function teamPositions(comments: Comment[]): Record<PositionStatus, string[]> {
  const latest = new Map<string, PositionStatus>();
  for (const c of comments) {
    const p = parseComment(c.text);
    if (c.trader && p.status) latest.set(c.trader, p.status);
  }
  const out: Record<PositionStatus, string[]> = { observing: [], in_position: [], exited: [] };
  latest.forEach((s, t) => out[s].push(t));
  return out;
}

export function userTags(tags?: string | null): string[] {
  return (tags ?? "").split(",").map((t) => t.trim()).filter((t) => t && !RESERVED.has(t.toLowerCase()));
}
export function hasTag(tags: string | null | undefined, tag: string): boolean {
  return (tags ?? "").split(",").map((t) => t.trim().toLowerCase()).includes(tag);
}
export function toggleTag(tags: string | null | undefined, tag: string, on: boolean): string {
  const list = (tags ?? "").split(",").map((t) => t.trim()).filter(Boolean).filter((t) => t.toLowerCase() !== tag);
  if (on) list.push(tag);
  return list.join(", ");
}

const IMG_LINE = /^!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)\s*$/;
/** Split notes into text body and screenshot URLs (stored as image lines). */
export function splitNotes(notes?: string | null): { text: string; images: string[] } {
  if (!notes) return { text: "", images: [] };
  const images: string[] = [];
  const lines: string[] = [];
  for (const line of notes.split("\n")) {
    const m = line.trim().match(IMG_LINE);
    if (m) images.push(m[1]);
    else lines.push(line);
  }
  return { text: lines.join("\n").trim(), images };
}
export function joinNotes(text: string, images: string[]): string {
  // Stored markdown (alt text is not shown; IMG_LINE accepts any alt): kept stable across languages.
  const imgs = images.map((u) => u.trim()).filter(Boolean).map((u) => `![скриншот](${u})`); // i18n-ignore
  return [text.trim(), imgs.join("\n")].filter(Boolean).join("\n\n");
}

export function lastActivity(t: Thread): string {
  if (t.lastActivityAt) return t.lastActivityAt;
  const cs = t.comments ?? [];
  return cs.length ? cs[cs.length - 1].createdAt : t.createdAt;
}
export function lastActivityBy(t: Thread): string | null {
  if (t.lastActivityBy !== undefined) return t.lastActivityBy;
  const cs = t.comments ?? [];
  return cs.length ? cs[cs.length - 1].trader ?? null : t.trader ?? null;
}
export function participants(t: Thread): string[] {
  if (t.participants) return t.participants;
  return Array.from(new Set([t.trader, ...(t.comments ?? []).map((c) => c.trader)].filter((x): x is string => !!x)));
}
export const isPinned = (t: Thread) => t.pinned ?? hasTag(t.tags, TAG_PINNED);
export const isResolved = (t: Thread) => t.resolved ?? hasTag(t.tags, TAG_RESOLVED);

export type SortKey = "active" | "hot" | "new" | "top";
const SORT_KEYS: readonly SortKey[] = ["active", "hot", "new", "top"];
export const SORT_LABELS: Record<SortKey, string> = liveLabels(SORT_KEYS, (k) => discussionsI18n.t(`sort.${k}`));

/** HN-style gravity: votes + replies, decayed by hours since last activity. */
export function hotScore(t: Thread, votes: VoteMap): number {
  const score = votes[t.id]?.score ?? 0;
  const replies = t.comments?.length ?? 0;
  const hours = Math.max(0, (Date.now() - new Date(lastActivity(t)).getTime()) / 3_600_000);
  return (score * 2 + replies + 1) / Math.pow(hours + 2, 1.5);
}

export function sortThreads(list: Thread[], key: SortKey, votes: VoteMap): Thread[] {
  const ts = (s: string) => new Date(s).getTime();
  const cmp: Record<SortKey, (a: Thread, b: Thread) => number> = {
    active: (a, b) => ts(lastActivity(b)) - ts(lastActivity(a)),
    new: (a, b) => ts(b.createdAt) - ts(a.createdAt),
    top: (a, b) => (votes[b.id]?.score ?? 0) - (votes[a.id]?.score ?? 0) || (b.comments?.length ?? 0) - (a.comments?.length ?? 0),
    hot: (a, b) => hotScore(b, votes) - hotScore(a, votes),
  };
  return [...list].sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || cmp[key](a, b) || b.id - a.id);
}

export function mentions(text: string, name: string | null | undefined): boolean {
  if (!name) return false;
  return text.toLowerCase().includes(`@${name.toLowerCase()}`);
}

/**
 * The stored name written right after «@» at `at` (case-insensitive, whole word, longest of `names` first — like the
 * server's extractMentions), or null. Lets a chip cover a multi-word name («@Дмитрий К.») and show its display name.
 */
export function mentionedName(text: string, at: number, names: readonly string[]): string | null {
  const rest = text.slice(at).toLowerCase();
  let best: string | null = null;
  for (const n of names) {
    if ((!best || n.length > best.length) && rest.startsWith(n.toLowerCase()) && !/[\p{L}\p{N}_]/u.test(rest[n.length] ?? "")) best = n;
  }
  return best;
}

export function threadMentions(t: Thread, me: string | null | undefined): boolean {
  if (t.mentionsMe !== undefined) return t.mentionsMe;
  if (!me) return false;
  if (mentions(t.notes ?? "", me)) return true;
  return (t.comments ?? []).some((c) => c.trader !== me && mentions(c.text, me));
}

export function threadMatches(t: Thread, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = [t.topic, t.notes, t.ticker, t.trader, t.tags, ...(t.comments ?? []).map((c) => `${c.trader ?? ""} ${c.text}`)]
    .filter(Boolean).join("\n").toLowerCase();
  if (hay.includes(needle)) return true;
  // Authors by name in any script / layout: «olga», «Ольга», «Jkmuf» → threads of «Ольга Н.».
  return matchesAny(prepareQuery(q), t.trader, ...(t.comments ?? []).map((c) => c.trader));
}

// ── Unread store ─────────────────────────────────────────────────────────
// Source of truth is the server (`discussion_reads`: `unread` / `readAt` on each thread).
// The localStorage store below is only a fallback for an API that does not send those fields yet.
const SEEN_KEY = "ws_lexx_disc_seen_v1";
type SeenStore = { init: string; seen: Record<string, string> };

export function loadSeen(): SeenStore {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw) {
      const p = JSON.parse(raw) as SeenStore;
      if (p && typeof p.init === "string" && p.seen && typeof p.seen === "object") return p;
    }
  } catch { /* storage unavailable */ }
  // First run: treat everything that already exists as read.
  const fresh: SeenStore = { init: new Date().toISOString(), seen: {} };
  saveSeen(fresh);
  return fresh;
}
export function saveSeen(s: SeenStore) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
export function seenAt(store: SeenStore, id: number, t?: Thread | null): string {
  if (t && t.readAt !== undefined) return t.readAt ?? "1970-01-01T00:00:00.000Z";
  return store.seen[String(id)] ?? store.init;
}
export function isUnread(t: Thread, store: SeenStore, me: string | null | undefined): boolean {
  if (t.unread !== undefined) return t.unread;
  const last = lastActivity(t);
  if (me && lastActivityBy(t) === me) return false;
  return new Date(last).getTime() > new Date(seenAt(store, t.id)).getTime();
}

// ── Freshness ────────────────────────────────────────────────────────────
const HOUR = 3_600_000;
/** A thread by someone else, created in the last 48 h, that the viewer has never opened. */
export function isFreshThread(t: Thread, me: string | null | undefined, now = Date.now()): boolean {
  if (me && t.trader === me) return false;
  if (t.readAt !== undefined && t.readAt !== null) return false;
  if (t.readAt === undefined && t.unread === false) return false;
  const created = new Date(t.createdAt).getTime();
  return Number.isFinite(created) && now - created < 48 * HOUR;
}
/** Activity in the last 24 h — the «Активно сейчас» view. */
export function isActiveToday(t: Thread, now = Date.now()): boolean {
  const last = new Date(lastActivity(t)).getTime();
  return Number.isFinite(last) && now - last < 24 * HOUR;
}
/** A conversation happening right now: a reply within 3 h and at least two replies overall. */
export function isLiveNow(t: Thread, now = Date.now()): boolean {
  const last = new Date(lastActivity(t)).getTime();
  const replies = t.commentCount ?? t.comments?.length ?? 0;
  return Number.isFinite(last) && now - last < 3 * HOUR && replies >= 2;
}

// ── Prefs ────────────────────────────────────────────────────────────────
const PREFS_KEY = "ws_lexx_disc_prefs_v1";
export type ViewKey = "all" | "unread" | "live" | "mine" | "mentions" | "open" | "positions";
export type Prefs = { sort: SortKey; view: ViewKey };
export function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    if (p && SORT_LABELS[p.sort as SortKey] && typeof p.view === "string") return p as Prefs;
  } catch { /* ignore */ }
  return { sort: "active", view: "all" };
}
export function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

// ── Formatting ───────────────────────────────────────────────────────────
export function relTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return "";
  const days = (Date.now() - d) / 86_400_000;
  if (days < 7) return fmtRelative(d, { style: "short" });
  return fmtDate(iso, days > 300 ? "medium" : "dayMonth");
}
export function absTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? fmtDateCustom(d, { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }) : iso;
}
/** Avatar initials of the person's display name (Latin in EN/UZ when set). */
export function initials(name?: string | null): string {
  return personInitials(name);
}
/** Stable chart-token colour per name (for avatars). */
export function avatarTone(name?: string | null): string {
  const n = (name ?? "").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return ["bg-[hsl(var(--chart-1)/0.18)] text-[hsl(var(--chart-1))]", "bg-[hsl(var(--chart-2)/0.18)] text-[hsl(var(--chart-2))]",
    "bg-[hsl(var(--chart-3)/0.18)] text-[hsl(var(--chart-3))]", "bg-[hsl(var(--chart-4)/0.18)] text-[hsl(var(--chart-4))]",
    "bg-[hsl(var(--chart-5)/0.18)] text-[hsl(var(--chart-5))]"][n % 5];
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable || !!el.closest("[role=dialog]");
}
