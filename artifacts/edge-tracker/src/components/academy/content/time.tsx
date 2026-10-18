/**
 * Timestamps for remote + office students: the viewer's local time, plus New York time when it differs
 * (market-related deadlines and reviews are discussed in NY time).
 */
import { fmtDate, fmtDateCustom } from "@/lib/format";
import { academyI18n } from "@/i18n/ns/academy";

const NY_OFFSET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
const LOCAL_OFFSET = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

export function formatLocal(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? fmtDateCustom(d, { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "—";
}

export function formatNy(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  if (NY_OFFSET.format(d) === LOCAL_OFFSET.format(d)) return null; // viewer is already on NY time
  return `${fmtDate(d, "numericDateTime", { timeZone: "America/New_York" })} NY`;
}

export function DualTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const { t } = academyI18n.useT();
  const ny = formatNy(iso);
  return (
    <time dateTime={iso ?? undefined} className={className ?? "tabular-nums"} title={ny ? t("time.yourTime", { ny }) : t("time.sameTz")}>
      {formatLocal(iso)}
      {ny && <span className="ml-1 text-muted-foreground">({ny})</span>}
    </time>
  );
}

/** Whole days since `iso` (0 = today); null when there is no date. */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null;
}

/** «сегодня» / «вчера» / «5 дн. назад» in the UI language (day granularity). Call at render time. */
export function relativeDays(iso: string | null | undefined, now = Date.now()): string {
  const t = academyI18n.t;
  const days = daysSince(iso, now);
  if (days == null) return t("time.noActivity");
  if (days === 0) return t("time.today");
  if (days === 1) return t("time.yesterday");
  return t("time.daysAgo", { count: days });
}
