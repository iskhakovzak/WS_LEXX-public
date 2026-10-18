// Discipline badges and levels (api-server lib/daily/badges.ts, discipline.ts): icon, name and «how to earn» per badge,
// level names. Shared by the dashboard rewards chip (components/daily) and the curator profile (components/curator).
// Texts: i18n namespace `daily` (rewards.*).
import type { LucideIcon } from "lucide-react";
import { CalendarCheck, ClipboardCheck, Crosshair, Crown, Flame, History, ShieldCheck, Swords } from "lucide-react";
import type { BadgeId, BadgeState } from "@/lib/daily/types";
import { dailyI18n } from "@/i18n/ns/daily";

export const BADGE_ICON: Readonly<Record<BadgeId, LucideIcon>> = {
  streak_1: Flame,
  streak_2: ShieldCheck,
  streak_3: Crown,
  reviews: ClipboardCheck,
  focus: Crosshair,
  clean_month: CalendarCheck,
  sim_first: History,
  sim_beat: Swords,
};

const HOW: Readonly<Record<BadgeId, string>> = {
  streak_1: "streak", streak_2: "streak", streak_3: "streak", reviews: "reviews", focus: "focus",
  clean_month: "clean_month", sim_first: "sim_first", sim_beat: "sim_beat",
};

/** «Контракт 5 дней подряд» — the badge name with its number. */
export function badgeName(b: Pick<BadgeState, "id" | "target">): string {
  return dailyI18n.tryT(`rewards.badge.${b.id}`, { count: b.target }) ?? b.id;
}

/** How to earn it (locked badges). */
export function badgeHow(id: BadgeId): string {
  return dailyI18n.tryT(`rewards.how.${HOW[id]}`) ?? "";
}

/** «Стабильный» — level name; levels past the dictionary show their number. */
export function levelName(level: number): string {
  return dailyI18n.tryT(`rewards.level.${level}`) ?? String(level);
}

/** Earned first (newest first), then locked by progress. */
export function sortBadges(list: readonly BadgeState[]): BadgeState[] {
  return [...list].sort((a, b) => {
    if (a.earnedOn && b.earnedOn) return b.earnedOn.localeCompare(a.earnedOn);
    if (a.earnedOn || b.earnedOn) return a.earnedOn ? -1 : 1;
    return b.progress / Math.max(1, b.target) - a.progress / Math.max(1, a.target);
  });
}
