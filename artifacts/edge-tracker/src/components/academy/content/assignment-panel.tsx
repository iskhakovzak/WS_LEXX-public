/**
 * Assignment view: brief + rubric, the student's submission form (text, URL, own trades by id) and history,
 * and the mentor grading form (rubric scores + comment, or «вернуть на доработку»).
 */
import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, Search, Send, Undo2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { EmptyState, Panel, Pill } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { api, invalidateAcademy, useMyTrades, type AssignmentResponse, type RubricCriterion, type Submission, type TradeRef } from "./api";
import { SubmissionPill, toneOfNum } from "./bits";
import { Markdown } from "./markdown";
import { DualTime } from "./time";
import { fmtR, fmtUsd } from "@/lib/format";
import { academyI18n } from "@/i18n/ns/academy";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

export function RubricTable({ rubric, scores }: { rubric: RubricCriterion[]; scores?: Record<string, number> | null }) {
  const { t } = academyI18n.useT();
  const max = rubric.reduce((s, c) => s + c.maxPoints, 0);
  return (
    <table className="w-full text-sm tabular-nums">
      <caption className="sr-only">{t("assignment.rubricCaption")}</caption>
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th scope="col" className="py-1.5 font-medium">{t("assignment.criterion")}</th>
          <th scope="col" className="py-1.5 text-right font-medium">{scores ? t("assignment.score") : t("assignment.points")}</th>
        </tr>
      </thead>
      <tbody>
        {rubric.map((c) => (
          <tr key={c.key} className="border-t border-border/50 align-top">
            <td className="py-2 pr-3">
              <span className="text-foreground">{c.label}</span>
              {c.description && <span className="block text-xs text-muted-foreground">{c.description}</span>}
            </td>
            <td className="py-2 text-right">{scores ? `${scores[c.key] ?? 0} / ${c.maxPoints}` : c.maxPoints}</td>
          </tr>
        ))}
        <tr className="border-t border-[var(--glass-border)] font-medium">
          <td className="py-2">{commonI18n.t("fields.total")}</td>
          <td className="py-2 text-right">{scores ? `${rubric.reduce((s, c) => s + (scores[c.key] ?? 0), 0)} / ${max}` : max}</td>
        </tr>
      </tbody>
    </table>
  );
}

export function TradeChips({ trades }: { trades: TradeRef[] }) {
  const { t } = academyI18n.useT();
  if (!trades.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t("assignment.linkedTrades")}>
      {trades.map((tr) => (
        <li key={tr.id}>
          {tr.missing ? (
            <Pill tone="neutral" title={t("assignment.tradeMissing")}>#{tr.id}</Pill>
          ) : (
            <a href={links.trade(tr.id)} className="chip inline-flex min-h-7 items-center gap-1.5 px-2.5 text-xs tabular-nums" title={tr.setup ?? undefined}>
              <b className="font-semibold">{tr.ticker}</b>
              <span className="text-muted-foreground">{tr.date}</span>
              <span className={cn(toneOfNum(tr.net) === "up" ? "text-up" : toneOfNum(tr.net) === "down" ? "text-down" : "text-muted-foreground")}>{fmtUsd(tr.net, { signed: true })}</span>
              {tr.r != null && <span className="text-muted-foreground">{fmtR(tr.r)}</span>}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function TradePicker({ selected, onChange, user }: { selected: number[]; onChange: (ids: number[]) => void; user?: string }) {
  const { t } = academyI18n.useT();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const trades = useMyTrades(debounced, user);
  const list = trades.data?.trades ?? [];
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("assignment.tradeSearchPh")} className="pl-9" aria-label={t("assignment.tradeSearchAria")} />
      </div>
      <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-[var(--glass-border)]" role="group" aria-label={t("assignment.myTrades")}>
        {trades.isLoading ? (
          <p className="p-3 text-sm text-muted-foreground">{commonI18n.t("states.loading")}</p>
        ) : !list.length ? (
          <p className="p-3 text-sm text-muted-foreground">{t("assignment.noTrades")}</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {list.map((tr) => (
              <li key={tr.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-[var(--glass-bg)]">
                  <input type="checkbox" checked={selected.includes(tr.id)} onChange={() => toggle(tr.id)} className="accent-[hsl(var(--primary))]" />
                  <span className="w-24 shrink-0 tabular-nums text-muted-foreground">{tr.date}</span>
                  <b className="w-16 shrink-0">{tr.ticker}</b>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={tr.setup || undefined}>{tr.setup || commonI18n.t("trading.noSetup")}</span>
                  <span className={cn("tabular-nums", toneOfNum(tr.net) === "up" ? "text-up" : toneOfNum(tr.net) === "down" ? "text-down" : "")}>{fmtUsd(tr.net, { signed: true })}</span>
                  <span className="w-16 text-right tabular-nums text-muted-foreground">{fmtR(tr.r)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{commonI18n.t("states.selected", { count: selected.length })}</span>
          {selected.map((id) => (
            <button key={id} type="button" onClick={() => toggle(id)} className="chip inline-flex min-h-7 items-center gap-1 px-2 text-xs tabular-nums" aria-label={t("assignment.removeTrade", { id })}>
              #{list.find((tr) => tr.id === id)?.ticker ?? id} <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SubmissionForm({ assignmentId, minTrades, editing, onDone }: { assignmentId: number; minTrades: number; editing?: Submission | null; onDone: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState(editing?.text ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [tradeIds, setTradeIds] = useState<number[]>(editing?.tradeIds ?? []);
  const [busy, setBusy] = useState(false);
  const { t } = academyI18n.useT();
  const short = minTrades > 0 && tradeIds.length < minTrades;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { text, url: url.trim() || null, tradeIds };
      if (editing) await api.editSubmission(editing.id, body);
      else {
        const r = await api.submit(assignmentId, body);
        toast({ title: t("assignment.submitted"), description: r.notified ? t("assignment.mentorNotified", { count: r.notified }) : t("assignment.queued") });
      }
      void invalidateAcademy(qc);
      onDone();
    } catch (err) {
      toast({ title: t("quiz.sendFailed"), description: (err as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sub-text">{t("assignment.answer")}</Label>
        <Textarea id="sub-text" value={text} onChange={(e) => setText(e.target.value)} rows={10} placeholder={t("assignment.answerPh")} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sub-url">{t("assignment.link")}</Label>
        <Input id="sub-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{commonI18n.t("trading.trades")} {minTrades > 0 && <span className="text-muted-foreground">{t("assignment.minHint", { count: minTrades })}</span>}</Label>
        <TradePicker selected={tradeIds} onChange={setTradeIds} />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {short && <span className="text-xs text-[hsl(var(--chart-3))]">{t("assignment.attachMore", { count: minTrades - tradeIds.length })}</span>}
        {editing && <Button type="button" variant="ghost" onClick={onDone}>{commonI18n.t("actions.cancel")}</Button>}
        <Button type="submit" disabled={busy || short || (!text.trim() && !url.trim() && !tradeIds.length)}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
          {editing ? commonI18n.t("actions.save") : t("assignment.sendForReview")}
        </Button>
      </div>
    </form>
  );
}

export function SubmissionCard({ s, rubric, showUser, actions }: { s: Submission; rubric: RubricCriterion[]; showUser?: boolean; actions?: React.ReactNode }) {
  const { t } = academyI18n.useT();
  return (
    <article className="glass-panel flex flex-col gap-3 rounded-2xl p-4" aria-label={t("assignment.submissionFrom", { name: personName(s.userName) })}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {showUser && <b className="text-foreground">{personName(s.userName)}</b>}
          <SubmissionPill status={s.status} passed={s.passed} />
          <span className="text-xs text-muted-foreground">{t("assignment.sent")} <DualTime iso={s.createdAt} /></span>
        </div>
        {actions}
      </header>
      {s.text ? <Markdown source={s.text} /> : null}
      {s.url && (
        <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex w-fit items-center gap-1.5 text-sm text-primary hover:underline">
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />{s.url.length > 80 ? `${s.url.slice(0, 80)}…` : s.url}
        </a>
      )}
      <TradeChips trades={s.trades} />
      {(s.status === "graded" || s.status === "returned") && (
        <div className="rounded-xl bg-[var(--glass-bg)] p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            {s.gradedBy ? personName(s.gradedBy) : commonI18n.t("roles.mentor")} · <DualTime iso={s.gradedAt} />
            {s.status === "graded" && s.pct != null && <> · <b className="tabular-nums text-foreground">{s.total} / {s.maxTotal} ({Math.round(s.pct)}%)</b></>}
          </p>
          {s.status === "graded" && s.scores && rubric.length > 0 && <RubricTable rubric={rubric} scores={s.scores} />}
          {s.mentorComment && <Markdown source={s.mentorComment} className="mt-2" />}
        </div>
      )}
    </article>
  );
}

/** Mentor grading form: per-criterion scores (number inputs with max), comment, grade or return. */
export function GradeForm({ submission, rubric, passPct, onDone }: { submission: Submission; rubric: RubricCriterion[]; passPct: number; onDone?: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [scores, setScores] = useState<Record<string, string>>(() =>
    Object.fromEntries(rubric.map((c) => [c.key, submission.scores?.[c.key] != null ? String(submission.scores[c.key]) : ""])));
  const [comment, setComment] = useState(submission.mentorComment ?? "");
  const [busy, setBusy] = useState<"graded" | "returned" | null>(null);
  const { t } = academyI18n.useT();
  const nums = rubric.map((c) => Math.max(0, Math.min(c.maxPoints, Number((scores[c.key] ?? "").replace(",", ".")) || 0)));
  const total = nums.reduce((s, v) => s + v, 0);
  const max = rubric.reduce((s, c) => s + c.maxPoints, 0);
  const pct = max ? (total / max) * 100 : 0;
  const complete = rubric.every((c) => (scores[c.key] ?? "").trim() !== "");

  const send = async (decision: "graded" | "returned") => {
    setBusy(decision);
    try {
      await api.grade(submission.id, {
        decision,
        scores: decision === "graded" ? Object.fromEntries(rubric.map((c, i) => [c.key, nums[i]])) : undefined,
        comment,
      });
      toast({ title: decision === "graded" ? t("assignment.gradeSaved") : t("assignment.returned"), description: t("assignment.willBeNotified", { name: personName(submission.userName) }) });
      void invalidateAcademy(qc);
      onDone?.();
    } catch (e) {
      toast({ title: commonI18n.t("states.error"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--glass-border)] p-3">
      <p className="text-xs font-medium text-muted-foreground">{t("assignment.rubricGrade")}</p>
      <div className="flex flex-col gap-2">
        {rubric.map((c) => (
          <div key={c.key} className="flex items-center gap-3">
            <label htmlFor={`g-${submission.id}-${c.key}`} className="min-w-0 flex-1 text-sm">
              {c.label}
              {c.description && <span className="block text-xs text-muted-foreground">{c.description}</span>}
            </label>
            <Input
              id={`g-${submission.id}-${c.key}`}
              type="number" min={0} max={c.maxPoints} step={0.5} inputMode="decimal"
              className="w-20 text-right tabular-nums"
              value={scores[c.key] ?? ""}
              onChange={(e) => setScores((s) => ({ ...s, [c.key]: e.target.value }))}
            />
            <span className="w-10 text-sm tabular-nums text-muted-foreground">/ {c.maxPoints}</span>
          </div>
        ))}
      </div>
      <p className="text-sm tabular-nums">
        <b>{t("assignment.totalOf", { total, max, pct: Math.round(pct) })}</b> — {pct >= passPct ? <span className="text-up">{t("assignment.pass")}</span> : <span className="text-down">{t("assignment.fail")}</span>} {t("assignment.threshold", { pct: passPct })}
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`gc-${submission.id}`}>{t("assignment.mentorComment")}</Label>
        <Textarea id={`gc-${submission.id}`} rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("assignment.commentPh")} />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => send("returned")} disabled={!!busy || !comment.trim()} title={!comment.trim() ? t("assignment.needComment") : undefined}>
          {busy === "returned" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Undo2 aria-hidden="true" />}{t("assignment.toRevision")}
        </Button>
        <Button onClick={() => send("graded")} disabled={!!busy || !complete} title={!complete ? t("assignment.gradeAll") : undefined}>
          {busy === "graded" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}{t("assignment.saveGrade")}
        </Button>
      </div>
    </div>
  );
}

export function AssignmentPanel({ data, canSubmit, staff, focusSubmission }: { data: AssignmentResponse; canSubmit: boolean; staff: boolean; focusSubmission?: number | null }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { assignment, submissions } = data;
  const [editing, setEditing] = useState<Submission | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [gradingId, setGradingId] = useState<number | null>(focusSubmission ?? null);
  const { t } = academyI18n.useT();
  const latest = submissions[0];
  const mine = !data.all;
  const canNew = canSubmit && mine && (!latest || latest.status !== "submitted");
  const showForm = canSubmit && mine && (!latest || newOpen);
  const sorted = useMemo(() => submissions, [submissions]);

  useEffect(() => {
    if (!focusSubmission) return;
    requestAnimationFrame(() => document.getElementById(`submission-${focusSubmission}`)?.scrollIntoView({ block: "center" }));
  }, [focusSubmission, submissions.length]);

  const withdraw = async (s: Submission) => {
    if (!window.confirm(t("assignment.withdrawConfirm"))) return;
    try {
      await api.withdrawSubmission(s.id);
      void invalidateAcademy(qc);
    } catch (e) {
      toast({ title: commonI18n.t("states.error"), description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title={t("kind.assignment")}>
          <Markdown source={assignment.bodyMd} />
        </Panel>

        {showForm && !editing && (
          <Panel title={latest ? t("assignment.newSubmission") : t("assignment.submitAssignment")} description={latest?.status === "returned" ? t("assignment.considerComment") : undefined}>
            <SubmissionForm assignmentId={assignment.id} minTrades={assignment.minTrades} onDone={() => setNewOpen(false)} />
          </Panel>
        )}
        {editing && (
          <Panel title={t("assignment.editing")}>
            <SubmissionForm assignmentId={assignment.id} minTrades={assignment.minTrades} editing={editing} onDone={() => setEditing(null)} />
          </Panel>
        )}

        <section className="flex flex-col gap-3" aria-label={t("assignment.submissionsAria")}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">{data.all ? t("assignment.studentSubmissions", { count: submissions.length }) : t("assignment.mySubmissions")}</h2>
            {canNew && latest && !newOpen && <Button size="sm" variant="outline" onClick={() => setNewOpen(true)}>{t("assignment.resubmit")}</Button>}
          </div>
          {!sorted.length ? (
            <EmptyState title={t("assignment.noSubmissions")} description={mine ? t("assignment.noSubmissionsHint") : undefined} />
          ) : (
            sorted.map((s) => (
              <div key={s.id} id={`submission-${s.id}`} className={cn("flex flex-col gap-2 rounded-2xl", focusSubmission === s.id && "ring-1 ring-primary/50")}>
                <SubmissionCard
                  s={s}
                  rubric={assignment.rubric}
                  showUser={data.all}
                  actions={
                    <div className="flex gap-1.5">
                      {mine && canSubmit && s.status === "submitted" && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>{commonI18n.t("actions.edit")}</Button>
                          <Button size="sm" variant="ghost" onClick={() => withdraw(s)}>{t("assignment.withdraw")}</Button>
                        </>
                      )}
                      {staff && (
                        <Button size="sm" variant={gradingId === s.id ? "secondary" : "outline"} onClick={() => setGradingId(gradingId === s.id ? null : s.id)} aria-expanded={gradingId === s.id}>
                          {s.status === "submitted" ? t("review.grade") : t("review.regrade")}
                        </Button>
                      )}
                    </div>
                  }
                />
                {staff && gradingId === s.id && (
                  <GradeForm submission={s} rubric={assignment.rubric} passPct={assignment.passPct} onDone={() => setGradingId(null)} />
                )}
              </div>
            ))
          )}
        </section>
      </div>

      <aside className="flex flex-col gap-4">
        <Panel title={t("assignment.howGraded")} description={[t("assignment.passFrom", { pct: assignment.passPct }), assignment.minTrades ? t("assignment.minTrades", { count: assignment.minTrades }) : null].filter(Boolean).join(" · ")}>
          <RubricTable rubric={assignment.rubric} />
        </Panel>
      </aside>
    </div>
  );
}
