import { Link } from "wouter";
import { CalendarDays, Check, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtDate, fmtUsd } from "@/lib/format";
import { whatIfI18n } from "@/i18n/ns/whatIf";
import { type Rule, isApplied } from "./rules";
import type { DayChange, Question } from "./presets";

/**
 * «А что если бы я…» — the five ready questions as toggle chips at the top of the page. A question the data cannot
 * answer stays visible but disabled, with the reason, so the trader knows what to mark to unlock it.
 */
export function QuestionsBar({ questions, rules, onToggle }: { questions: Question[]; rules: Rule[]; onToggle: (q: Question, applied: boolean) => void }) {
  const { t } = whatIfI18n.useT();
  return (
    <section aria-labelledby="sim-questions" className="flex flex-col gap-2">
      <h2 id="sim-questions" className="text-sm font-semibold">{t("questions.title")}</h2>
      <div className="flex flex-wrap gap-2">
        {questions.map((q) => {
          const applied = q.rule != null && isApplied(rules, q.rule);
          return (
            <button
              key={q.id}
              type="button"
              disabled={!!q.disabled}
              aria-pressed={applied}
              title={q.disabled ? t("questions.unavailable", { reason: q.disabled }) : q.hint || undefined}
              onClick={() => onToggle(q, applied)}
              className={cn(
                "inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-left text-sm transition-colors duration-[var(--dur-1)]",
                applied ? "border-primary bg-primary-solid text-primary-foreground" : "border-[var(--glass-border)] bg-[var(--glass-bg)] hover:bg-[var(--glass-hover-bg)]",
                q.disabled && "cursor-not-allowed opacity-55 hover:bg-[var(--glass-bg)]",
              )}
            >
              {applied && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              <span className="truncate">{q.label}</span>
              {q.disabled && <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><HelpCircle className="h-3 w-3" aria-hidden="true" />{q.disabled}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Days the scenario changed the most; each opens the day report. */
export function ChangedDays({ days, trader }: { days: DayChange[]; trader: string }) {
  const { t } = whatIfI18n.useT();
  if (!days.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-sm font-semibold"><CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> {t("questions.changedDays")}</p>
      <ul className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
        {days.map((d) => (
          <li key={d.day}>
            <Link
              href={`/day-report?date=${d.day}${trader ? `&trader=${encodeURIComponent(trader)}` : ""}`}
              className="flex flex-col gap-0.5 rounded-xl border border-[var(--glass-border)] px-3 py-2 tabular-nums hover:bg-[var(--glass-hover-bg)]"
              title={t("questions.openDay")}
            >
              <span className="flex items-baseline justify-between gap-2 whitespace-nowrap text-sm">
                <span className="font-medium">{fmtDate(d.day, "dayMonth")}</span>
                <span className={cn("font-semibold", d.delta > 0 ? "text-up" : "text-down")}>{fmtUsd(d.delta, { signed: true, decimals: "auto" })}</span>
              </span>
              <span className="truncate text-xs text-muted-foreground">{fmtUsd(d.before, { signed: true, decimals: "auto" })} → {d.removed ? t("questions.noTradesDay") : fmtUsd(d.after,
 { signed: true, decimals: "auto" })}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
