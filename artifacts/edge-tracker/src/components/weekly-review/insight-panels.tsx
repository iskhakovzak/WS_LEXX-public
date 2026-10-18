/**
 * Insight blocks of «Отчёт недели»: KPI strip vs the previous 4 weeks, data-driven tips with $,
 * «что получилось», the weekly goal, Mon–Fri day tiles, the curator checklist, desk comparison and
 * the days-without-review / risk block. All read-only except the goal (saved into the self-review).
 */
import * as React from "react";
import { Link } from "wouter";
import {
  AlertTriangle, ArrowUpRight, CalendarDays, CheckCircle2, ClipboardCheck, Lightbulb, MinusCircle, NotebookPen, ShieldAlert,
  Sparkles, Target, Users, XCircle,
} from "lucide-react";
import { EmptyState, ListSkeleton, Panel, Pill, StatCard, StatGrid, Tile, toneOf, toneText, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { TIP_SOURCE_LABEL, pfOf, type CheckItem, type CheckStatus, type Positive, type Tip } from "@/lib/weeklyInsights";
import { fmtDay, fmtValue, useSaveSelf, weekLabel, weekdayShort, type WeeklyReview } from "./api";
import { fmtNum, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { weeklyI18n } from "@/i18n/ns/weeklyReview";
import { personName } from "@/i18n";
import type { BenchRow, Benchmark, BenchTrend } from "./insights-api";
import type { WeekInsights } from "./use-week-insights";

const dayReportHref = (trader: string, date: string) => `/day-report?${new URLSearchParams({ trader, date }).toString()}`;

function signedDelta(d: number | null, fmt: (abs: number) => string): string | undefined {
  if (d == null || !Number.isFinite(d) || Math.abs(d) < 1e-9) return undefined;
  return `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}`;
}

export const VERDICT_LABEL: Record<BenchTrend["verdict"], string> = {
  get better() { return weeklyI18n.t("panels.verdict.better"); },
  get worse() { return weeklyI18n.t("panels.verdict.worse"); },
  get flat() { return weeklyI18n.t("panels.verdict.flat"); },
  get nodata() { return weeklyI18n.t("panels.verdict.nodata"); },
};
export const VERDICT_TONE: Record<BenchTrend["verdict"], Tone> = { better: "up", worse: "down", flat: "neutral", nodata: "neutral" };

// ── KPI strip ────────────────────────────────────────────────────────────────
export function WeekKpiStrip({ doc, ins }: { doc: WeeklyReview; ins: WeekInsights }) {
  const { t } = weeklyI18n.useT();
  const { current: k, avg4, avg4Weeks } = doc.kpis;
  const money = k.unit === "usd";
  const has4 = avg4Weeks > 0;
  const spark = ins.trend?.weeks.map((w) => w.net) ?? undefined;
  const net = money ? k.netPnl : k.totalR;
  const netAvg = money ? avg4.netPnl : avg4.totalR;
  const netDelta = has4 && net != null && netAvg != null ? net - netAvg : null;
  const wrDelta = has4 && k.winRate != null && avg4.winRate != null ? k.winRate - avg4.winRate : null;
  const pf = pfOf(k);
  const pfAvg = pfOf(avg4);
  const pfDelta = has4 && pf != null && pfAvg != null ? pf - pfAvg : null;
  const fs = ins.feeShare;
  const fsDelta = has4 && fs != null && ins.avgFeeShare != null ? fs - ins.avgFeeShare : null;
  const disc = ins.discipline;
  const discDelta = disc.current != null && disc.prevAvg != null ? disc.current - disc.prevAvg : null;
  const avgLabel = has4 ? t("panels.avgWeeks", { count: avg4Weeks }) : t("panels.noHistory");
  return (
    <StatGrid cols={5}>
      <StatCard
        label={money ? t("panels.netWeek") : t("panels.resultR")}
        term={money ? "net" : "r"}
        value={money ? fmtUsd(k.netPnl, { signed: true, decimals: "auto" }) : fmtR(k.totalR)}
        tone={toneOf(net)}
        delta={signedDelta(netDelta, (d) => (money ? fmtUsd(d, { decimals: "auto" }) : fmtR(d, { signed: false })))}
        deltaTone={toneOf(netDelta)}
        hint={`${avgLabel}: ${has4 ? fmtValue(netAvg, k.unit) : "—"}`}
        spark={spark && spark.filter((v) => v != null).length > 1 ? spark : undefined}
      />
      <StatCard
        label="Win rate"
        term="winrate"
        value={fmtRate(k.winRate)}
        tone={k.winRate == null ? "neutral" : k.winRate >= 0.5 ? "up" : "down"}
        delta={signedDelta(wrDelta, (d) => t("panels.pp", { value: Math.round(d * 100) }))}
        deltaTone={toneOf(wrDelta)}
        hint={`${k.wins}W · ${k.losses}L · ${avgLabel} ${has4 ? fmtRate(avg4.winRate) : ""}`.trim()}
      />
      <StatCard
        label="Profit factor"
        term="pf"
        value={fmtNum(pf, { suffix: "×" })}
        tone={pf == null ? "neutral" : pf >= 1 ? "up" : "down"}
        delta={signedDelta(pfDelta, (d) => d.toFixed(2))}
        deltaTone={toneOf(pfDelta)}
        hint={pf == null ? t("panels.noPf") : `${avgLabel}: ${fmtNum(pfAvg, { suffix: "×" })}`}
      />
      <StatCard
        label={t("panels.feesGross")}
        term="fees"
        value={fs != null ? fmtRate(fs) : fmtUsd(k.fees, { decimals: "auto" })}
        tone={fs == null ? "neutral" : fs > 0.4 ? "down" : fs > 0.25 ? "warn" : "neutral"}
        delta={signedDelta(fsDelta, (d) => t("panels.pp", { value: Math.round(d * 100) }))}
        deltaTone={fsDelta == null ? undefined : fsDelta > 0 ? "down" : "up"}
        hint={fs != null ? t("panels.feesAmount", { value: fmtUsd(k.fees, { decimals: "auto" }) }) : k.trades ? t("panels.grossNeg") : t("panels.noTrades")}
      />
      <StatCard
        label={t("panels.discipline")}
        value={disc.current != null ? `${Math.round(disc.current)}/100` : doc.discipline.avgDiscipline != null ? `${doc.discipline.avgDiscipline}/5` : "—"}
        tone={disc.current == null ? "neutral" : disc.current >= 80 ? "up" : disc.current >= 60 ? "warn" : "down"}
        delta={signedDelta(discDelta, (d) => String(Math.round(d)))}
        deltaTone={toneOf(discDelta)}
        hint={disc.current != null ? (disc.prevAvg != null ? `${t("panels.avgWeeks", { count: disc.prevWeeks })}: ${Math.round(disc.prevAvg)}` : t("panels.behaviorIndex")) : t("panels.fromJournal")}
      />
    </StatGrid>
  );
}

// ── Tips ─────────────────────────────────────────────────────────────────────
export function TipsPanel({
  tips, loading, onMakeGoal, title: titleProp, description: descriptionProp, compact = false, className,
}: {
  tips: Tip[];
  loading: boolean;
  onMakeGoal?: (t: Tip) => void;
  title?: string;
  description?: string;
  compact?: boolean;
  className?: string;
}) {
  const { t } = weeklyI18n.useT();
  const title = titleProp ?? t("panels.tipsTitle");
  const description = descriptionProp ?? t("panels.tipsDesc");
  return (
    <Panel title={title} description={description} icon={Lightbulb} fill className={cn("min-w-0", className)}>
      {loading && tips.length === 0 ? (
        <ListSkeleton rows={3} />
      ) : tips.length === 0 ? (
        <EmptyState compact icon={CheckCircle2} title={t("panels.noLeaks")} description={t("panels.noLeaksDesc")} />
      ) : (
        <ol className="flex flex-col gap-2">
          {tips.map((tip, i) => (
            <li key={tip.id}>
              <Tile className="flex gap-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary tabular-nums" aria-hidden="true">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className={cn("text-sm font-semibold", tip.amount != null && tip.amount < 0 ? "text-down" : tip.amount != null && tip.amount > 0 ? "text-up" : "text-foreground")}>{tip.title}</p>
                    <Pill tone="neutral">{TIP_SOURCE_LABEL[tip.source]}</Pill>
                  </div>
                  {!compact && <p className="mt-0.5 text-xs text-muted-foreground">{tip.evidence}</p>}
                  <p className="mt-1 flex items-start gap-1.5 text-sm text-foreground">
                    <Target className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                    <span>{tip.action}</span>
                  </p>
                  {(tip.href || onMakeGoal) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs" data-print-hide>
                      {onMakeGoal && (
                        <button type="button" onClick={() => onMakeGoal(tip)} className="font-medium text-primary hover:underline">{t("panels.makeGoal")}</button>
                      )}
                      {tip.href && (
                        <Link href={tip.href} className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground">
                          {t("panels.review")} <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              </Tile>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

// ── What went well ───────────────────────────────────────────────────────────
export function PositivesPanel({ items, className }: { items: Positive[]; className?: string }) {
  const { t } = weeklyI18n.useT();
  return (
    <Panel title={t("panels.positives")} icon={Sparkles} className={cn("min-w-0", className)}>
      {items.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("panels.noPositives")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((p) => (
            <li key={p.id} className="flex items-start gap-2 text-sm text-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden="true" />
              <span>{p.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Goal for next week (saved into the self-review «фокус») ───────────────────
export function GoalPanel({ doc, inject, className }: { doc: WeeklyReview; inject?: { text: string; n: number } | null; className?: string }) {
  const { t } = weeklyI18n.useT();
  const s = doc.review?.selfReview ?? {};
  const editable = doc.viewer.isOwner;
  const [focus, setFocus] = React.useState(s.focus ?? "");
  const [dirty, setDirty] = React.useState(false);
  const save = useSaveSelf();
  const key = `${doc.trader}:${doc.week.key}:${s.updatedAt ?? ""}`;
  const lastKey = React.useRef(key);
  React.useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    if (!dirty) setFocus(s.focus ?? "");
  }, [key, dirty, s.focus]);
  const lastInject = React.useRef(0);
  React.useEffect(() => {
    if (!inject || inject.n === lastInject.current) return;
    lastInject.current = inject.n;
    setFocus((f) => (f.includes(inject.text) ? f : f.trim() ? `${f.trim()}\n${inject.text}` : inject.text));
    setDirty(true);
  }, [inject]);

  const curatorGoals = doc.review?.goals ?? [];
  const onSave = () => {
    save.mutate(
      { week: doc.week.key, well: s.well ?? "", badly: s.badly ?? "", lessons: s.lessons ?? "", focus, mood: s.mood ?? null, submit: false },
      {
        onSuccess: () => { setDirty(false); toast({ title: t("panels.goalSaved"), description: t("panels.goalSavedDesc") }); },
        onError: (e) => toast({ title: t("panels.goalFailed"), description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
      },
    );
  };

  return (
    <Panel title={t("panels.goalTitle")} description={editable ? t("panels.goalDesc") : t("panels.goalDescRead")} icon={Target} className={cn("min-w-0", className)}>
      {editable ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={focus}
            onChange={(e) => { setFocus(e.target.value); setDirty(true); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && dirty && !save.isPending) { e.preventDefault(); onSave(); } }}
            rows={3}
            maxLength={6000}
            aria-label={t("panels.goalTitle")}
            placeholder={t("panels.goalPlaceholder")}
          />
          <div className="flex flex-wrap items-center gap-2" data-print-hide>
            <Button type="button" size="sm" onClick={onSave} disabled={save.isPending || !dirty}>{t("panels.saveGoal")}</Button>
            {dirty && <span className="text-xs text-muted-foreground">{t("panels.unsaved")}</span>}
          </div>
        </div>
      ) : s.focus ? (
        <p className="whitespace-pre-wrap text-sm text-foreground">{s.focus}</p>
      ) : (
        <p className="py-1 text-sm text-muted-foreground">{t("panels.noGoal")}</p>
      )}
      {curatorGoals.length > 0 && (
        <div className="mt-3 border-t border-[var(--glass-border)] pt-3">
          <p className="micro-label mb-1 text-primary">{doc.review?.curatorReview.by ? t("panels.fromCuratorBy", { name: personName(doc.review.curatorReview.by) }) : t("panels.fromCurator")}</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">{curatorGoals.map((g) => <li key={g.id}>{g.text}</li>)}</ol>
        </div>
      )}
    </Panel>
  );
}

// ── Mon–Fri tiles ────────────────────────────────────────────────────────────
export function DayStrip({ doc, ins, className }: { doc: WeeklyReview; ins: WeekInsights; className?: string }) {
  const { t } = weeklyI18n.useT();
  const u = doc.kpis.current.unit;
  const journal = new Map(doc.discipline.days.map((d) => [d.date, d]));
  return (
    <Panel title={t("panels.byDay")} description={t("panels.byDayDesc")} icon={CalendarDays} className={cn("min-w-0", className)}>
      <ul className="grid grid-cols-5 gap-2">
        {doc.days.map((d) => {
          const v = u === "usd" ? d.net : d.r;
          const j = journal.get(d.date);
          const leak = ins.dayLeaks.get(d.date);
          const traded = d.trades > 0;
          const body = (
            <>
              <div className="flex items-center justify-between gap-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{weekdayShort(d.date)}</span>
                <span className="tabular-nums">{fmtDay(d.date)}</span>
              </div>
              <p className={cn("mt-1 text-lg font-semibold tabular-nums", !traded || v == null ? "text-muted-foreground" : v >= 0 ? "text-up" : "text-down")}>
                {traded ? fmtValue(v, u) : "—"}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">{traded ? t("panels.dayTrades", { trades: commonI18n.t("units.tradesShort", { count: d.trades }), wins: d.wins, losses: d.losses }) : t("panels.noDayTrades")}</p>
              {leak != null && <p className="mt-1 text-xs text-down tabular-nums">{t("panels.leaks", { value: fmtUsd(-leak, { decimals: "auto" }) })}</p>}
              {traded && (
                <p className={cn("mt-1 flex items-center gap-1 text-xs", j?.hasReview ? "text-up" : "text-muted-foreground")}>
                  <NotebookPen className="h-3 w-3" aria-hidden="true" /> {j?.hasReview ? t("panels.reviewed") : j ? t("panels.notReviewed") : t("panels.noEntry")}
                </p>
              )}
            </>
          );
          return (
            <li key={d.date} className="min-w-0">
              {traded ? (
                <Link href={dayReportHref(doc.trader, d.date)} className="tile tile-interactive press block h-full min-w-0 p-3" aria-label={t("panels.dayReview", { date: fmtDay(d.date, true) })}>
                  {body}
                </Link>
              ) : (
                <div className="tile h-full min-w-0 p-3 opacity-60">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ── Curator checklist ────────────────────────────────────────────────────────
const CHECK_ICON: Record<CheckStatus, { icon: typeof CheckCircle2; tone: Tone }> = {
  ok: { icon: CheckCircle2, tone: "up" },
  warn: { icon: AlertTriangle, tone: "warn" },
  fail: { icon: XCircle, tone: "down" },
  na: { icon: MinusCircle, tone: "neutral" },
};

export function ChecklistPanel({ items, className }: { items: CheckItem[]; className?: string }) {
  const { t } = weeklyI18n.useT();
  const ok = items.filter((i) => i.status === "ok").length;
  const bad = items.filter((i) => i.status === "fail").length;
  return (
    <Panel
      title={t("panels.checklistTitle")}
      description={bad ? t("panels.checklistDescFail", { ok, total: items.length, count: bad }) : t("panels.checklistDesc", { ok, total: items.length })}
      icon={ClipboardCheck}
      fill
      className={cn("min-w-0", className)}
    >
      <ul className="divide-y divide-border/50">
        {items.map((it) => {
          const meta = CHECK_ICON[it.status];
          const Icon = meta.icon;
          const row = (
            <>
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", it.status === "na" ? "text-muted-foreground" : toneText(meta.tone))} aria-label={t(`panels.check.${it.status}`)} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{it.label}</p>
                <p className="text-xs text-muted-foreground">{it.detail}</p>
              </div>
              {it.amount != null && it.amount !== 0 && <span className={cn("shrink-0 text-sm font-semibold tabular-nums", it.amount < 0 ? "text-down" : "text-up")}>{fmtUsd(it.amount, { signed: true, decimals: "auto" })}</span>}
              {it.href && <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
            </>
          );
          return (
            <li key={it.id}>
              {it.href ? (
                <Link href={it.href} className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--tile-hover-bg)]">{row}</Link>
              ) : (
                <div className="flex items-start gap-3 py-2">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ── Desk comparison (benchmark row vs desk median) ───────────────────────────
type CmpMetric = { key: keyof BenchRow & string; readonly label: string; better: "higher" | "lower"; fmt: (v: number) => string };
const W = (k: Parameters<typeof weeklyI18n.t>[0]) => weeklyI18n.t(k);
const CMP_METRICS: CmpMetric[] = [
  { key: "net", get label() { return W("panels.cmp.net"); }, better: "higher", fmt: (v) => fmtUsd(v, { signed: true, decimals: "auto" }) },
  { key: "winRate", label: "Win rate", better: "higher", fmt: (v) => fmtRate(v) },
  { key: "profitFactor", label: "Profit factor", better: "higher", fmt: (v) => fmtNum(v, { suffix: "×" }) },
  { key: "expectancy", get label() { return W("panels.cmp.expectancy"); }, better: "higher", fmt: (v) => fmtUsd(v, { signed: true, decimals: "auto" }) },
  { key: "feeShare", get label() { return W("panels.cmp.feeShare"); }, better: "lower", fmt: (v) => fmtRate(v) },
  { key: "tradesPerDay", get label() { return W("panels.cmp.tradesPerDay"); }, better: "lower", fmt: (v) => v.toFixed(1) },
  { key: "avgHoldMin", get label() { return W("panels.cmp.avgHold"); }, better: "higher", fmt: (v) => commonI18n.t("time.minutesShort", { count: Number(v.toFixed(1)) }) },
  { key: "maxDd", get label() { return W("panels.cmp.maxDd"); }, better: "lower", fmt: (v) => fmtUsd(v, { decimals: "auto" }) },
];

export function DeskComparePanel({ bench, row, trend, loading, className }: { bench: Benchmark | null; row: BenchRow | null; trend: BenchTrend | null; loading: boolean; className?: string }) {
  const { t } = weeklyI18n.useT();
  const median = bench?.median ?? {};
  const hasMedian = (bench?.deskSize ?? 0) >= 3 && Object.values(median).some((v) => v != null);
  const badges = row?.badges ?? [];
  return (
    <Panel
      title={t("panels.deskTitle")}
      description={hasMedian ? t("panels.deskDesc", { count: bench?.deskSize ?? 0 }) : t("panels.deskDescNone")}
      icon={Users}
      fill
      className={cn("min-w-0", className)}
      actions={<Link href="/benchmark" className="text-xs text-primary hover:underline" data-print-hide>{t("panels.benchmarkLink")}</Link>}
    >
      {loading ? (
        <ListSkeleton rows={4} dense />
      ) : !row ? (
        <EmptyState compact icon={Users} title={t("panels.noBench")} description={t("panels.noBenchDesc")} />
      ) : (
        <div className="flex flex-col gap-3">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="py-1 text-left font-medium">{t("panels.metric")}</th>
                <th className="py-1 text-right font-medium">{t("panels.trader")}</th>
                {hasMedian && <th className="py-1 text-right font-medium">{t("panels.median")}</th>}
              </tr>
            </thead>
            <tbody>
              {CMP_METRICS.map((m) => {
                const v = row[m.key] as number | null | undefined;
                const med = median[m.key] ?? null;
                const tone: Tone = !hasMedian || v == null || med == null || v === med ? "neutral" : (m.better === "higher" ? v > med : v < med) ? "up" : "down";
                if (v == null && med == null) return null;
                return (
                  <tr key={m.key} className="border-t border-border/40">
                    <td className="py-1.5 text-muted-foreground">{m.label}</td>
                    <td className={cn("py-1.5 text-right font-medium", tone === "neutral" ? "text-foreground" : toneText(tone))}>{v != null ? m.fmt(v) : "—"}</td>
                    {hasMedian && <td className="py-1.5 text-right text-muted-foreground">{med != null ? m.fmt(med) : "—"}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(trend || badges.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {trend && <Pill tone={VERDICT_TONE[trend.verdict]} dot>{t("panels.trend4", { verdict: VERDICT_LABEL[trend.verdict] })}</Pill>}
              {badges.slice(0, 4).map((b) => (
                <Pill key={b.key} tone={b.kind === "strength" ? "up" : "warn"} className="max-w-full"><span className="truncate" title={b.detail}>{b.label}</span></Pill>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

// ── Days without review + risk events (curator) ──────────────────────────────
export function JournalRiskPanel({ doc, ins, className }: { doc: WeeklyReview; ins: WeekInsights; className?: string }) {
  const { t } = weeklyI18n.useT();
  const { limits, events, weeklyLossPct } = doc.risk;
  return (
    <Panel title={t("panels.journalRisk")} description={t("panels.journalRiskDesc")} icon={ShieldAlert} fill className={cn("min-w-0", className)}>
      <div className="flex flex-col gap-3">
        <div>
          <p className="micro-label mb-1.5">{t("panels.daysNoReview")}</p>
          {ins.daysWithoutReview.length === 0 ? (
            <p className="flex items-center gap-1.5 text-sm text-up"><CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {doc.kpis.current.tradingDays ? t("panels.allReviewed") : t("panels.noTradingDays")}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {ins.daysWithoutReview.map((d) => (
                <Link key={d} href={links.journalDay(d, doc.trader)} className="chip min-h-7 px-2.5 text-xs font-medium text-[hsl(var(--warn))]">
                  {fmtDay(d, true)}
                </Link>
              ))}
            </div>
          )}
        </div>
        <div>
          <p className="micro-label mb-1.5">{t("panels.riskEvents")}</p>
          {!limits ? (
            <p className="text-sm text-muted-foreground">{t("panels.noLimits")} <Link href={links.risk(doc.trader)} className="text-primary hover:underline">{t("panels.setLimits")}</Link>.</p>
          ) : events.length === 0 ? (
            <p className="flex items-center gap-1.5 text-sm text-up"><CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {weeklyLossPct != null ? t("panels.noBreachesPct", { pct: weeklyLossPct }) : t("panels.noBreaches")}</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {events.map((e, i) => (
                <li key={`${e.kind}-${e.date}-${i}`} className="flex items-center gap-2 py-1.5 text-sm">
                  <AlertTriangle className={cn("h-4 w-4 shrink-0", e.level === "breach" ? "text-down" : "text-[hsl(var(--warn))]")} aria-hidden="true" />
                  <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">{fmtDay(e.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground" title={e.detail}>{e.label}</span>
                  <Pill tone={e.level === "breach" ? "down" : "warn"}>{e.pct != null ? `${e.pct}%` : e.level === "breach" ? t("panels.breach") : t("panels.attention")}</Pill>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** One-line summary under the header: «8 сделок за 3 дня · 0 в плюс, 3 в минус · …». */
export function weekHeadline(doc: WeeklyReview): string {
  const t = weeklyI18n.t;
  const k = doc.kpis.current;
  if (k.trades === 0) return t("panels.headlineEmpty", { week: weekLabel(doc.week.key) });
  const parts = [t("panels.headlineTrades", { trades: commonI18n.t("units.trades", { count: k.trades }), days: commonI18n.t("units.days", { count: k.tradingDays }) })];
  if (k.greenDays || k.redDays) parts.push(t("panels.headlineGreenRed", { green: k.greenDays, red: k.redDays }));
  if (doc.violations.items.length) parts.push(commonI18n.t("units.violations", { count: doc.violations.items.length }));
  if (doc.openPositions.length) parts.push(t("panels.headlineWeekend", { count: doc.openPositions.length }));
  return parts.join(" · ");
}
