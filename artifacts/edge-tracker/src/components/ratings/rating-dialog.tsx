import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, Crosshair, Star, Wand2 } from "lucide-react";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pill, StatRow, toneOf } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { VoiceRecorder } from "@/components/voice-recorder";
import { fmtNum, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import {
  CRITERIA, OVERALL, TIER_CODES, avgScores, isLadderTier, shiftWeek, tierLabel, weekLabel, weekOf,
  type CriterionKey, type Rating, type RatingEvidence, type ScoreKey,
} from "./scorecard-model";
import { PersonSelect } from "@/components/people/person-select";
import { ratingsI18n } from "@/i18n/ns/ratings";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";

type Form = Record<ScoreKey, number> & { trader: string; week: string; comment: string; focus: string; tier: string };

const blank = (trader: string, week: string): Form => ({
  trader, week,
  discipline: 5, riskManagement: 5, execution: 5, journaling: 5, improvement: 5, overall: 5,
  comment: "", focus: "", tier: "",
});


/** The week's facts the rubric is scored against — pulled from trades, journal, ideas and the risk desk. */
function EvidencePanel({ trader, week, evidence, loading }: { trader: string; week: string; evidence: RatingEvidence | null; loading: boolean }) {
  const { t: tr } = ratingsI18n.useT();
  if (!trader) return null;
  if (loading) return <Skeleton className="h-28 rounded-xl" />;
  if (!evidence) return <p className="text-xs text-muted-foreground">{tr("dialog.noFacts")}</p>;
  const t = evidence.trades;
  return (
    <div className="rounded-xl bg-[var(--glass-bg)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{tr("dialog.facts")}</span>
        <span>{weekLabel(week)}</span>
        {evidence.risk.tier && <Pill tone="purple">{tierLabel(evidence.risk.tier)}</Pill>}
        <span className="ml-auto flex gap-2">
          <Link href={links.risk(trader)} className="text-primary hover:underline">{tr("dialog.risk")}</Link>
          <Link href={links.scaling(trader)} className="text-primary hover:underline">{tr("dialog.scaling")}</Link>
          <Link href={links.weeklyReview({ trader, week })} className="text-primary hover:underline">{tr("dialog.weeklyReview")}</Link>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <StatRow label={tr("dialog.tradesWlb")} value={t.trades ? `${t.trades} (${t.wins}/${t.losses}/${t.be})` : "0"} />
        <StatRow label="Win rate" value={fmtRate(t.winRate)} tone={t.winRate == null ? "neutral" : t.winRate >= 0.5 ? "up" : "down"} />
        <StatRow label={tr("dialog.sumAvgR")} value={`${fmtR(t.totalR, 1)} / ${fmtR(t.avgR)}`} tone={toneOf(t.totalR)} />
        <StatRow label={tr("dialog.netPnl")} value={fmtUsd(t.net, { decimals: 0 })} tone={toneOf(t.net)} />
        <StatRow label={tr("dialog.worstDay")} value={fmtUsd(evidence.worstDayNet, { decimals: 0 })} tone={toneOf(evidence.worstDayNet)} />
        <StatRow label={tr("dialog.maxLossR")} value={fmtR(t.maxLossR)} tone={t.maxLossR != null && t.maxLossR < -1.5 ? "down" : "neutral"} />
        <StatRow label={tr("dialog.journal")} value={`${evidence.journal.days} / ${fmtRate(evidence.journal.planFollowedPct)}`} />
        <StatRow label={tr("dialog.ideas")} value={`${evidence.ideas.published} / ${evidence.ideas.converted}`} />
        <StatRow label={tr("dialog.tradeNotes")} value={fmtRate(t.tradesWithNotesPct)} />
        <StatRow label={tr("dialog.vsLastWeek")} value={evidence.netDelta == null ? "—" : fmtUsd(evidence.netDelta, { decimals: 0 })} tone={toneOf(evidence.netDelta)} />
      </div>
      {evidence.breaches.length > 0 && (
        <ul className="mt-2 space-y-1">
          {evidence.breaches.map((b) => (
            <li key={b} className="flex items-center gap-1.5 text-xs text-down"><AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />{b}</li>
          ))}
        </ul>
      )}
      {evidence.prevFocus && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Crosshair className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{tr("dialog.prevFocus")} <span className="text-foreground">{evidence.prevFocus}</span></span>
        </p>
      )}
    </div>
  );
}

/** 1..10 picker as a radiogroup of compact buttons (keyboard: ←/→). */
function ScorePicker({ id, label, hint, value, prev, onChange, icon: Icon }: {
  id: string; label: string; hint?: string; value: number; prev?: number | null;
  onChange: (v: number) => void; icon: React.ElementType;
}) {
  const { t } = ratingsI18n.useT();
  const tone = (n: number) => (n >= 8 ? "bg-up text-primary-foreground" : n >= 5 ? "bg-[hsl(var(--chart-3))] text-primary-foreground" : "bg-down text-primary-foreground");
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span id={`${id}-label`} className="text-sm font-medium text-foreground">{label}</span>
        {hint && <span className="hidden truncate text-xs text-muted-foreground sm:inline">· {hint}</span>}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
          {prev != null && <span title={t("dialog.lastWeekTitle")}>{t("dialog.was", { value: fmtNum(prev, 1) })}</span>}
          <span className="text-sm font-semibold text-foreground">{value}</span>
        </span>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        className="flex gap-0.5"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); onChange(Math.min(10, value + 1)); }
          if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); onChange(Math.max(1, value - 1)); }
        }}
      >
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
          const active = n === value;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={t("dialog.ofTen", { n })}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(n)}
              className={cn(
                "h-8 min-w-0 flex-1 rounded-full text-xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? tone(n) : n <= value ? "bg-[var(--glass-hover-bg)] text-foreground" : "text-muted-foreground hover:bg-[var(--glass-hover-bg)]",
              )}
            >
              {n}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function RatingDialog({
  open, onOpenChange, traders, ratings, me, initialTrader, editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  traders: string[];
  /** all ratings (to detect existing rating for trader+week and show last week's scores) */
  ratings: Rating[];
  me: string | null;
  initialTrader?: string;
  editing?: Rating | null;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = ratingsI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [form, setForm] = useState<Form>(() => blank("", weekOf()));
  const [overallTouched, setOverallTouched] = useState(false);
  const traderOptions = useMemo(() => traders.map((n) => ({ value: n, label: personName(n) })), [traders]);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        trader: editing.trader, week: editing.week, comment: editing.comment ?? "",
        focus: editing.focus ?? "", tier: editing.tier ?? "",
        discipline: editing.discipline, riskManagement: editing.riskManagement, execution: editing.execution,
        journaling: editing.journaling, improvement: editing.improvement, overall: editing.overall,
      });
      setOverallTouched(true);
    } else {
      setForm(blank(initialTrader || traders[0] || "", weekOf()));
      setOverallTouched(false);
    }
    // Reset only when the dialog opens / target changes — not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id, initialTrader]);

  // Suggested overall = mean of criteria, until the curator sets it by hand.
  const suggested = Math.round(avgScores([form]).composite);
  useEffect(() => {
    if (!overallTouched) setForm((f) => (f.overall === suggested ? f : { ...f, overall: suggested }));
  }, [suggested, overallTouched]);

  const existing = useMemo(
    () => (editing ? null : ratings.find((r) => r.trader === form.trader && r.week === form.week && r.curator === me) ?? null),
    [editing, ratings, form.trader, form.week, me],
  );
  const lastWeek = useMemo(() => {
    const prevWeek = shiftWeek(form.week, -1);
    const list = ratings.filter((r) => r.trader === form.trader && r.week === prevWeek);
    return list.length ? avgScores(list) : null;
  }, [ratings, form.trader, form.week]);

  // Facts for the rubric (trades via shared trade math, journal, ideas, risk tier) for the chosen trader + week.
  const weekValid = /^\d{4}-\d{2}-\d{2}$/.test(form.week);
  const evidenceQ = useQuery<RatingEvidence>({
    queryKey: ["ratings", "evidence", form.trader, form.week],
    queryFn: ({ signal }) => http.get<RatingEvidence>("/api/ratings/evidence", { query: { trader: form.trader, week: form.week }, signal }),
    enabled: open && !!form.trader && weekValid,
    staleTime: STALE.short,
    retry: 0,
  });
  // The desk's risk tier pre-fills the rating's tier (staff change the desk tier itself on /risk).
  useEffect(() => {
    const tier = evidenceQ.data?.risk.tier;
    if (tier && !editing) setForm((f) => (f.tier ? f : { ...f, tier }));
  }, [evidenceQ.data?.risk.tier, editing]);

  const save = useMutation({
    mutationFn: async () => {
      const ev = evidenceQ.data;
      const payload = {
        discipline: form.discipline, riskManagement: form.riskManagement, execution: form.execution,
        journaling: form.journaling, improvement: form.improvement, overall: form.overall,
        comment: form.comment, focus: form.focus.trim() || null, tier: form.tier || null,
        // Snapshot of the facts the score was based on — shown to the trader with the rating.
        evidence: ev ? { trades: ev.trades, worstDayNet: ev.worstDayNet, journal: ev.journal, ideas: ev.ideas, breaches: ev.breaches, netDelta: ev.netDelta } : undefined,
      };
      return editing
        ? http.patch<Rating & { updated?: boolean }>(`/api/ratings/${editing.id}`, payload)
        : http.post<Rating & { updated?: boolean }>("/api/ratings", { ...payload, trader: form.trader, week: form.week });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["ratings"] });
      onOpenChange(false);
      toast({ title: ratingsI18n.t(editing || res?.updated ? "dialog.updated" : "dialog.saved"), description: `${personName(form.trader)} · ${weekLabel(form.week)}` });
    },
    onError: (e: Error) => toast({ title: ratingsI18n.t("dialog.saveError"), description: humanizeApiError(e, ratingsI18n.t("dialog.saveFailed")), variant: "destructive" }),
  });

  const canSave = !!form.trader && weekValid && !save.isPending;
  const thisWeek = weekOf();
  const criterionEvidence = (key: CriterionKey): string | undefined => {
    const ev = evidenceQ.data;
    if (!ev) return undefined;
    const tr = ev.trades;
    switch (key) {
      case "discipline": return t("dialog.evDiscipline", { plan: fmtRate(ev.journal.planFollowedPct), days: ev.journal.days, maxLoss: fmtR(tr.maxLossR) });
      case "riskManagement": return `${t("dialog.evRisk", { worst: fmtUsd(ev.worstDayNet, { decimals: 0 }), avgRisk: fmtUsd(tr.avgRiskUsd, { decimals: 0 }) })}${ev.breaches.length ? ` · ${t("dialog.evBreaches", { count: ev.breaches.length })}` : ""}`;
      case "execution": return t("dialog.evExecution", { winRate: fmtRate(tr.winRate), avgR: fmtR(tr.avgR), pf: fmtNum(tr.profitFactor) });
      case "journaling": return t("dialog.evJournaling", { days: ev.journal.days, notes: fmtRate(tr.tradesWithNotesPct), ideas: ev.ideas.published });
      case "improvement": return `${t("dialog.evImprovement", { delta: ev.netDelta == null ? "—" : fmtUsd(ev.netDelta, { decimals: 0 }) })}${ev.prevFocus ? ` · ${t("dialog.evFocus", { focus: ev.prevFocus })}` : ""}`;
    }
  };
  const set = (k: ScoreKey, v: number) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSave) { e.preventDefault(); save.mutate(); } }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Star className="h-4 w-4 text-primary" aria-hidden="true" />
            {editing ? t("dialog.titleEdit") : t("dialog.titleNew")}
          </DialogTitle>
          <DialogDescription>{t("dialog.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="rating-trader" className="text-xs text-muted-foreground">{t("dialog.trader")}</label>
              <PersonSelect id="rating-trader" value={form.trader} onValueChange={(v) => setForm((f) => ({ ...f, trader: v }))} disabled={!!editing} options={traderOptions} placeholder={t("dialog.pickTrader")} ariaLabel={t("dialog.trader")} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="rating-week" className="text-xs text-muted-foreground">{t("dialog.week")}</label>
              <Input
                id="rating-week" type="date" value={form.week} disabled={!!editing}
                onChange={(e) => setForm((f) => ({ ...f, week: e.target.value ? weekOf(new Date(`${e.target.value}T12:00:00`)) : "" }))}
              />
            </div>
          </div>
          {!editing && (
            <div className="-mt-2 flex flex-wrap items-center gap-1.5">
              <button type="button" className="chip min-h-7 px-2.5 text-xs" aria-pressed={form.week === thisWeek} onClick={() => setForm((f) => ({ ...f, week: thisWeek }))}>{t("dialog.thisWeek")}</button>
              <button type="button" className="chip min-h-7 px-2.5 text-xs" aria-pressed={form.week === shiftWeek(thisWeek, -1)} onClick={() => setForm((f) => ({ ...f, week: shiftWeek(thisWeek, -1) }))}>{t("dialog.lastWeek")}</button>
              {form.week && <span className="text-xs text-muted-foreground">{weekLabel(form.week)}</span>}
            </div>
          )}
          {existing && (
            <p className="rounded-xl bg-[hsl(var(--chart-3)/0.12)] px-3 py-2 text-xs text-foreground">
              {t("dialog.existing", { trader: personName(form.trader), overall: existing.overall })}
            </p>
          )}

          <EvidencePanel trader={form.trader} week={form.week} evidence={evidenceQ.data ?? null} loading={evidenceQ.isLoading && weekValid} />

          <div className="flex flex-col gap-3">
            {CRITERIA.map((c) => (
              <div key={c.key} className="flex flex-col gap-1">
                <ScorePicker
                  id={`rating-${c.key}`} label={c.label} hint={c.hint} icon={c.icon}
                  value={form[c.key]} prev={lastWeek?.[c.key as CriterionKey] ?? null}
                  onChange={(v) => set(c.key, v)}
                />
                {criterionEvidence(c.key) && <p className="pl-6 text-2xs tabular-nums text-muted-foreground">{criterionEvidence(c.key)}</p>}
              </div>
            ))}
            <div className="rounded-xl bg-[var(--glass-bg)] p-3">
              <ScorePicker
                id="rating-overall" label={OVERALL.label} icon={OVERALL.icon}
                value={form.overall} prev={lastWeek?.overall ?? null}
                onChange={(v) => { setOverallTouched(true); set("overall", v); }}
              />
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                {overallTouched ? (
                  <button type="button" className="inline-flex items-center gap-1 rounded-full px-1 hover:text-foreground" onClick={() => setOverallTouched(false)}>
                    <Wand2 className="h-3 w-3" aria-hidden="true" /> {t("dialog.resetAvg", { value: suggested })}
                  </button>
                ) : (
                  <Pill tone="accent">{t("dialog.autoAvg")}</Pill>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_160px]">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="rating-focus" className="text-xs text-muted-foreground">{t("dialog.focus")}</label>
              <Input
                id="rating-focus" maxLength={500} value={form.focus}
                onChange={(e) => setForm((f) => ({ ...f, focus: e.target.value }))}
                placeholder={t("dialog.focusPlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="rating-tier" className="text-xs text-muted-foreground">{t("dialog.tier")}</label>
              <Select value={form.tier || "none"} onValueChange={(v) => setForm((f) => ({ ...f, tier: v === "none" ? "" : v }))}>
                <SelectTrigger id="rating-tier" aria-label={t("dialog.tier")}><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {TIER_CODES.map((k) => <SelectItem key={k} value={k}>{tierLabel(k)}</SelectItem>)}
                  {form.tier && !isLadderTier(form.tier) && <SelectItem value={form.tier}>{tierLabel(form.tier)}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="rating-comment" className="text-xs text-muted-foreground">{t("dialog.comment")}</label>
              <VoiceRecorder onTranscript={(text) => setForm((f) => ({ ...f, comment: f.comment ? `${f.comment}\n${text}` : text }))} />
            </div>
            <Textarea
              id="rating-comment" rows={3} maxLength={4000} value={form.comment}
              onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))}
              placeholder={t("dialog.commentPlaceholder")}
              className="resize-none"
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <span className="mr-auto hidden self-center text-xs text-muted-foreground sm:inline">{t("dialog.shortcut")}</span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{tc("actions.cancel")}</Button>
          <Button onClick={() => save.mutate()} disabled={!canSave}>
            {save.isPending ? t("dialog.saving") : editing || existing ? t("dialog.update") : t("dialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
