import { useId, useState } from "react";
import { Award, ChevronDown, Flame } from "lucide-react";
import type { BadgeState, DisciplineSummary } from "@/lib/daily/types";
import { cn } from "@/lib/utils";
import { dailyI18n } from "@/i18n/ns/daily";
import { BADGE_ICON, badgeHow, badgeName, levelName, sortBadges } from "@/components/shared/badges";
import { fmtDelta } from "./daily-model";
import { dayShort } from "./focus-line";

/**
 * «🔥 4 · 185 очк.» — the kept-contract streak and the discipline points, next to the tier progress where the trader
 * looks every day; the «Награды» block (level, points, streak, badges) opens in place. Points reward the own contract
 * only — never trading more. `defaultOpen` = the badge notification's link (/?rewards=1).
 */
export function RewardsChip({ discipline, badges, defaultOpen = false }: { discipline: DisciplineSummary | null | undefined; badges: readonly BadgeState[] | undefined; defaultOpen?: boolean }) {
  const { t } = dailyI18n.useT();
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  if (!discipline) return null;
  const list = badges ?? [];
  const earned = list.filter((b) => b.earnedOn).length;
  const hot = discipline.streak > 0;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t("rewards.chipAria", { streak: discipline.streak, points: discipline.pointsTotal })}
        className="group inline-flex min-h-8 min-w-0 items-center gap-1.5 self-start rounded-lg px-1.5 text-sm font-medium transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Flame className={cn("h-4 w-4 shrink-0", hot ? "text-warn" : "text-muted-foreground")} aria-hidden="true" />
        <span className="tabular-nums">{discipline.streak}</span>
        <span className="text-muted-foreground" aria-hidden="true">·</span>
        <span className="tabular-nums">{t("rewards.points", { points: discipline.pointsTotal })}</span>
        {list.length > 0 && (
          <span className="inline-flex items-center gap-0.5 text-muted-foreground">
            <Award className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="tabular-nums">{earned}</span>
          </span>
        )}
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && <RewardsPanel id={panelId} discipline={discipline} badges={list} />}
    </div>
  );
}

function RewardsPanel({ id, discipline: d, badges }: { id: string; discipline: DisciplineSummary; badges: readonly BadgeState[] }) {
  const { t } = dailyI18n.useT();
  const span = d.nextLevelAt != null ? d.nextLevelAt - d.levelFrom : 0;
  const pct = d.nextLevelAt == null ? 100 : span > 0 ? Math.max(0, Math.min(100, Math.round(((d.pointsTotal - d.levelFrom) / span) * 100))) : 0;
  const earned = badges.filter((b) => b.earnedOn).length;
  return (
    <div id={id} className="flex w-full min-w-0 flex-col gap-3 rounded-xl bg-foreground/[0.04] p-3 lg:w-[28rem]">
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-sm font-semibold">{levelName(d.level)}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {d.nextLevelAt != null ? t("rewards.levelTo", { level: levelName(d.level + 1), left: Math.max(0, d.nextLevelAt - d.pointsTotal) }) : t("rewards.levelTop")}
          </span>
        </div>
        <span className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
          <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </span>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
          <span>{t("rewards.window", { days: d.windowDays, points: fmtDelta(d.points30) })}</span>
          <span>{t("rewards.total", { points: d.pointsTotal })}</span>
        </div>
      </div>
      <div className="flex min-w-0 items-start gap-1.5 text-xs">
        <Flame className={cn("mt-px h-3.5 w-3.5 shrink-0", d.streak > 0 ? "text-warn" : "text-muted-foreground")} aria-hidden="true" />
        <p className="min-w-0">
          <span className="font-medium text-foreground">
            {d.streak > 0 ? t("rewards.streak", { days: t("rewards.streakDays", { count: d.streak }) }) : t("rewards.streakNone")}
          </span>
          {d.bestStreak > d.streak && <span className="text-muted-foreground"> · {t("rewards.best", { count: d.bestStreak })}</span>}
          {d.nextBonus > 0 && <span className="text-muted-foreground"> · {t("rewards.nextBonus", { bonus: d.nextBonus })}</span>}
        </p>
      </div>
      {badges.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="micro-label">{t("rewards.title")}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{t("rewards.badgesEarned", { earned, total: badges.length })}</span>
          </div>
          <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2" aria-label={t("rewards.badgesAria")}>
            {sortBadges(badges).map((b) => <BadgeTile key={b.id} badge={b} />)}
          </ul>
        </div>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">{t("rewards.hint")}</p>
    </div>
  );
}

function BadgeTile({ badge: b }: { badge: BadgeState }) {
  const { t } = dailyI18n.useT();
  const Icon = BADGE_ICON[b.id] ?? Award;
  const done = !!b.earnedOn;
  const how = badgeHow(b.id);
  return (
    <li className="flex min-w-0 items-start gap-2 rounded-lg p-1.5" title={done ? undefined : how}>
      <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", done ? "bg-primary/15 text-primary" : "bg-foreground/[0.06] text-muted-foreground/70")}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-xs font-medium leading-tight", done ? "text-foreground" : "text-muted-foreground")}>{badgeName(b)}</span>
        {done ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">{t("rewards.earnedOn", { date: dayShort(b.earnedOn!) })}</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
              <span className="block h-full rounded-full bg-muted-foreground/60" style={{ width: `${Math.round((b.progress / Math.max(1, b.target)) * 100)}%` }} />
            </span>
            <span className="shrink-0 tabular-nums">{t("rewards.progress", { progress: b.progress, target: b.target })}</span>
            <span className="min-w-0 truncate">{how}</span>
          </span>
        )}
      </span>
    </li>
  );
}
