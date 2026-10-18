/**
 * Notification center model: API shapes, type registry (mirrors api-server lib/notificationCore.ts),
 * tones/icons per type & severity, day grouping and the raw-fetch API client.
 * Only the inbox/bell/page/prefs components import from here.
 */
import type { LucideIcon } from "lucide-react";
import {
  AtSign, MessageSquareReply, MessageSquarePlus, HelpCircle, Lightbulb, ClipboardCheck, MessageSquare, CalendarCheck, AlarmClock,
  CheckCircle2, CalendarRange, Star, BadgeCheck, TriangleAlert, OctagonAlert, SlidersHorizontal, TrendingUp,
  Gavel, RefreshCw, Link2Off, Info, Bell, GraduationCap, Target, Trophy, ShieldAlert, Award,
} from "lucide-react";
import { http } from "@/lib/api/http";
import { fmtDate } from "@/lib/format";
import type { Tone } from "@/components/ds";
import { notificationsI18n } from "@/i18n/ns/notifications";
import { commonI18n } from "@/i18n/ns/common";

export type Severity = "info" | "warn" | "critical";
export type NotificationGroup = "team" | "ideas" | "review" | "risk" | "scaling" | "academy" | "sync" | "system";

export type Notification = {
  id: number;
  type: string;
  /** Server label (Russian on older API builds) — render `typeLabelOf(type)` instead. */
  typeLabel: string;
  group: NotificationGroup;
  severity: Severity;
  /**
   * Server-rendered title in the request language (rows stored as type + params), the stored Russian title of older
   * rows, or "" when the row has no title of its own (the UI then shows the type label: `notificationTitle(n)`).
   */
  title: string;
  body: string;
  link: string | null;
  entityType: string | null;
  entityId: string | null;
  actor: string | null;
  ideaId: number | null;
  isRead: boolean;
  readAt: string | null;
  archivedAt: string | null;
  createdAt: string;
};

export type NotificationPage = { items: Notification[]; nextCursor: string | null };
export type UnreadCount = { unread: number; critical: number; warn: number };
export type TypeMeta = { type: string; label: string; group: NotificationGroup; severity: Severity; description: string };
export type Pref = { type: string; inApp: boolean; muteUntil: string | null };
export type Prefs = { prefs: Pref[]; muteAllUntil: string | null };

export const ALL_TYPES_KEY = "*";

/** Group names in the UI language (getters: read at render). */
export const GROUP_LABELS: Readonly<Record<NotificationGroup, string>> = {
  get team() { return notificationsI18n.t("groups.team"); },
  get ideas() { return notificationsI18n.t("groups.ideas"); },
  get review() { return notificationsI18n.t("groups.review"); },
  get risk() { return notificationsI18n.t("groups.risk"); },
  get scaling() { return notificationsI18n.t("groups.scaling"); },
  get academy() { return notificationsI18n.t("groups.academy"); },
  get sync() { return notificationsI18n.t("groups.sync"); },
  get system() { return notificationsI18n.t("groups.system"); },
};
export const GROUP_ORDER: NotificationGroup[] = ["team", "ideas", "review", "risk", "scaling", "academy", "sync", "system"];

/** Label / description of a type in the UI language; unknown types show their code. */
export function typeLabelOf(type: string): string {
  return notificationsI18n.tryT(`types.${type}.label`) ?? type;
}
export function typeDescriptionOf(type: string): string {
  return notificationsI18n.tryT(`types.${type}.description`) ?? "";
}

/** Registry entry whose label/description follow the UI language. */
function meta(type: string, group: NotificationGroup, severity: Severity): TypeMeta {
  return {
    type, group, severity,
    get label() { return typeLabelOf(type); },
    get description() { return typeDescriptionOf(type); },
  };
}

/** Local copy of the registry so filters/prefs render before (or without) GET /notifications/types. */
export const TYPES: TypeMeta[] = [
  meta("mention", "team", "info"),
  meta("reply", "team", "info"),
  meta("review_request", "team", "info"),
  meta("thread_new", "team", "info"),
  meta("idea_submitted", "ideas", "info"),
  meta("idea_review", "ideas", "info"),
  meta("idea_comment", "ideas", "info"),
  meta("eod_review_request", "review", "info"),
  meta("eod_overdue", "review", "warn"),
  meta("eod_reviewed", "review", "info"),
  meta("weekly_review", "review", "info"),
  meta("rating", "review", "info"),
  meta("rating_ack", "review", "info"),
  meta("discipline_badge", "review", "info"),
  meta("risk_warn", "risk", "warn"),
  meta("risk_breach", "risk", "critical"),
  meta("risk_repeat_breach", "risk", "critical"),
  meta("risk_breach_review", "risk", "info"),
  meta("limit_change", "risk", "info"),
  meta("rule_violation", "risk", "warn"),
  meta("scaling_proposal", "scaling", "info"),
  meta("scaling_decision", "scaling", "info"),
  meta("academy_promotion_ready", "academy", "info"),
  meta("academy_promotion_request", "academy", "info"),
  meta("academy_promotion_decision", "academy", "info"),
  meta("academy_challenge_assigned", "academy", "info"),
  meta("academy_challenge_passed", "academy", "info"),
  meta("academy_challenge_failed", "academy", "warn"),
  meta("academy_enrolled", "academy", "info"),
  meta("academy_stage_change", "academy", "info"),
  meta("academy_goal_assigned", "academy", "info"),
  meta("academy_goal_achieved", "academy", "info"),
  meta("academy_goal_missed", "academy", "warn"),
  meta("academy_action_assigned", "academy", "info"),
  meta("academy_action_overdue", "academy", "warn"),
  meta("academy_submitted", "academy", "info"),
  meta("academy_graded", "academy", "info"),
  meta("sync", "sync", "info"),
  meta("sync_unmatched", "sync", "warn"),
  meta("system", "system", "info"),
];

const TYPE_INDEX = new Map(TYPES.map((t) => [t.type, t]));
const LEGACY: Record<string, string> = { comment_public: "idea_comment", reply_private: "idea_comment", risk_stop: "risk_breach", breach: "risk_breach", review: "eod_reviewed" };

export function typeMeta(type: string | null | undefined): TypeMeta {
  const t = LEGACY[type ?? ""] ?? (type ?? "system");
  return TYPE_INDEX.get(t) ?? meta(t, "system", "info");
}

export const TYPE_ICONS: Record<string, LucideIcon> = {
  mention: AtSign, reply: MessageSquareReply, review_request: HelpCircle, thread_new: MessageSquarePlus,
  idea_submitted: Lightbulb, idea_review: ClipboardCheck, idea_comment: MessageSquare,
  eod_review_request: CalendarCheck, eod_overdue: AlarmClock, eod_reviewed: CheckCircle2, weekly_review: CalendarRange,
  rating: Star, rating_ack: BadgeCheck, discipline_badge: Award,
  risk_warn: TriangleAlert, risk_breach: OctagonAlert, risk_repeat_breach: OctagonAlert, risk_breach_review: ClipboardCheck, limit_change: SlidersHorizontal, rule_violation: ShieldAlert,
  scaling_proposal: TrendingUp, scaling_decision: Gavel,
  academy_promotion_ready: GraduationCap, academy_promotion_request: GraduationCap, academy_promotion_decision: Gavel,
  academy_challenge_assigned: Target, academy_challenge_passed: Trophy, academy_challenge_failed: OctagonAlert,
  academy_enrolled: GraduationCap, academy_stage_change: GraduationCap, academy_goal_assigned: Target, academy_goal_achieved: Trophy,
  academy_goal_missed: TriangleAlert, academy_action_assigned: ClipboardCheck, academy_action_overdue: AlarmClock,
  academy_submitted: ClipboardCheck, academy_graded: BadgeCheck,
  sync: RefreshCw, sync_unmatched: Link2Off, system: Info,
};

export function iconFor(type: string): LucideIcon {
  return TYPE_ICONS[typeMeta(type).type] ?? Bell;
}

export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  get info() { return notificationsI18n.t("severity.info"); },
  get warn() { return notificationsI18n.t("severity.warn"); },
  get critical() { return notificationsI18n.t("severity.critical"); },
};
export const SEVERITY_TONE: Record<Severity, Tone> = { info: "accent", warn: "warn", critical: "down" };
export const SEVERITY_ORDER: Severity[] = ["critical", "warn", "info"];

/** Icon tile classes per severity (unread) — read items fall back to a neutral tile. */
export const SEVERITY_TILE: Record<Severity, string> = {
  info: "bg-primary/15 text-primary",
  warn: "bg-[hsl(var(--chart-3)/0.18)] text-[hsl(var(--chart-3))]",
  critical: "bg-down/15 text-down",
};

const INLINE_PATH_RE = /\s*(?:https?:\/\/[^\s/]+)?\/(?:discussions|trade-ideas|trades|journal|risk|scaling|weekly-review|ratings|integrations|playbook|watchlist|events|curator|rules|game-plan|day-report|academy(?:\/[a-z-]+)?)(?:\?[^\s»"')]*)?\s*$/u;
const LINK_RE = /(?:https?:\/\/[^\s/]+)?(\/(?:discussions|trade-ideas|trades|journal|risk|scaling|weekly-review|ratings|integrations|playbook|watchlist|events)(?:\?[^\s»"')]*)?)/;

/** Accepts both the new camelCase payload and the pre-Wave-C snake_case rows (older API build). */
export function normalizeNotification(raw: unknown): Notification | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = Number(r.id);
  if (!Number.isInteger(id)) return null;
  const meta = typeMeta(typeof r.type === "string" ? r.type : "system");
  const legacyMessage = typeof r.message === "string" ? r.message : "";
  const body = typeof r.body === "string" ? r.body : legacyMessage.replace(INLINE_PATH_RE, "").trim();
  const ideaIdRaw = r.ideaId ?? r.idea_id;
  const ideaId = ideaIdRaw == null ? null : Number(ideaIdRaw);
  const linkRaw = typeof r.link === "string" ? r.link : null;
  const link = linkRaw ?? (ideaId != null && Number.isInteger(ideaId) ? `/trade-ideas?idea=${ideaId}` : (LINK_RE.exec(legacyMessage)?.[1] ?? null));
  // A row without its own title gets the server's type label as title — show ours (UI language) instead.
  const serverLabel = typeof r.typeLabel === "string" ? r.typeLabel : null;
  const ownTitle = typeof r.title === "string" && r.title && r.title !== serverLabel ? r.title : "";
  const severity = (typeof r.severity === "string" && ["info", "warn", "critical"].includes(r.severity) ? r.severity : meta.severity) as Severity;
  const readAt = typeof r.readAt === "string" ? r.readAt : null;
  const isRead = typeof r.isRead === "boolean" ? r.isRead : typeof r.is_read === "boolean" ? r.is_read : readAt != null;
  return {
    id,
    type: meta.type,
    typeLabel: serverLabel ?? meta.label,
    group: (typeof r.group === "string" ? r.group : meta.group) as NotificationGroup,
    severity,
    title: ownTitle,
    body,
    link,
    entityType: typeof r.entityType === "string" ? r.entityType : null,
    entityId: r.entityId == null ? null : String(r.entityId),
    actor: typeof r.actor === "string" ? r.actor : null,
    ideaId: ideaId != null && Number.isInteger(ideaId) ? ideaId : null,
    isRead,
    readAt,
    archivedAt: typeof r.archivedAt === "string" ? r.archivedAt : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : typeof r.created_at === "string" ? r.created_at : new Date(0).toISOString(),
  };
}

export function normalizePage(raw: unknown): NotificationPage {
  if (Array.isArray(raw)) return { items: raw.map(normalizeNotification).filter((n): n is Notification => !!n), nextCursor: null };
  const r = (raw ?? {}) as { items?: unknown; nextCursor?: unknown };
  const items = Array.isArray(r.items) ? r.items.map(normalizeNotification).filter((n): n is Notification => !!n) : [];
  return { items, nextCursor: typeof r.nextCursor === "string" ? r.nextCursor : null };
}

/** Title to show: the notification's own text, else its type label in the UI language. */
export function notificationTitle(n: Pick<Notification, "title" | "type">): string {
  return n.title || typeLabelOf(n.type);
}

// ─── time helpers ───────────────────────────────────────────────────────────

/** Compact age for the bell: «только что», «5 мин», «3 ч», «2 дн», then the date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.round((now - t) / 60000);
  if (m < 1) return notificationsI18n.t("ago.justNow");
  if (m < 60) return notificationsI18n.t("ago.minutes", { count: m });
  const h = Math.round(m / 60);
  if (h < 24) return notificationsI18n.t("ago.hours", { count: h });
  const d = Math.round(h / 24);
  if (d < 7) return notificationsI18n.t("ago.days", { count: d });
  return fmtDate(t, "dayMonthNumeric");
}

function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** «Сегодня» / «Вчера» / «12 марта» for the day-group header (local calendar day of the viewer). */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const key = localYmd(d);
  if (key === localYmd(now)) return commonI18n.t("time.today");
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (key === localYmd(y)) return commonI18n.t("time.yesterday");
  return fmtDate(d, d.getFullYear() !== now.getFullYear() ? "long" : "dayMonthLong");
}

export type DayGroup = { key: string; label: string; items: Notification[] };

export function groupByDay(items: readonly Notification[], now = new Date()): DayGroup[] {
  const groups: DayGroup[] = [];
  const index = new Map<string, DayGroup>();
  for (const n of items) {
    const d = new Date(n.createdAt);
    const key = Number.isNaN(d.getTime()) ? "unknown" : localYmd(d);
    let g = index.get(key);
    if (!g) {
      g = { key, label: dayLabel(n.createdAt, now), items: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.items.push(n);
  }
  return groups;
}

// ─── API ────────────────────────────────────────────────────────────────────

export const NOTIF_KEYS = {
  count: (me: string | null) => ["notifications-count", me] as const,
  list: (me: string | null, params = "") => ["notifications", me, params] as const,
  prefs: (me: string | null) => ["notification-prefs", me] as const,
};

export type ListFilters = {
  unread?: boolean;
  types?: string[];
  severities?: Severity[];
  archived?: "0" | "1" | "all";
  since?: string;
  limit?: number;
};

export function filterParams(f: ListFilters): string {
  const p = new URLSearchParams();
  if (f.unread) p.set("unread", "1");
  if (f.types?.length) p.set("type", f.types.join(","));
  if (f.severities?.length) p.set("severity", f.severities.join(","));
  if (f.archived && f.archived !== "0") p.set("archived", f.archived);
  if (f.since) p.set("since", f.since);
  p.set("limit", String(f.limit ?? 30));
  return p.toString();
}

export const notificationsApi = {
  async count(): Promise<UnreadCount> {
    const d = await http.get<Partial<UnreadCount>>("/api/notifications/count");
    return { unread: Number(d.unread ?? 0), critical: Number(d.critical ?? 0), warn: Number(d.warn ?? 0) };
  },
  async list(params: string, cursor?: string | null): Promise<NotificationPage> {
    return normalizePage(await http.get(`/api/notifications?${params}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
  },
  async prefs(): Promise<Prefs> {
    const d = await http.get<Partial<Prefs>>("/api/notifications/prefs");
    return { prefs: Array.isArray(d.prefs) ? d.prefs : [], muteAllUntil: typeof d.muteAllUntil === "string" ? d.muteAllUntil : null };
  },
  savePrefs: (p: Prefs) => http.put<Prefs>(`/api/notifications/prefs`, p),
  readAll: (type?: string) => http.patch(`/api/notifications/read-all`, type ? { type } : {}),
  readMany: (ids: number[]) => http.post(`/api/notifications/read-many`, { ids }),
  unreadMany: (ids: number[]) => http.post(`/api/notifications/unread-many`, { ids }),
  archive: (ids: number[]) => http.post(`/api/notifications/archive`, { ids }),
  /** `ids` — what was archived (for undo); absent on older API builds. */
  archiveRead: () => http.post<{ updated?: number; ids?: number[] } | null>(`/api/notifications/archive`, { read: true }),
  unarchive: (ids: number[]) => http.post(`/api/notifications/unarchive`, { ids }),
  readOne: (id: number) => http.patch(`/api/notifications/${id}/read`),
};
