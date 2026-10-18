/**
 * Collaboration block of «Отчёт недели»: last week's goals (done / partial / missed),
 * the trader's self-assessment and the curator's comment + score + 1–3 goals for next week.
 */
import * as React from "react";
import { Check, CheckCircle2, Flag, MessageSquareText, Send, Target, UserRound } from "lucide-react";
import { Panel, Pill, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  GOAL_LABEL, STATUS_LABEL, fmtDay, useSaveCurator, useSaveSelf, useSetGoalStatus, weekLabel,
  type Goal, type GoalStatus, type Review, type ReviewStatus, type WeeklyReview,
} from "./api";
import { weeklyI18n } from "@/i18n/ns/weeklyReview";
import { personName } from "@/i18n";

const STATUS_TONE: Record<ReviewStatus | "none", Tone> = { none: "neutral", draft: "neutral", submitted: "accent", reviewed: "up" };
const GOAL_TONE: Record<GoalStatus, Tone> = { open: "neutral", done: "up", partial: "warn", missed: "down" };

export function ReviewStatusPill({ status, className }: { status: ReviewStatus | "none"; className?: string }) {
  return <Pill tone={STATUS_TONE[status]} dot className={className}>{STATUS_LABEL[status]}</Pill>;
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : weeklyI18n.t("collab.saveFailed");
}

// ── Last week's goals ────────────────────────────────────────────────────────
export function PrevGoalsPanel({ doc }: { doc: WeeklyReview }) {
  const { t } = weeklyI18n.useT();
  const goals = doc.prevGoals;
  const canMark = doc.viewer.isOwner || doc.viewer.staff;
  const mut = useSetGoalStatus();
  const set = (g: Goal, status: GoalStatus) => {
    if (!canMark || g.status === status) return;
    mut.mutate(
      { trader: doc.trader, week: doc.week.prevKey, goals: [{ id: g.id, status }] },
      { onError: (e) => toast({ title: t("collab.goalStatusFailed"), description: errMsg(e), variant: "destructive" }) },
    );
  };
  const done = goals.filter((g) => g.status === "done").length;
  return (
    <Panel
      title={t("collab.prevGoalsTitle")}
      description={goals.length ? t("collab.prevGoalsDesc", { done, total: goals.length, week: weekLabel(doc.week.prevKey) }) : t("collab.prevGoalsDescEmpty", { week: weekLabel(doc.week.prevKey) })}
      icon={Flag}
      className="min-w-0"
    >
      {goals.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{t("collab.noPrevGoals")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {goals.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-sm">
              <span className={cn("min-w-0 flex-1 text-foreground", g.status === "done" && "line-through decoration-up/60")}>{g.text}</span>
              {canMark ? (
                <div className="flex items-center gap-1" role="group" aria-label={t("collab.goalStatusAria", { text: g.text })}>
                  {(["done", "partial", "missed"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={g.status === s}
                      disabled={mut.isPending}
                      onClick={() => set(g, s)}
                      className={cn("chip min-h-7 px-2.5 text-xs font-medium disabled:opacity-60", g.status === s && (s === "done" ? "text-up" : s === "partial" ? "text-[hsl(var(--chart-3))]" : "text-down"))}
                    >
                      {GOAL_LABEL[s]}
                    </button>
                  ))}
                </div>
              ) : (
                <Pill tone={GOAL_TONE[g.status]}>{GOAL_LABEL[g.status]}</Pill>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Trader self-assessment ───────────────────────────────────────────────────
/** `hideFocus`: the weekly goal is edited in its own panel (GoalPanel); saves here keep the stored focus. */
export function SelfReviewPanel({ doc, hideFocus = false, className }: { doc: WeeklyReview; hideFocus?: boolean; className?: string }) {
  const { t } = weeklyI18n.useT();
  const review = doc.review;
  const s = review?.selfReview ?? {};
  const editable = doc.viewer.isOwner;
  const [well, setWell] = React.useState(s.well ?? "");
  const [badly, setBadly] = React.useState(s.badly ?? "");
  const [lessons, setLessons] = React.useState(s.lessons ?? "");
  const [focus, setFocus] = React.useState(s.focus ?? "");
  const [dirty, setDirty] = React.useState(false);
  const saveMut = useSaveSelf();
  const key = `${doc.trader}:${doc.week.key}:${s.updatedAt ?? ""}`;
  const lastKey = React.useRef(key);
  React.useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    if (!dirty) { setWell(s.well ?? ""); setBadly(s.badly ?? ""); setLessons(s.lessons ?? ""); setFocus(s.focus ?? ""); }
  }, [key, dirty, s.well, s.badly, s.lessons, s.focus]);

  const filled = !!(s.well || s.badly || (!hideFocus && s.focus) || s.lessons);
  const save = (submit: boolean) => {
    saveMut.mutate(
      { week: doc.week.key, well, badly, focus: hideFocus ? (s.focus ?? "") : focus, lessons, mood: s.mood ?? null, submit },
      {
        onSuccess: (r: Review) => {
          setDirty(false);
          toast({ title: submit ? t("collab.selfSent") : t("collab.draftSaved"), description: submit ? t("collab.statusIs", { status: STATUS_LABEL[r.status] }) : undefined });
        },
        onError: (e) => toast({ title: t("collab.saveFailed"), description: errMsg(e), variant: "destructive" }),
      },
    );
  };
  const bind = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLTextAreaElement>) => { set(e.target.value); setDirty(true); };
  const status = review?.status ?? "none";
  const canSubmit = editable && status !== "reviewed";

  if (!editable) {
    return (
      <Panel title={t("collab.selfTitle")} description={filled && s.updatedAt ? t("collab.updatedOn", { date: fmtDay(s.updatedAt.slice(0, 10)) }) : undefined} icon={UserRound} className={cn("min-w-0", className)} actions={<ReviewStatusPill status={status} />}>
        {!filled ? (
          <p className="py-3 text-sm text-muted-foreground">{t("collab.selfEmpty")}</p>
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {s.well && <div><dt className="micro-label mb-1 text-up">{t("collab.well")}</dt><dd className="whitespace-pre-wrap text-foreground">{s.well}</dd></div>}
            {s.badly && <div><dt className="micro-label mb-1 text-down">{t("collab.badly")}</dt><dd className="whitespace-pre-wrap text-foreground">{s.badly}</dd></div>}
            {s.lessons && <div><dt className="micro-label mb-1">{t("collab.lessons")}</dt><dd className="whitespace-pre-wrap text-foreground">{s.lessons}</dd></div>}
            {s.focus && !hideFocus && <div><dt className="micro-label mb-1 text-primary">{t("collab.focus")}</dt><dd className="whitespace-pre-wrap text-foreground">{s.focus}</dd></div>}
          </dl>
        )}
      </Panel>
    );
  }

  return (
    <Panel title={t("collab.mySelf")} description={t("collab.mySelfDesc")} icon={UserRound} className={cn("min-w-0", className)} actions={<ReviewStatusPill status={status} />}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span className="text-up">{t("collab.well")}</span>
          <Textarea value={well} onChange={bind(setWell)} rows={3} maxLength={6000} placeholder={t("collab.wellPlaceholder")} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span className="text-down">{t("collab.badly")}</span>
          <Textarea value={badly} onChange={bind(setBadly)} rows={3} maxLength={6000} placeholder={t("collab.badlyPlaceholder")} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{t("collab.lessons")}</span>
          <Textarea value={lessons} onChange={bind(setLessons)} rows={2} maxLength={6000} placeholder={t("collab.lessonsPlaceholder")} />
        </label>
        {!hideFocus && (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span className="text-primary">{t("collab.focus")}</span>
            <Textarea value={focus} onChange={bind(setFocus)} rows={2} maxLength={6000} placeholder={t("collab.focusPlaceholder")} />
          </label>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canSubmit && (
          <Button type="button" onClick={() => save(true)} disabled={saveMut.isPending || !(well || badly || (hideFocus ? s.focus : focus) || lessons)}>
            <Send className="h-4 w-4" aria-hidden="true" /> {status === "submitted" ? t("collab.resend") : t("collab.send")}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={() => save(false)} disabled={saveMut.isPending || !dirty}>
          {t("collab.saveDraft")}
        </Button>
        {status === "reviewed" && <span className="text-xs text-muted-foreground">{t("collab.reviewedNote")}</span>}
        {dirty && <span className="text-xs text-muted-foreground">{t("collab.unsaved")}</span>}
      </div>
    </Panel>
  );
}

// ── Curator review ───────────────────────────────────────────────────────────
export function CuratorReviewPanel({ doc, className, readOnly = false }: { doc: WeeklyReview; className?: string; readOnly?: boolean }) {
  const { t } = weeklyI18n.useT();
  const review = doc.review;
  const c = review?.curatorReview ?? {};
  const editable = doc.viewer.staff && !readOnly;
  const [comment, setComment] = React.useState(c.comment ?? "");
  const [score, setScore] = React.useState<number | null>(c.score ?? null);
  const [goals, setGoals] = React.useState<Array<{ id?: string; text: string }>>(review?.goals.map((g) => ({ id: g.id, text: g.text })) ?? []);
  const [dirty, setDirty] = React.useState(false);
  const saveMut = useSaveCurator();
  const key = `${doc.trader}:${doc.week.key}:${c.updatedAt ?? ""}:${review?.updatedAt ?? ""}`;
  const lastKey = React.useRef(key);
  React.useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    if (!dirty) {
      setComment(c.comment ?? "");
      setScore(c.score ?? null);
      setGoals(review?.goals.map((g) => ({ id: g.id, text: g.text })) ?? []);
    }
  }, [key, dirty, c.comment, c.score, review?.goals]);

  const status = review?.status ?? "none";
  const cleanGoals = goals.map((g) => ({ ...g, text: g.text.trim() })).filter((g) => g.text);
  const save = (finalize: boolean) => {
    saveMut.mutate(
      { trader: doc.trader, week: doc.week.key, comment, score, goals: cleanGoals, finalize },
      {
        onSuccess: () => {
          setDirty(false);
          toast({ title: finalize ? t("collab.reviewSaved", { trader: personName(doc.trader) }) : t("collab.reviewDraftSaved"), description: finalize ? t("collab.goalsForNext", { count: cleanGoals.length }) : undefined });
        },
        onError: (e) => toast({ title: t("collab.reviewFailed"), description: errMsg(e), variant: "destructive" }),
      },
    );
  };
  const setGoal = (i: number, text: string) => { setGoals((gs) => gs.map((g, j) => (j === i ? { ...g, text } : g))); setDirty(true); };
  const addGoal = () => { if (goals.length < 3) { setGoals((gs) => [...gs, { text: "" }]); setDirty(true); } };
  const removeGoal = (i: number) => { setGoals((gs) => gs.filter((_, j) => j !== i)); setDirty(true); };

  if (!editable) {
    const filled = !!(c.comment || c.score != null || (review?.goals.length ?? 0) > 0);
    return (
      <Panel title={t("collab.curatorTitle")} description={c.by ? `${personName(c.by)}${review?.reviewedAt ? ` · ${fmtDay(review.reviewedAt.slice(0, 10))}` : ""}` : undefined} icon={MessageSquareText} className={cn("min-w-0", className)} actions={c.score != null ? <ScorePill score={c.score} /> : undefined}>
        {!filled ? (
          <p className="py-3 text-sm text-muted-foreground">{t("collab.curatorEmpty")}</p>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            {c.comment && <p className="whitespace-pre-wrap text-foreground">{c.comment}</p>}
            {review && review.goals.length > 0 && (
              <div>
                <p className="micro-label mb-1 text-primary">{t("collab.nextGoals")}</p>
                <ol className="list-decimal space-y-1 pl-5 text-foreground">{review.goals.map((g) => <li key={g.id}>{g.text}</li>)}</ol>
              </div>
            )}
          </div>
        )}
      </Panel>
    );
  }

  return (
    <Panel title={t("collab.curatorTitle")} description={t("collab.curatorDesc")} icon={MessageSquareText} className={cn("min-w-0", className)} actions={<ReviewStatusPill status={status} />}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{t("collab.comment")}</span>
          <Textarea value={comment} onChange={(e) => { setComment(e.target.value); setDirty(true); }} rows={4} maxLength={6000} placeholder={t("collab.commentPlaceholder")} />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t("collab.score")}</span>
          <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label={t("collab.scoreAria")}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={score === v}
                onClick={() => { setScore(score === v ? null : v); setDirty(true); }}
                className={cn(
                  "grid h-8 w-8 place-items-center rounded-full text-sm font-medium tabular-nums transition-colors",
                  score === v ? "bg-primary-solid text-primary-foreground" : "glass-field text-muted-foreground hover:text-foreground",
                )}
              >
                {v}
              </button>
            ))}
            {score != null && <ScorePill score={score} className="ml-2" />}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t("collab.goalsUpTo3")}</span>
          <ul className="flex flex-col gap-2">
            {goals.map((g, i) => (
              <li key={g.id ?? `new-${i}`} className="flex items-center gap-2">
                <Target className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <Input value={g.text} onChange={(e) => setGoal(i, e.target.value)} maxLength={300} placeholder={t("collab.goalN", { n: i + 1 })} aria-label={t("collab.goalN", { n: i + 1 })} />
                <Button type="button" variant="ghost" size="sm" onClick={() => removeGoal(i)} aria-label={t("collab.removeGoalN", { n: i + 1 })}>{t("collab.remove")}</Button>
              </li>
            ))}
          </ul>
          {goals.length < 3 && (
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={addGoal}>{t("collab.addGoal")}</Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => save(true)} disabled={saveMut.isPending || !(comment || score != null || cleanGoals.length)}>
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {status === "reviewed" ? t("collab.updateReview") : t("collab.finishReview")}
          </Button>
          <Button type="button" variant="outline" onClick={() => save(false)} disabled={saveMut.isPending || !dirty}>{t("collab.saveDraft")}</Button>
          {status === "reviewed" && review?.reviewedAt && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Check className="h-3.5 w-3.5" aria-hidden="true" /> {t("collab.reviewedOn", { date: fmtDay(review.reviewedAt.slice(0, 10)) })}{c.by ? ` · ${personName(c.by)}` : ""}</span>}
        </div>
      </div>
    </Panel>
  );
}

export function ScorePill({ score, className }: { score: number; className?: string }) {
  return <Pill tone={score >= 7 ? "up" : score >= 5 ? "warn" : "down"} className={className}>{score}/10</Pill>;
}
