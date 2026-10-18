import { cn } from "@/lib/utils";
import { fmtDate, fmtWeekday } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { adminI18n } from "@/i18n/ns/admin";

function dayLabel(ymd: string) {
  return `${fmtWeekday(ymd, "short")} ${fmtDate(ymd, "dayMonthNumeric")}`;
}

function isWeekend(ymd: string) {
  const wd = new Date(`${ymd}T12:00:00`).getDay();
  return wd === 0 || wd === 6;
}

/**
 * 14-day activity heat strip: one cell per day, opacity = trades that day, a dot under the
 * cell when the daily journal was written. Weekends are dimmed. Fully labelled for screen readers.
 */
export function ActivityStrip({
  days,
  trades,
  journal,
  className,
  size = "md",
}: {
  days: string[];
  trades: number[];
  journal?: boolean[];
  className?: string;
  size?: "sm" | "md";
}) {
  const max = Math.max(1, ...trades);
  const totalTrades = trades.reduce((s, v) => s + v, 0);
  const totalNotes = journal ? journal.filter(Boolean).length : 0;
  const { t } = adminI18n.useT();
  const tradesOf = (count: number) => commonI18n.t("units.trades", { count });
  const label = journal
    ? t("strip.ariaJournal", { days: days.length, trades: tradesOf(totalTrades), notes: totalNotes })
    : t("strip.aria", { days: days.length, trades: tradesOf(totalTrades) });
  const cell = size === "sm" ? "h-3 w-2" : "h-4 w-2.5";
  return (
    <div role="img" aria-label={label} className={cn("inline-flex items-end gap-[3px]", className)}>
      {days.map((d, i) => {
        const n = trades[i] ?? 0;
        const wk = isWeekend(d);
        const intensity = n === 0 ? 0 : 0.3 + 0.7 * (n / max);
        return (
          <span key={d} className="flex flex-col items-center gap-[2px]" title={t(journal ? (journal[i] ? "strip.cellJournal" : "strip.cellNoJournal") : "strip.cell", { day: dayLabel(d), trades: tradesOf(n) })}>
            <span
              className={cn(cell, "rounded-[3px]", n === 0 ? (wk ? "bg-[var(--glass-bg)] opacity-50" : "bg-[var(--glass-bg)] ring-1 ring-inset ring-[var(--glass-border)]") : "bg-primary")}
              style={n > 0 ? { opacity: intensity } : undefined}
            />
            {journal && (
              <span className={cn("h-1 w-1 rounded-full", journal[i] ? "bg-up" : "bg-transparent")} />
            )}
          </span>
        );
      })}
    </div>
  );
}

/** Bar strip for desk-wide counts (overview tile). */
export function BarStrip({ days, values, className }: { days: string[]; values: number[]; className?: string }) {
  const { t } = adminI18n.useT();
  const max = Math.max(1, ...values);
  return (
    <div role="img" aria-label={t("strip.barsAria", { values: values.join(", ") })} className={cn("flex h-16 items-end gap-1", className)}>
      {days.map((d, i) => {
        const v = values[i] ?? 0;
        return (
          <span key={d} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${dayLabel(d)}: ${v}`}>
            <span
              className={cn("w-full rounded-md", v > 0 ? "bg-primary/70" : "bg-[var(--glass-bg)]", i === days.length - 1 && v > 0 && "bg-primary")}
              style={{ height: `${Math.max(6, (v / max) * 100)}%` }}
            />
          </span>
        );
      })}
    </div>
  );
}
