import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, CircleSlash, NotebookPen, Plus, Sparkles, X } from "lucide-react";
import { BentoGrid, EmptyState, Panel, Pill, Sparkline, StatCard, StatGrid } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { nyDate } from "@/lib/trading-date";
import { putSelfCheck, useRulePreview, useSelfChecks } from "./api";
import { DisciplineCalendar } from "./DisciplineCalendar";
import { ORIGIN_LABEL, originOf } from "./constants";
import { fmtDate, fmtRate, fmtUsd, localeTag } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { rulesI18n } from "@/i18n/ns/rules";
import { rich } from "./rich";
import { starterTemplates, type RuleDraft } from "./templates";
import type { MistakePrefill, RuleReport, RulesReportResponse, SelfMark } from "./types";

/** Most expensive first; rules without a $ estimate after; unverifiable and disabled at the end. */
function rank(r: RuleReport): number {
  if (r.status === "disabled") return 4;
  if (r.status === "no_data") return 3;
  if (!r.auto) return 2;
  return r.violations > 0 ? 0 : 1;
}

export function sortRules(rules: RuleReport[]): RuleReport[] {
  return [...rules].sort((a, b) => rank(a) - rank(b) || (a.impact ?? 0) - (b.impact ?? 0) || b.violations - a.violations || a.name.localeCompare(b.name, localeTag()));
}

function ppDelta(recent: number | null, prev: number | null): { text: string; tone: "accent" | "warn" | "neutral" } | null {
  if (recent == null || prev == null) return null;
  const d = Math.round((recent - prev) * 100);
  if (d === 0) return { text: rulesI18n.t("overview.ppSame"), tone: "neutral" };
  return { text: rulesI18n.t("overview.ppDelta", { delta: `${d > 0 ? "+" : "−"}${Math.abs(d)}` }), tone: d > 0 ? "accent" : "warn" };
}

// ─── Onboarding (0 rules) ───────────────────────────────────────────────────

export function RulesOnboarding({
  report,
  trader,
  days,
  onUseTemplate,
  onCustom,
}: {
  report: RulesReportResponse | undefined;
  trader: string;
  days: number;
  onUseTemplate: (d: RuleDraft) => void;
  onCustom: () => void;
}) {
  const { t, lang } = rulesI18n.useT();
  // Template names follow the language.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const templates = useMemo(() => starterTemplates(report?.stats), [report?.stats, lang]);
  return (
    <Panel
      title={t("onboarding.title")}
      description={t("onboarding.description", { days })}
      icon={Sparkles}
      actions={<Button variant="outline" size="sm" onClick={onCustom}><Plus /> {t("onboarding.custom")}</Button>}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {templates.map((t) => <TemplateCard key={t.kind} t={t} trader={trader} days={days} onUse={() => onUseTemplate(t)} />)}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {t("onboarding.footer")}
      </p>
    </Panel>
  );
}

function TemplateCard({ t, trader, days, onUse }: { t: RuleDraft & { why: string }; trader: string; days: number; onUse: () => void }) {
  const { t: tr } = rulesI18n.useT();
  const q = useRulePreview(trader, days, t.kind, t.threshold);
  const r = q.data;
  return (
    <button type="button" onClick={onUse} title={tr("onboarding.addTitle")} className="tile tile-interactive press group flex min-h-[132px] flex-col gap-1.5 p-3 text-left">
      <span className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{t.name}</span>
        {/* The whole card adds the rule; the icon makes that visible before hover. */}
        <Plus className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden="true" />
      </span>
      <span className="text-xs text-muted-foreground">{t.why}</span>
      <span className="mt-auto pt-1 text-xs" aria-live="polite">
        {q.isLoading ? (
          <span className="skeleton block h-4 w-3/4" aria-hidden="true" />
        ) : !r || q.error ? (
          <span className="text-muted-foreground">{tr("preview.unavailable")}</span>
        ) : r.status === "no_data" ? (
          <span className="text-muted-foreground">{tr("preview.noData")}</span>
        ) : r.violations === 0 ? (
          <span className="text-foreground">{tr("onboarding.clean")}</span>
        ) : (
          <span className="text-foreground">
            {tr("preview.violations", { count: r.violations, violated: r.violatedDays, days: r.days })}
            {r.impact != null && r.impact !== 0 && (
              <> · {rich(tr(r.impact < 0 ? "onboarding.cost" : "onboarding.gain", { amount: "{amount}" }), {
                amount: <b className={cn("tabular-nums", r.impact < 0 ? "text-down" : "text-up")}>{fmtUsd(r.impact, { decimals: "trim" })}</b>,
              })}</>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

// ─── Overview with rules ────────────────────────────────────────────────────

export function RulesOverview({
  report,
  trader,
  canMark,
  onOpenRule,
  onAddRule,
  onLogMistake,
}: {
  report: RulesReportResponse;
  trader: string;
  canMark: boolean;
  onOpenRule: (r: RuleReport) => void;
  onAddRule: () => void;
  onLogMistake: (p?: MistakePrefill) => void;
}) {
  const { t: tr } = rulesI18n.useT();
  const t = report.totals;
  const rules = useMemo(() => sortRules(report.rules), [report.rules]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const hasSelf = rules.some((r) => !r.auto && r.status !== "disabled");
  const today = nyDate();
  const selfQ = useSelfChecks(trader, today, hasSelf);
  const todayMarks = useMemo(() => new Map((selfQ.data?.marks ?? []).map((m) => [m.ruleId, m])), [selfQ.data]);

  const compDelta = ppDelta(t.recentCompliance, t.prevCompliance);
  const weeklySpark = t.weekly.map((w) => (w.compliance == null ? null : Math.round(w.compliance * 100)));
  const noTrades = t.tradingDays === 0;

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      {noTrades ? (
        <Panel>
          <EmptyState compact icon={CircleSlash} title={tr("overview.noTrades", { days: report.days })} description={tr("overview.noTradesHint")} />
        </Panel>
      ) : (
        <StatGrid min="13rem">
          <StatCard
            label={tr("overview.compliance")}
            value={fmtRate(t.compliance)}
            hint={tr("overview.cleanDaysOf", { clean: t.cleanDays, total: t.tradingDays })}
            delta={compDelta?.text}
            deltaTone={compDelta?.tone}
            spark={weeklySpark.filter((v) => v != null).length > 1 ? weeklySpark : undefined}
            sparkTone="accent"
          />
          <StatCard
            label={tr("overview.impact")}
            value={t.impact == null ? "—" : t.impact === 0 ? "$0" : fmtUsd(t.impact, { signed: true, decimals: "trim" })}
            tone={t.impact == null ? "neutral" : t.impact < 0 ? "down" : t.impact > 0 ? "up" : "neutral"}
            hint={t.impact == null ? tr("overview.impactNone") : t.impact > 0 ? tr("overview.impactLucky") : tr("overview.impactHint")}
          />
          <StatCard
            label={tr("overview.cleanStreak")}
            value={t.currentStreak}
            hint={tr("overview.bestStreak", { count: t.bestStreak })}
          />
          {t.broken.n > 0 && t.clean.n > 0 && (
            <StatCard
              label={tr("overview.brokenTrade")}
              value={fmtUsd(t.broken.avg, { signed: true, decimals: "trim" })}
              tone={t.broken.avg == null ? "neutral" : t.broken.avg < 0 ? "down" : "up"}
              hint={tr("overview.cleanAvg", { amount: fmtUsd(t.clean.avg, { signed: true, decimals: "trim" }) })}
            />
          )}
        </StatGrid>
      )}

      <BentoGrid>
        <Panel
          className="lg:col-span-8"
          fill
          title={tr("overview.rulesTitle")}
          description={tr("overview.rulesDesc")}
          actions={<Button variant="ghost" size="sm" onClick={onAddRule}><Plus /> {commonI18n.t("actions.add")}</Button>}
          padded={false}
        >
          <ul className="flex flex-col px-2 pb-2" aria-label={tr("overview.rulesAria")}>
            {rules.map((r) => (
              <RuleRow
                key={r.id}
                r={r}
                trader={trader}
                today={today}
                mark={todayMarks.get(r.id)}
                canMark={canMark}
                onOpen={() => onOpenRule(r)}
              />
            ))}
          </ul>
        </Panel>

        <Panel
          className="lg:col-span-4"
          fill
          title={tr("overview.calendarTitle")}
          description={noTrades ? undefined : tr("overview.calendarDesc", { clean: t.cleanDays, total: t.tradingDays })}
        >
          <DisciplineCalendar calendar={report.calendar} from={report.from} to={report.to} selected={selectedDay} onSelect={setSelectedDay} />
          <DayDetail day={selectedDay} report={report} trader={trader} onLogMistake={onLogMistake} />
        </Panel>
      </BentoGrid>
    </div>
  );
}

function RuleRow({
  r,
  trader,
  today,
  mark,
  canMark,
  onOpen,
}: {
  r: RuleReport;
  trader: string;
  today: string;
  mark: SelfMark | undefined;
  canMark: boolean;
  onOpen: () => void;
}) {
  const { t } = rulesI18n.useT();
  const origin = originOf(r);
  const o = ORIGIN_LABEL[origin];
  const spark = r.weekly.map((w) => (w.compliance == null ? null : Math.round(w.compliance * 100)));
  const muted = r.status === "disabled" || r.status === "no_data";
  // Self-assessed rules: average day «нарушил» minus average day «соблюдал» (net $).
  const selfGap = !r.auto && r.status !== "disabled" && r.broken.n > 0 && r.broken.avg != null && r.clean.avg != null ? r.broken.avg - r.clean.avg : null;
  const status =
    r.status === "disabled" ? t("row.disabled")
    : r.status === "no_data" ? t("row.noData")
    : !r.auto ? (r.unmarkedDays > 0 ? t("row.selfUnmarked", { count: r.unmarkedDays }) : t("row.self"))
    : r.violations === 0 ? t("row.clean", { days: r.days })
    : [t("preview.violations", { count: r.violations, violated: r.violatedDays, days: r.days }), r.lastViolation ? t("preview.last", { date: fmtDate(r.lastViolation, "dayMonth") }) : null].filter(Boolean).join(" · ");
  return (
    <li className={cn("flex min-h-[60px] items-center gap-3 rounded-xl px-2 py-2 transition-colors duration-[var(--dur-1)] hover:bg-[var(--glass-hover-bg)]", muted && "opacity-70")}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground" title={r.name}>{r.name}</span>
            {origin !== "personal" && <Pill tone={o.tone} title={o.hint}>{o.label}</Pill>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={status}>
            {status}
          </span>
        </span>

        {r.status !== "disabled" && r.status !== "no_data" && (
          <span className="hidden w-[132px] shrink-0 items-center gap-2 sm:flex">
            <Sparkline data={spark} tone="accent" width={64} height={22} fill={false} ariaLabel={t("row.sparkAria")} />
            <span className={cn("w-10 text-right text-sm font-medium tabular-nums", r.compliance != null && r.compliance < 0.7 ? "text-warn" : "text-foreground")}>
              {fmtRate(r.compliance)}
            </span>
          </span>
        )}

        <span className="w-[120px] shrink-0 text-right">
          {r.auto && r.status === "checked" && r.impact != null && r.impact !== 0 ? (
            <>
              <span className={cn("block text-sm font-semibold tabular-nums", r.impact < 0 ? "text-down" : "text-up")}>{fmtUsd(r.impact, { signed: true, decimals: "trim" })}</span>
              <span className="block text-xs text-muted-foreground">{r.impact < 0 ? t("row.costsYou") : t("row.paidOff")}</span>
            </>
          ) : selfGap != null ? (
            <>
              <span className={cn("block text-sm font-semibold tabular-nums", selfGap < 0 ? "text-down" : "text-up")}>{fmtUsd(selfGap, { signed: true, decimals: "trim" })}</span>
              <span className="block text-xs text-muted-foreground">{t("row.perDay")}</span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </span>
      </button>

      {!r.auto && r.status !== "disabled" && canMark && <SelfMarkButtons ruleId={r.id} trader={trader} day={today} mark={mark} />}
    </li>
  );
}

/** Today's «соблюдал / нарушил» for a self-assessed rule (same data the journal checklist writes). */
export function SelfMarkButtons({ ruleId, trader, day, mark, size = "sm" }: { ruleId: number; trader: string; day: string; mark: SelfMark | undefined; size?: "sm" | "md" }) {
  const { t } = rulesI18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const ok = mark?.ok ?? null;
  async function set(v: boolean) {
    const next = ok === v ? null : v;
    setBusy(true);
    try {
      await putSelfCheck({ trader, day, ruleId, ok: next });
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "rules" && q.queryKey[1] !== "kinds" });
    } catch (e) {
      toast({ title: t("self.saveFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  const cls = size === "sm" ? "h-8 px-2 text-xs" : "h-9 px-3 text-sm";
  return (
    <div role="group" aria-label={t("self.todayAria", { date: fmtDate(day, "dayMonth") })} className="flex shrink-0 items-center gap-1" title={t("self.title")}>
      <button
        type="button"
        disabled={busy}
        aria-pressed={ok === true}
        onClick={() => set(true)}
        className={cn("inline-flex items-center gap-1 rounded-lg border font-medium transition-colors duration-[var(--dur-1)] disabled:opacity-50", cls,
          ok === true ? "border-transparent bg-primary-solid text-primary-foreground" : "border-[var(--field-border)] text-muted-foreground hover:text-foreground")}
      >
        <Check className="h-3.5 w-3.5" aria-hidden="true" />{t("self.kept")}
      </button>
      <button
        type="button"
        disabled={busy}
        aria-pressed={ok === false}
        onClick={() => set(false)}
        className={cn("inline-flex items-center gap-1 rounded-lg border font-medium transition-colors duration-[var(--dur-1)] disabled:opacity-50", cls,
          ok === false ? "border-transparent bg-warn text-background" : "border-[var(--field-border)] text-muted-foreground hover:text-foreground")}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />{t("self.broke")}
      </button>
    </div>
  );
}

function DayDetail({ day, report, trader, onLogMistake }: { day: string | null; report: RulesReportResponse; trader: string; onLogMistake: (p?: MistakePrefill) => void }) {
  const { t } = rulesI18n.useT();
  const c = day ? report.calendar.find((x) => x.day === day) : undefined;
  if (!day || !c) {
    return <p className="mt-3 text-xs text-muted-foreground">{t("day.hint")}</p>;
  }
  const names = c.ruleIds.map((id) => report.rules.find((r) => r.id === id)?.name).filter(Boolean) as string[];
  return (
    <div className="tile mt-3 flex flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{fmtDate(day, "dayMonth")}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {commonI18n.t("units.tradesShort", { count: c.trades })} · <span className={cn("font-medium", c.net < 0 ? "text-down" : c.net > 0 ? "text-up" : "text-foreground")}>{fmtUsd(c.net, { signed: true, decimals: "trim" })}</span>
        </span>
      </div>
      {names.length ? (
        <ul className="flex flex-col gap-1 text-xs text-foreground">
          {names.map((n) => <li key={n} className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />{n}</li>)}
        </ul>
      ) : (
        <span className="text-xs text-muted-foreground">{t("day.allKept")}</span>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
        <Link href={links.dayReport(day, trader)} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          {t("day.dayReport")} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
        {!c.clean && (
          <button type="button" onClick={() => onLogMistake({ description: `${fmtDate(day, "dayMonth")}: ${names.join(", ")}` })} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            <NotebookPen className="h-3.5 w-3.5" aria-hidden="true" /> {t("day.logLesson")}
          </button>
        )}
      </div>
    </div>
  );
}

