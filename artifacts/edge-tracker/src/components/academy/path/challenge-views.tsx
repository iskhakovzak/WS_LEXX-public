/** «Экзамены»: list cards, detail (rules progress + day-by-day timeline), create-from-template dialog. */
import * as React from "react";
import { Link } from "wouter";
import { Archive, CalendarRange, Flag, ListChecks, Plus, Route as RouteIcon } from "lucide-react";
import { EmptyState, Panel, StatCard, StatGrid } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  type ChallengeListItem, type ChallengeTemplate, type StageKey,
  suggestedTemplate, useChallenge, useFunnel, usePathMutation,
} from "./api";
import { fmtDate, fmtUsd } from "@/lib/format";
import { http } from "@/lib/api/http";
import { academyPathI18n } from "@/i18n/ns/academyPath";
import { commonI18n } from "@/i18n/ns/common";
import { shellI18n } from "@/i18n/ns/shell";
import { personName } from "@/i18n";
import { ChallengeStatusPill, ChallengeTimeline, Field, RuleBar, selectCls } from "./bits";
import { challengeName, failureText, rulesSummary, stageName, templateDescription, templateName } from "./labels";
import { PersonSelect } from "@/components/people/person-select";

export function ChallengeCard({ c, active, onOpen, showUser, templates }: {
  c: ChallengeListItem; active: boolean; onOpen: () => void; showUser: boolean;
  /** Config templates: an exam created under a template's default name shows that name in the UI language. */
  templates?: readonly ChallengeTemplate[];
}) {
  const { t } = academyPathI18n.useT();
  const r = c.result;
  const target = r.progress.find((p) => p.key === "profit_target");
  const name = challengeName(c, templates);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={active}
      className={cn("glass-panel flex w-full flex-col gap-2 rounded-2xl p-3 text-left transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "ring-2 ring-primary/60")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground" title={name}>{name}</p>
          <p className="text-xs text-muted-foreground">{showUser ? `${personName(c.user)} · ` : ""}{fmtDate(c.startsOn)} – {fmtDate(c.endsOn)}</p>
        </div>
        <ChallengeStatusPill status={r.status} />
      </div>
      {target && target.pct != null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--glass-bg)]" role="progressbar" aria-label={t("challenge.card.targetAria", { pct: Math.round(target.pct * 100) })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(target.pct * 100)}>
          <div className={cn("h-full rounded-full", r.status === "failed" ? "bg-down" : r.status === "passed" ? "bg-up" : "bg-primary")} style={{ width: `${Math.max(0, Math.min(1, target.pct)) * 100}%` }} />
        </div>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs tabular-nums">
        <span className={cn("font-semibold", r.stats.net > 0 ? "text-up" : r.stats.net < 0 ? "text-down" : "text-foreground")}>{fmtUsd(r.stats.net, { decimals: 0 })}</span>
        <span className="text-muted-foreground">{t("challenge.card.days", { count: r.stats.tradingDays, left: r.tradingDaysLeft })}</span>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground" title={r.reason}>{r.reason}</p>
    </button>
  );
}

/** `pathHref` = the trader's «Путь трейдера» page (the exam is a step of that path). */
export function ChallengeDetailView({ id, onArchived, pathHref }: { id: number; onArchived: () => void; pathHref?: (user: string) => string }) {
  const { t } = academyPathI18n.useT();
  const q = useChallenge(id);
  const { toast } = useToast();
  const archive = usePathMutation(() => http.post(`/api/academy/challenges/${id}/archive`, {}));
  if (q.isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (q.isError || !q.data) return <Panel><EmptyState icon={Flag} title={t("challenge.notFound")} description={(q.error as Error | null)?.message} /></Panel>;
  const { challenge: c, result: r, canManage, template } = q.data;
  const mode = c.rules.drawdownMode;
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={challengeName(c, template ? [template] : null)}
        description={t("challenge.detailMeta", { user: personName(c.user), from: fmtDate(c.startsOn), to: fmtDate(c.endsOn), by: personName(c.createdBy) })}
        icon={Flag}
        actions={
          <>
            <ChallengeStatusPill status={r.status} />
            {pathHref && (
              <Button asChild size="sm" variant="ghost">
                <Link href={pathHref(c.user)}><RouteIcon className="mr-1.5 h-4 w-4" aria-hidden="true" />{shellI18n.t("nav.academyPath")}</Link>
              </Button>
            )}
            {canManage && !c.archivedAt && (
              <Button size="sm" variant="ghost" disabled={archive.isPending}
                onClick={() => archive.mutate(undefined, {
                  onSuccess: () => { toast({ title: t("challenge.archived") }); onArchived(); },
                  onError: (e) => toast({ title: t("challenge.failed"), description: (e as Error).message, variant: "destructive" }),
                })}>
                <Archive className="mr-1.5 h-4 w-4" aria-hidden="true" />{commonI18n.t("actions.archive")}
              </Button>
            )}
          </>
        }
      >
        <p className={cn("text-sm", r.status === "failed" ? "text-down" : r.status === "passed" ? "text-up" : "text-foreground")} role="status">{r.reason}</p>
        {r.failure && <p className="mt-1 text-xs text-muted-foreground">{failureText(r.failure, mode)}</p>}
        <p className="mt-2 text-xs text-muted-foreground">{rulesSummary(c.rules)}</p>
        {c.comment && <p className="mt-2 text-sm text-foreground/90">«{c.comment}»</p>}
      </Panel>

      <StatGrid>
        <StatCard label={t("challenge.stats.net")} value={fmtUsd(r.stats.net, { decimals: 0 })} tone={r.stats.net > 0 ? "up" : r.stats.net < 0 ? "down" : "neutral"} hint={t("challenge.stats.balance", { usd: fmtUsd(r.stats.balance, { decimals: 0 }) })} />
        <StatCard label={t("challenge.stats.tradingDays")} value={`${r.stats.tradingDays}`} hint={t("challenge.stats.daysHint", { elapsed: r.tradingDaysElapsed, total: r.tradingDaysTotal, left: r.tradingDaysLeft })} />
        <StatCard label={t("challenge.stats.bestWorst")} value={`${fmtUsd(r.stats.bestDay, { decimals: 0 })} / ${fmtUsd(r.stats.worstDay, { decimals: 0 })}`} hint={r.stats.consistencyPct != null ? t("challenge.stats.bestShare", { pct: Math.round(r.stats.consistencyPct) }) : t("challenge.stats.noProfit")} />
        <StatCard label={t("challenge.stats.maxDd")} value={fmtUsd(r.stats.maxDdUsed, { decimals: 0 })} tone={r.stats.maxDdUsed > 0 ? "down" : "neutral"} hint={t("challenge.stats.worstIntraday", { usd: fmtUsd(r.stats.worstDayLow, { decimals: 0 }) })} />
      </StatGrid>

      <Panel title={t("challenge.rulesTitle")} icon={ListChecks} description={t("challenge.rulesDescription")}>
        <ul className="grid gap-4 md:grid-cols-2">{r.progress.map((p) => <RuleBar key={p.key} p={p} mode={mode} />)}</ul>
        {(r.stats.tradesWithoutPnl > 0 || r.stats.tradesWithoutTime > 0) && (
          <p className="mt-3 text-xs text-muted-foreground">
            {[
              r.stats.tradesWithoutPnl > 0 ? t("challenge.withoutPnl", { count: r.stats.tradesWithoutPnl }) : null,
              r.stats.tradesWithoutTime > 0 ? t("challenge.withoutTime", { count: r.stats.tradesWithoutTime }) : null,
            ].filter(Boolean).join(" ")}
          </p>
        )}
      </Panel>

      <Panel title={t("challenge.byDayTitle")} icon={CalendarRange} description={t("challenge.byDayDescription")}>
        <ChallengeTimeline days={r.timeline} accountSize={c.rules.accountSize} />
      </Panel>
    </div>
  );
}

function nyToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function CreateChallengeDialog({ open, onOpenChange, templates, people, defaultUser, onCreated }: {
  open: boolean; onOpenChange: (v: boolean) => void; templates: ChallengeTemplate[]; people: string[]; defaultUser: string | null; onCreated: (id: number) => void;
}) {
  const { t } = academyPathI18n.useT();
  const { toast } = useToast();
  const [user, setUser] = React.useState(defaultUser ?? people[0] ?? "");
  const [tplKey, setTplKey] = React.useState(templates[0]?.key ?? "");
  const [startsOn, setStartsOn] = React.useState(nyToday());
  const [endsOn, setEndsOn] = React.useState("");
  const [comment, setComment] = React.useState("");
  React.useEffect(() => { if (open) { setUser(defaultUser ?? people[0] ?? ""); setTplKey((k) => k || templates[0]?.key || ""); } }, [open, defaultUser, people, templates]);
  // Stage of each person (staff funnel) → the capital exam suggested for the selected trader.
  const funnel = useFunnel(open);
  const stageOf = React.useMemo(() => {
    const m = new Map<string, StageKey>();
    for (const col of funnel.data?.columns ?? []) for (const p of col.people) if (p.stage) m.set(p.user, p.stage);
    return m;
  }, [funnel.data]);
  const personOptions = React.useMemo(() => people.map((n) => ({ value: n, label: personName(n) })), [people]);
  const userStage = stageOf.get(user) ?? null;
  const suggested = suggestedTemplate(templates, userStage);
  React.useEffect(() => { if (open && suggested) setTplKey(suggested.key); }, [open, user, suggested?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const capital = templates.filter((x) => x.toStage != null);
  const tests = templates.filter((x) => x.toStage == null);
  const tpl = templates.find((x) => x.key === tplKey);
  const create = usePathMutation((body: unknown) => http.post<{ id: number }>("/api/academy/challenges", body));
  const stageHint = userStage
    ? (suggested
      ? t("create.hintSuggested", { user: personName(user), stage: stageName(funnel.data?.stages, userStage), template: templateName(suggested) })
      : t("create.hintNone", { user: personName(user), stage: stageName(funnel.data?.stages, userStage) }))
    : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
          <DialogDescription>{t("create.description")}</DialogDescription>
        </DialogHeader>
        <form
          id="create-challenge"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!user || !tpl) return;
            create.mutate({ user, templateKey: tpl.key, startsOn, endsOn: endsOn || undefined, comment: comment.trim() || undefined }, {
              onSuccess: (out) => { toast({ title: t("create.assigned"), description: t("create.assignedDescription", { name: templateName(tpl), user: personName(user) }) }); onOpenChange(false); setComment(""); setEndsOn(""); onCreated(out.id); },
              onError: (err) => toast({ title: t("create.failed"), description: (err as Error).message, variant: "destructive" }),
            });
          }}
        >
          <Field label={t("create.student")} htmlFor="ch-user">
            <PersonSelect id="ch-user" value={user} onValueChange={setUser} options={personOptions} placeholder={t("create.studentPlaceholder")} ariaLabel={t("create.student")} />
          </Field>
          <Field label={t("create.template")} htmlFor="ch-tpl" hint={stageHint}>
            <select id="ch-tpl" className={selectCls} value={tplKey} onChange={(e) => setTplKey(e.target.value)}>
              {capital.length > 0 && (
                <optgroup label={t("create.groupCapital")}>
                  {capital.map((x) => <option key={x.key} value={x.key}>{x.key === suggested?.key ? t("create.recommended", { name: templateName(x) }) : templateName(x)}</option>)}
                </optgroup>
              )}
              {tests.length > 0 && (
                <optgroup label={t("create.groupTests")}>
                  {tests.map((x) => <option key={x.key} value={x.key}>{templateName(x)}</option>)}
                </optgroup>
              )}
            </select>
          </Field>
          {tpl && <p className="rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-xs text-muted-foreground">{templateDescription(tpl)}</p>}
          <div className="grid grid-cols-2 items-end gap-3">
            <Field label={t("create.start")} htmlFor="ch-start">
              <input id="ch-start" type="date" className={selectCls} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} required />
            </Field>
            <Field label={t("create.end")} htmlFor="ch-end">
              <input id="ch-end" type="date" className={selectCls} value={endsOn} min={startsOn} onChange={(e) => setEndsOn(e.target.value)} />
            </Field>
          </div>
          <Field label={t("create.comment")} htmlFor="ch-comment">
            <Textarea id="ch-comment" rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("create.commentPlaceholder")} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{commonI18n.t("actions.cancel")}</Button>
          <Button type="submit" form="create-challenge" disabled={create.isPending || !user || !tpl}><Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />{commonI18n.t("actions.assign")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
