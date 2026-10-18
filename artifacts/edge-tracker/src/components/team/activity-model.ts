import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookMarked,
  BookOpen,
  CalendarCheck,
  ClipboardCheck,
  Clock,
  Eye,
  Lightbulb,
  List,
  Mail,
  Megaphone,
  MessageSquare,
  NotebookPen,
  RefreshCw,
  ShieldAlert,
  Star,
  TrendingUp,
  Zap,
} from "lucide-react";
import { isToday, isYesterday } from "date-fns";
import { fmtDate, fmtRelative, fmtWeekday } from "@/lib/format";
import { activityI18n } from "@/i18n/ns/activity";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";
import ruActivity from "@/i18n/locales/ru/activity";
import type { Tone } from "@/components/ds";
import { links } from "@/lib/links";

export type FeedItem = {
  uid: string;
  action: string;
  section: string;
  entityId: string | null;
  entityTitle: string | null;
  trader: string | null;
  details: string | null;
  rating: string | null;
  createdAt: string;
};

/** `scope` — "team" | "<trader>" (staff filter) | "me"; absent on legacy API builds. */
export type FeedPage = { items: FeedItem[]; nextCursor: string | null; scope?: string };

export type ActivitySummary = {
  range: { from: string; to: string; date: string };
  scope?: string;
  total: number;
  bySection: { section: string; action: string; count: number }[];
  topTraders: { trader: string; count: number }[];
  trades: {
    count: number;
    wins: number;
    losses: number;
    be?: number;
    sumR: number | null;
    avgR: number | null;
    /** P&L нетто (брутто − комиссии) по закрытым сделкам дня; null, пока P&L не заполнен. */
    net?: number | null;
    traders: number;
    best: { id: number; ticker: string; trader: string | null; rMultiple: number | null; side: string | null } | null;
  };
  facets: { sections30d: { section: string; count: number }[]; traders: string[] };
};

/**
 * Sections of the feed. `path` is the landing page; `highlight` means the entity id can be deep-linked
 * (`?highlight=`). Sections without a path (digest) are informational only. Labels: `sectionMeta(s).label`.
 */
export const SECTION_META: Record<string, { icon: LucideIcon; path?: string; highlight?: boolean }> = {
  trades: { icon: List, path: "/trades", highlight: true },
  "trade-ideas": { icon: Lightbulb, path: "/trade-ideas" },
  playbook: { icon: BookMarked, path: "/playbook", highlight: true },
  discussions: { icon: MessageSquare, path: "/discussions" },
  research: { icon: BookOpen, path: "/research" },
  dailyfeed: { icon: Clock, path: "/dailyfeed" },
  events: { icon: Zap, path: "/events" },
  watchlist: { icon: Eye, path: "/watchlist" },
  digest: { icon: Mail },
  journal: { icon: NotebookPen, path: "/journal" },
  eod: { icon: CalendarCheck, path: "/journal" },
  risk: { icon: ShieldAlert, path: "/risk" },
  "game-plan": { icon: ClipboardCheck, path: "/game-plan" },
  ratings: { icon: Star, path: "/ratings" },
  sync: { icon: RefreshCw, path: "/integrations" },
  scaling: { icon: TrendingUp, path: "/scaling" },
  "weekly-review": { icon: CalendarCheck, path: "/weekly-review" },
  offerings: { icon: Megaphone, path: "/offerings" },
};

/** Section icon/path plus its label in the current language (unknown codes show as is). */
export function sectionMeta(section: string): { label: string; icon: LucideIcon; path?: string; highlight?: boolean } {
  const def = SECTION_META[section];
  const label = activityI18n.tryT(`sections.${section}`) ?? section;
  return def ? { ...def, label } : { label, icon: Activity };
}

/** Action groups used by the "Тип" filter (sent to the API as an `actions` list). Labels: `actionGroupLabel`. */
export const ACTION_GROUPS = {
  all: { actions: [] as string[] },
  new: { actions: ["created", "published", "converted", "synced"] },
  edit: { actions: ["updated", "resubmitted", "reopened", "reconciled"] },
  social: { actions: ["reviewed", "liked", "reacted", "commented", "rated", "acknowledged"] },
  desk: { actions: ["closed", "violation", "halted", "limit_warning", "approved", "rejected", "conflict"] },
  removed: { actions: ["deleted"] },
} as const;
export type ActionGroup = keyof typeof ACTION_GROUPS;

export function actionGroupLabel(g: ActionGroup): string {
  return activityI18n.t(`groups.${g}`);
}

export function actionTone(action: string): Tone {
  switch (action) {
    case "created":
    case "published":
    case "converted":
    case "synced":
    case "approved":
    case "closed":
      return "up";
    case "deleted":
    case "violation":
    case "halted":
    case "rejected":
    case "conflict":
      return "down";
    case "reviewed":
    case "rated":
      return "purple";
    case "liked":
    case "reacted":
    case "commented":
    case "acknowledged":
    case "limit_warning":
      return "warn";
    case "updated":
    case "resubmitted":
    case "reopened":
    case "reconciled":
      return "accent";
    default:
      return "neutral";
  }
}

/*
 * Phrases never conjugate a verb by the actor — we don't know anyone's gender, so they read
 * «Ольга Н.: добавлена сделка» / «Olga N.: trade added» / «Olga N.: savdo qoʻshildi». RU participles agree with the
 * NOUN (its gender lives in the dictionary: `nouns.<section>.gender`); EN/UZ verbs have one form.
 */
type NounKey = keyof typeof ruActivity.nouns;
type VerbKey = keyof typeof ruActivity.verbs;
type Gender = "m" | "f" | "n";

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function nounKey(section: string): NounKey {
  return (hasOwn(ruActivity.nouns, section) ? section : "fallback") as NounKey;
}
function isVerb(action: string): action is VerbKey {
  return hasOwn(ruActivity.verbs, action);
}
function nounGender(k: NounKey): Gender {
  const g = activityI18n.t(`nouns.${k}.gender`);
  return g === "m" || g === "f" ? g : "n";
}

/** «добавлена сделка» — the participle agrees with the noun, never with the actor. */
function passive(action: string, section: string): string {
  const k = nounKey(section);
  const noun = activityI18n.t(`nouns.${k}.word`);
  if (!isVerb(action)) return activityI18n.t("phrase.unknown", { action, noun });
  return activityI18n.t("phrase.single", { verb: activityI18n.t(`verbs.${action}.${nounGender(k)}`), noun });
}

/** Playbook rows that are really about a setup's examples («Эталоны (Tier 1): +2», «Эталон убран …»), not the setup. */
export function isExampleChange(item: Pick<FeedItem, "section" | "details">): boolean {
  // `details` is text the server logged in Russian; this only recognizes it, nothing is shown.
  return item.section === "playbook" && /^Эталон/.test(item.details ?? ""); // i18n-ignore
}

/** Curator rating key → text in the UI language (unknown values pass through). */
export function ratingLabel(r: string): string {
  return activityI18n.tryT(`ratings.${r}`) ?? r;
}

// Stored comment prefixes (discussions/lib.ts COMMENT_RE); data, matched in every UI language.
const COMMENT_PREFIX = /^(\[(?:Observing|In Position|Exited|Наблюдаю|В позиции|Вышел)\]\s*)?(\[re:\d+\]\s*)?/; // i18n-ignore

/** Idea reactions are logged as «thumbs_down: comment» — show the reaction in the UI language. */
export function detailsText(item: Pick<FeedItem, "action" | "details">): string | null {
  const d = item.details;
  // Comments are logged with their machine prefixes («[Наблюдаю] [re:12] text»): show what the person wrote.
  if (d && item.action === "commented") return d.replace(COMMENT_PREFIX, "") || d;
  if (!d || item.action !== "reacted") return d;
  const m = /^(thumbs_up|thumbs_down|warning)(?::\s*(.*))?$/s.exec(d);
  if (!m) return d;
  const reaction = activityI18n.tryT(`reactions.${m[1]}`) ?? m[1]!;
  return m[2] ? activityI18n.t("reactionWithText", { reaction, text: m[2] }) : reaction;
}

/**
 * Phrase shown after «Имя:» for a single feed item, e.g. «добавлена сделка» / «trade added».
 * Gender-neutral by construction: RU participles agree with the noun, EN/UZ use the passive.
 */
export function describe(item: FeedItem): string {
  const t = activityI18n.t;
  const s = item.section;
  if (isExampleChange(item)) {
    if (item.action === "created") return t("special.exampleAdded");
    if (item.action === "deleted") return t("special.exampleRemoved");
    if (item.action === "updated") return t("special.exampleChanged");
  }
  switch (item.action) {
    case "reviewed":
      if (s === "trades") return t("special.tradeReview");
      if (s === "eod" || s === "journal") return t("special.dayReviewed");
      if (s === "weekly-review") return t("special.weekReviewed");
      return passive("reviewed", s);
    case "liked": return t("special.tradeReaction");
    case "reacted": return t("special.ideaReaction");
    case "commented": return t("special.comment");
    case "converted": return t("special.ideaConverted");
    case "digest_evening_sent": return t("special.digestEvening");
    case "digest_morning_sent": return t("special.digestMorning");
    case "created":
      if (s === "discussions") return t("special.discussionOpened");
      if (s === "game-plan") return t("special.gamePlanWritten");
      if (s === "journal") return t("special.journalFilled");
      return passive("created", s);
    case "closed":
      if (s === "eod" || s === "journal") return t("special.dayClosed");
      return passive("closed", s);
    case "reopened":
      if (s === "eod" || s === "journal") return t("special.dayReopened");
      return passive("reopened", s);
    case "acknowledged":
      if (s === "game-plan") return t("special.gamePlanRead");
      if (s === "risk") return t("special.violationAcknowledged");
      return passive("acknowledged", s);
    case "rated":
      return s === "ratings" || s === "trades" ? t("special.gradeGiven") : passive("rated", s);
    case "synced":
      return s === "sync" ? t("special.tradesSynced") : passive("synced", s);
    case "reconciled": return t("special.tradesReconciled");
    case "conflict": return t("special.brokerMismatch");
    case "violation": return t("special.ruleViolation");
    case "halted": return t("special.halted");
    case "limit_warning": return t("special.nearLimit");
    case "approved":
      if (s === "scaling") return t("special.scalingApproved");
      return passive("approved", s);
    case "rejected":
      if (s === "scaling") return t("special.scalingRejected");
      return passive("rejected", s);
    default:
      return isVerb(item.action) ? passive(item.action, s) : item.action;
  }
}

/** Phrase for a collapsed burst of N identical actions («добавлено: 12 сделок» / «12 trades added»). */
export function describeBurst(action: string, section: string, n: number, examples = false): string {
  const t = activityI18n.t;
  if (examples && action === "created") return t("bursts.examplesAdded", { count: n });
  if (examples && action === "deleted") return t("bursts.examplesRemoved", { count: n });
  const nouns = activityI18n.tryT(`nouns.${nounKey(section)}.count`, { count: n }) ?? String(n);
  switch (action) {
    case "reviewed":
      return section === "trades" ? t("bursts.tradeReviews", { count: n }) : t("phrase.burst", { verb: t("verbs.reviewed.n"), nouns });
    case "rated": return t("bursts.grades", { count: n });
    case "liked":
    case "reacted": return t("bursts.reactions", { count: n });
    case "commented": return t("bursts.comments", { count: n });
    case "synced": return t("bursts.tradesSynced", { count: n });
    case "violation": return t("bursts.violations", { count: n });
    default:
      return t("phrase.burst", { verb: isVerb(action) ? t(`verbs.${action}.n`) : action, nouns });
  }
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Entity title as shown. A curator's day review is logged with the title «трейдер, YYYY-MM-DD» (entity
 * «YYYY-MM-DD|трейдер»): the name part follows the UI language (personName); other titles are user content.
 */
export function itemTitle(item: Pick<FeedItem, "section" | "entityId" | "entityTitle">): string | undefined {
  const title = item.entityTitle?.trim();
  if (!title) return undefined;
  if (item.section !== "journal" && item.section !== "eod") return title;
  const owner = (item.entityId ?? "").split("|")[1]?.trim();
  return owner && title.startsWith(owner) ? personName(owner) + title.slice(owner.length) : title;
}

/** In-app link for an item, or null if the entity is gone / has no page. Built with @/lib/links. */
export function itemHref(item: FeedItem): string | null {
  const meta = SECTION_META[item.section];
  if (!meta?.path) return null;
  if (item.action === "deleted") return null;
  const id = item.entityId?.trim() ?? "";
  const numId = /^\d+$/.test(id) ? Number(id) : null;
  switch (item.section) {
    case "trades":
      if (numId != null) return links.trade(numId);
      if (/^\d+(,\d+)+$/.test(id)) return links.trades({ ids: id.split(",").map(Number) });
      return links.trades();
    case "playbook":
      return numId != null ? links.setup(numId) : meta.path;
    case "trade-ideas":
      return numId != null ? links.idea(numId) : meta.path;
    case "discussions":
      return numId != null ? links.thread(numId) : meta.path;
    case "journal":
    case "eod": {
      // A curator's review is logged as «YYYY-MM-DD|трейдер»: the actor is the curator, the day is the trader's.
      const [day = "", owner = ""] = id.split("|");
      return YMD.test(day) ? links.journalDay(day, owner || (item.trader ?? undefined)) : meta.path;
    }
    case "game-plan":
      return YMD.test(id) ? links.gamePlan(id) : links.gamePlan();
    case "risk":
      return links.risk(item.trader ?? undefined);
    case "scaling":
      return links.scaling(item.trader ?? undefined);
    case "weekly-review":
      return links.weeklyReview({ trader: item.trader ?? undefined, week: YMD.test(id) ? id : undefined });
    case "ratings":
      return item.trader ? `/ratings?trader=${encodeURIComponent(item.trader)}` : meta.path;
    case "events":
      return id && !numId ? links.events(id) : meta.path;
    case "watchlist":
      return id && !numId ? links.watchlist(id) : meta.path;
    case "offerings":
      return id && !numId ? links.offerings(id) : meta.path;
    default:
      if (meta.highlight && numId != null) return `${meta.path}?highlight=${numId}`;
      return meta.path;
  }
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return commonI18n.t("time.today");
  if (isYesterday(d)) return commonI18n.t("time.yesterday");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${fmtDate(d, sameYear ? "dayMonthLong" : "long")}, ${fmtWeekday(d, "long")}`;
}

export function capFirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : fmtDate(d, "time");
}

export function relTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return Date.now() - d.getTime() < 86_400_000 ? fmtRelative(d) : fmtDate(d, "dateTime");
}

export type Burst = { key: string; items: FeedItem[] };
export type DayGroup = { key: string; label: string; bursts: Burst[] };

const BURST_WINDOW_MS = 15 * 60 * 1000;

/** Group items by local day; inside a day collapse runs of the same actor+action+section within 15 minutes. */
export function groupFeed(items: FeedItem[]): DayGroup[] {
  const days: DayGroup[] = [];
  for (const it of items) {
    const k = dayKey(it.createdAt);
    let day = days[days.length - 1];
    if (!day || day.key !== k) {
      day = { key: k, label: dayLabel(it.createdAt), bursts: [] };
      days.push(day);
    }
    const last = day.bursts[day.bursts.length - 1];
    const prev = last?.items[last.items.length - 1];
    const sameRun =
      prev &&
      prev.trader === it.trader &&
      prev.action === it.action &&
      prev.section === it.section &&
      isExampleChange(prev) === isExampleChange(it) &&
      !it.section.startsWith("digest") &&
      Math.abs(new Date(prev.createdAt).getTime() - new Date(it.createdAt).getTime()) <= BURST_WINDOW_MS;
    if (sameRun) last.items.push(it);
    else day.bursts.push({ key: it.uid, items: [it] });
  }
  return days;
}
