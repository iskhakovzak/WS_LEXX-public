/** One trader's path: ladder, readiness report, promotion request, mentor decision, direct stage assignment, history. */
import * as React from "react";
import { Link } from "wouter";
import { ArrowRight, Flag, History, Send, ShieldCheck, Target, Undo2, UserCog } from "lucide-react";
import { EmptyState, Panel, Pill, ProgressRing, StatCard, StatGrid } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  type PathConfig, type PromotionRequest, type StageKey, STAGE_KEYS,
  fmtInstant, usePathMutation, useReport,
} from "./api";
import { fmtDate, fmtUsd } from "@/lib/format";
import { http } from "@/lib/api/http";
import { academyPathI18n } from "@/i18n/ns/academyPath";
import { commonI18n } from "@/i18n/ns/common";
import { shellI18n } from "@/i18n/ns/shell";
import { personName } from "@/i18n";
import { CriterionRow, Field, StageLadder, selectCls } from "./bits";
import { criterionLabel, headlineText, noteText, stageName, stageTitle } from "./labels";

/** Exams of a trader: own page for self, `?user=` for staff looking at someone else. */
export const examsHref = (user: string, isSelf: boolean) => (isSelf ? "/academy/challenges" : `/academy/challenges?user=${encodeURIComponent(user)}`);

/** Where a failing criterion can be worked on. Personal pages (learning, rules, behavior) only for the trader themself. */
const IMPROVE_AT: Record<string, { nav: "academyChallenges" | "academyLearn" | "rules" | "behavior"; selfOnly: boolean }> = {
  challenges_passed: { nav: "academyChallenges", selfOnly: false },
  lessons_pct: { nav: "academyLearn", selfOnly: true },
  quiz_avg: { nav: "academyLearn", selfOnly: true },
  violations: { nav: "rules", selfOnly: true },
  discipline_index: { nav: "behavior", selfOnly: true },
};
const NAV_HREF = { academyLearn: "/academy/learn", rules: "/rules", behavior: "/behavior" } as const;

function ImproveLink({ href, section }: { href: string; section: string }) {
  const { t } = academyPathI18n.useT();
  return (
    <Link href={href} className="inline-flex shrink-0 items-center gap-1 font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {t("criterion.goTo", { section })}<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  );
}

export function PersonView({ user, config, isStaff, me }: { user: string | null; config: PathConfig | undefined; isStaff: boolean; me: string | null }) {
  const { t } = academyPathI18n.useT();
  const q = useReport(user);
  const stages = config?.stages ?? [];
  const data = q.data;
  const r = data?.report ?? null;

  if (q.isLoading) return <div className="flex flex-col gap-3"><Skeleton className="h-28 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>;
  if (q.isError) return <Panel><EmptyState icon={Target} title={t("person.loadFailed")} description={(q.error as Error).message} /></Panel>;
  if (!r) return <Panel><EmptyState icon={Target} title={t("person.guestTitle")} description={t("person.guestDescription")} /></Panel>;

  const isSelf = !!me && r.user === me;
  const pct = r.total ? (r.passed / r.total) * 100 : 0;
  const s = r.summary;
  const stageKey = r.stage?.key ?? null;
  const cur = r.stage ? stageTitle(r.stage) : null;
  const next = r.nextStage ? stageTitle(r.nextStage) : null;
  const headline = headlineText({ stage: cur, next, passed: r.passed, total: r.total, ready: r.ready });
  const stagePart = cur == null
    ? t("person.meta.stage", { stage: t("stage.none") })
    : r.stageSince
      ? (next ? t("person.meta.stageSinceNext", { stage: cur, date: fmtDate(r.stageSince), next }) : t("person.meta.stageSince", { stage: cur, date: fmtDate(r.stageSince) }))
      : (next ? t("person.meta.stageNext", { stage: cur, next }) : t("person.meta.stage", { stage: cur }));
  const windowOf = (id: number) => {
    const c = config?.criteria.find((x) => x.id === id);
    return c ? c.windowDays : undefined;
  };
  const actionFor = (metric: string) => {
    const at = IMPROVE_AT[metric];
    if (!at || (at.selfOnly && !isSelf)) return undefined;
    const href = at.nav === "academyChallenges" ? examsHref(r.user, isSelf) : NAV_HREF[at.nav];
    return <ImproveLink href={href} section={shellI18n.t(`nav.${at.nav}`)} />;
  };
  const pctOrDash = (v: number | null) => (v == null ? "—" : `${Math.round(v)}%`);

  return (
    <div className="flex flex-col gap-4">
      <StageLadder stages={stages} current={stageKey} readyFor={r.ready ? r.nextStage?.key : null} />

      <Panel>
        <div className="flex flex-wrap items-center gap-4">
          <ProgressRing value={pct} size={72} stroke={6} tone={r.ready ? "up" : pct >= 70 ? "warn" : "accent"} label={<span className="text-sm font-semibold tabular-nums">{r.passed}/{r.total}</span>} ariaLabel={t("person.ringAria", { passed: r.passed, count: r.total })} />
          <div className="min-w-0 flex-1">
            <p className={cn("text-lg font-semibold", r.ready ? "text-up" : "text-foreground")} role="status">{headline}</p>
            <p className="text-sm text-muted-foreground">
              {[personName(r.user), stagePart, t("person.meta.asOf", { date: fmtDate(r.today) })].join(" · ")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Connectedness: the exam is the step that moves the trader up — one click from the report. */}
            {r.nextStage && (isSelf || isStaff) && (
              <Button asChild size="sm" variant="ghost">
                <Link href={examsHref(r.user, isSelf)}><Flag className="mr-1.5 h-4 w-4" aria-hidden="true" />{shellI18n.t("nav.academyChallenges")}</Link>
              </Button>
            )}
            {data?.pendingRequest
              ? <Pill tone="accent" dot>{t("person.pendingPill")}</Pill>
              : r.nextStage && r.stage && (isSelf || isStaff) && <RequestButton user={r.user} ready={r.ready} />}
          </div>
        </div>
      </Panel>

      <StatGrid>
        <StatCard
          label={t("person.stats.net", { count: s.windowDays })}
          value={fmtUsd(s.net, { decimals: 0 })}
          tone={s.net == null ? "neutral" : s.net >= 0 ? "up" : "down"}
          hint={t("person.stats.netHint", { days: t("units.tradingDaysShort", { count: s.tradingDays }), trades: commonI18n.t("units.trades", { count: s.trades ?? 0 }) })}
        />
        <StatCard label={t("person.stats.wrPf")} value={`${pctOrDash(s.winRate)} · ${s.profitFactor == null ? "—" : `${s.profitFactor.toFixed(2)}×`}`} hint={t("person.stats.wrPfHint")} />
        <StatCard label={t("person.stats.maxDd")} value={fmtUsd(s.maxDd, { decimals: 0 })} tone={s.maxDd ? "down" : "neutral"} hint={t("person.stats.bestDayHint", { value: pctOrDash(s.consistency) })} />
        <StatCard label={t("person.stats.feesDiscipline")} value={`${pctOrDash(s.feeShare)} · ${s.disciplineIndex == null ? "—" : Math.round(s.disciplineIndex)}`} hint={t("person.stats.feesDisciplineHint")} />
      </StatGrid>

      {data?.pendingRequest && <PendingRequest req={data.pendingRequest} canDecide={data.canDecide} isSelf={isSelf} stages={stages} />}

      <Panel title={cur && next ? t("person.criteriaTitle", { from: cur, to: next }) : t("person.criteriaTitleTop")} icon={Target}
        description={t("person.criteriaDescription")}>
        {r.criteria.length ? (
          <ul className="divide-y divide-[var(--field-border)]">
            {r.criteria.map((c) => (
              <CriterionRow key={c.id} c={c} stage={stageKey} configuredWindow={windowOf(c.id)} stageSince={r.stageSince}
                action={c.status === "fail" ? actionFor(c.metric) : undefined} />
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">{r.stage ? t("person.noCriteria") : t("person.noStage")}</p>}
        {r.skipped.length > 0 && (
          <div className="mt-4 rounded-xl border border-dashed border-[var(--field-border)] p-3">
            <p className="text-xs font-medium text-muted-foreground">{t("person.skippedTitle")}</p>
            <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
              {r.skipped.map((c) => <li key={c.id}>{[criterionLabel(c.label, c.metric, stageKey), noteText(c.note)].filter(Boolean).join(" — ")}</li>)}
            </ul>
          </div>
        )}
      </Panel>

      {isStaff && !isSelf && <AssignStage user={r.user} current={stageKey} config={config} />}

      <Panel title={t("person.historyTitle")} icon={History}>
        {data?.history.length ? (
          <ol className="flex flex-col gap-2">
            {data.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                <span className="tabular-nums text-xs text-muted-foreground">{fmtInstant(h.createdAt)}</span>
                <span className="font-medium text-foreground">
                  {t("person.historyLine", { action: academyPathI18n.tryT(`person.actions.${h.action}`) ?? h.action, from: stageName(stages, h.fromStage), to: stageName(stages, h.toStage) })}
                </span>
                <span className="text-xs text-muted-foreground">({personName(h.actor)})</span>
                {h.comment && <span className="w-full text-xs text-muted-foreground">«{h.comment}»</span>}
              </li>
            ))}
          </ol>
        ) : <p className="text-sm text-muted-foreground">{t("person.historyEmpty")}</p>}
      </Panel>
    </div>
  );
}

function RequestButton({ user, ready }: { user: string; ready: boolean }) {
  const { t } = academyPathI18n.useT();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const m = usePathMutation((v: { user: string; comment?: string }) => http.post<{ request: PromotionRequest }>("/api/academy/path/requests", v));
  if (!open) return <Button size="sm" variant={ready ? "default" : "outline"} onClick={() => setOpen(true)}><Send className="mr-1.5 h-4 w-4" aria-hidden="true" />{t("request.submit")}</Button>;
  return (
    <form
      className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[320px]"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate({ user, comment: comment.trim() || undefined }, {
          onSuccess: () => { toast({ title: t("request.sent") }); setOpen(false); setComment(""); },
          onError: (err) => toast({ title: t("request.notSent"), description: (err as Error).message, variant: "destructive" }),
        });
      }}
    >
      {!ready && <p className="text-xs text-[hsl(var(--chart-3))]">{t("request.notAllMet")}</p>}
      <Textarea aria-label={t("request.commentAria")} placeholder={t("request.commentPlaceholder")} value={comment} onChange={(e) => setComment(e.target.value)} rows={2} maxLength={2000} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={m.isPending}>{commonI18n.t("actions.send")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>{commonI18n.t("actions.cancel")}</Button>
      </div>
    </form>
  );
}

export function PendingRequest({ req, canDecide, isSelf, stages }: { req: PromotionRequest; canDecide: boolean; isSelf: boolean; stages: PathConfig["stages"] }) {
  const { t } = academyPathI18n.useT();
  const { toast } = useToast();
  const [comment, setComment] = React.useState("");
  const decide = usePathMutation((v: { action: "approve" | "reject" | "withdraw"; comment?: string }) =>
    http.post(`/api/academy/path/requests/${req.id}/${v.action}`, v.action === "withdraw" ? {} : { comment: v.comment }));
  const run = (action: "approve" | "reject" | "withdraw") =>
    decide.mutate({ action, comment: comment.trim() || undefined }, {
      onSuccess: () => toast({ title: t(action === "approve" ? "request.toast.approved" : action === "reject" ? "request.toast.rejected" : "request.toast.withdrawn") }),
      onError: (err) => toast({ title: t("request.failed"), description: (err as Error).message, variant: "destructive" }),
    });
  return (
    <Panel title={t("request.title", { from: stageName(stages, req.fromStage), to: stageName(stages, req.toStage) })} icon={ShieldCheck}
      description={t("request.description", { by: personName(req.requestedBy), at: fmtInstant(req.createdAt), passed: req.passed, count: req.total })}>
      {req.comment && <p className="mb-3 text-sm text-foreground">«{req.comment}»</p>}
      {canDecide ? (
        <div className="flex flex-col gap-2">
          <Field label={req.ready ? t("request.commentReady") : t("request.commentRequired")} htmlFor={`dec-${req.id}`}>
            <Textarea id={`dec-${req.id}`} value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={2000} placeholder={t("request.decisionPlaceholder")} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => run("approve")} disabled={decide.isPending || (!req.ready && !comment.trim())}>{t("request.approve")}</Button>
            <Button size="sm" variant="destructive" onClick={() => run("reject")} disabled={decide.isPending || !comment.trim()}>{commonI18n.t("actions.reject")}</Button>
          </div>
        </div>
      ) : isSelf ? (
        <Button size="sm" variant="ghost" onClick={() => run("withdraw")} disabled={decide.isPending}><Undo2 className="mr-1.5 h-4 w-4" aria-hidden="true" />{t("request.withdraw")}</Button>
      ) : <p className="text-sm text-muted-foreground">{t("request.waiting")}</p>}
    </Panel>
  );
}

function AssignStage({ user, current, config }: { user: string; current: StageKey | null; config: PathConfig | undefined }) {
  const { t } = academyPathI18n.useT();
  const { toast } = useToast();
  const [stage, setStage] = React.useState<StageKey>(current ?? "trainee");
  const [comment, setComment] = React.useState("");
  const m = usePathMutation((v: { user: string; stage: StageKey; comment: string }) => http.post("/api/academy/path/assign", v));
  return (
    <Panel title={t("assign.title")} icon={UserCog} description={t("assign.description")}>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate({ user, stage, comment: comment.trim() }, {
            onSuccess: () => { toast({ title: t("assign.done", { stage: stageName(config?.stages, stage) }) }); setComment(""); },
            onError: (err) => toast({ title: t("assign.failed"), description: (err as Error).message, variant: "destructive" }),
          });
        }}
      >
        <Field label={t("assign.stage")} htmlFor="assign-stage">
          <select id="assign-stage" className={selectCls} value={stage} onChange={(e) => setStage(e.target.value as StageKey)}>
            {STAGE_KEYS.map((k) => {
              const name = stageName(config?.stages, k);
              return <option key={k} value={k}>{k === current ? t("assign.current", { stage: name }) : name}</option>;
            })}
          </select>
        </Field>
        <div className="flex-1">
          <Field label={t("assign.reason")} htmlFor="assign-comment">
            <input id="assign-comment" className={cn(selectCls, "w-full")} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder={t("assign.reasonPlaceholder")} />
          </Field>
        </div>
        <Button type="submit" size="sm" disabled={m.isPending || stage === current || comment.trim().length < 3}>{commonI18n.t("actions.assign")}</Button>
      </form>
    </Panel>
  );
}
