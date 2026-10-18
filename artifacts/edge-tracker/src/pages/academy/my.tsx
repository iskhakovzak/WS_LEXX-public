import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ArrowRight, BookOpenCheck, CalendarClock, CalendarDays, CheckCircle2, GraduationCap, PlayCircle, ListChecks, MessagesSquare, Target, UserCheck, Users } from "lucide-react";
import { EmptyState, ErrorState, Page, PageHeader, Panel, Pill, StatCard, StatGrid, StatGridSkeleton, PanelSkeleton } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { links } from "@/lib/links";
import { nyDate } from "@/lib/trading-date";
import { cn } from "@/lib/utils";
import {
  type ActionItem, type Goal, type MyDashboard, type MyOccurrence, STAGES, formatLabel, kindLabel, meetingFormatLabel, stageLabel, statusLabel,
  useCheckin, useMyDashboard, useUpdateAction, useUpdateGoal,
} from "@/components/academy/cohorts/api";
import {
  AttendancePill, AttendanceSummaryView, DualTime, GoalCard, LOCAL_TZ, SAME_TZ, StagePill, StatusPill, UserSelect, WhereLine,
  dateTimeLocal, dayIn, durationShort, fmtYmd, relMinutes, useNow, withNodes,
} from "@/components/academy/cohorts/shared";
import { fmtRate } from "@/lib/format";
import { usePrograms } from "@/components/academy/content/api";
import { PctBar } from "@/components/academy/content/bits";
import { academyLinks } from "@/components/academy/content/links";
import { academyCohortsI18n } from "@/i18n/ns/academyCohorts";
import { commonI18n } from "@/i18n/ns/common";
import { shellI18n } from "@/i18n/ns/shell";
import { personName } from "@/i18n";

/**
 * /academy/my — «Моё обучение»: когорта и ступень, ближайшие занятия с самоотметкой (удалённо: окно −10…+15 мин,
 * время проверяет сервер), цели ИПР по реальным сделкам, договорённости с наставником, посещаемость, встречи 1:1.
 * Наставник (staff) может открыть дашборд студента: ?user=Имя.
 */
export default function AcademyMyPage() {
  const { t } = academyCohortsI18n.useT();
  const { user, isCurator } = useAuth();
  const search = useSearch();
  const [, navigate] = useLocation();
  const me = user?.traderName ?? "";
  const viewUser = (isCurator && new URLSearchParams(search).get("user")) || me;
  const q = useMyDashboard(viewUser === me ? "" : viewUser);
  const d = q.data;

  return (
    <Page>
      <PageHeader
        icon={GraduationCap}
        title={shellI18n.t("nav.academyMy")}
        description={d?.viewingOther ? t("myPage.viewing", { name: personName(d.user) }) : t("myPage.description")}
        actions={isCurator ? (
          <div className="w-56">
            <UserSelect id="my-view-user" label={t("myPage.openAs")} value={viewUser || null}
              onChange={(v) => navigate(v && v !== me ? `/academy/my?user=${encodeURIComponent(v)}` : "/academy/my")} />
          </div>
        ) : undefined}
      />
      {q.isLoading && <><StatGridSkeleton count={4} /><PanelSkeleton height={220} /></>}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} title={t("myPage.loadFailed")} />}
      {d && !d.user && <EmptyState icon={GraduationCap} title={t("myPage.signIn")} description={t("myPage.guest")} />}
      {d && d.user && d.enrollments.length === 0 && (
        <Panel>
          <EmptyState icon={Users} title={d.viewingOther ? t("myPage.notEnrolledOther", { name: personName(d.user) }) : t("myPage.notEnrolled")}
            description={t("myPage.notEnrolledDesc")} />
        </Panel>
      )}
      {d && d.user && d.enrollments.length > 0 && <Dashboard d={d} readOnly={!!d.viewingOther} />}
    </Page>
  );
}

function Dashboard({ d, readOnly }: { d: MyDashboard; readOnly: boolean }) {
  const { t } = academyCohortsI18n.useT();
  const now = useNow(d.serverNow);
  const next = d.upcoming[0];
  const att30 = useMemo(() => {
    const list = d.attendance?.byCohort ?? [];
    const s = list.reduce((acc, c) => ({ p: acc.p + c.last30.present + c.last30.late, a: acc.a + c.last30.absent }), { p: 0, a: 0 });
    return s.p + s.a > 0 ? s.p / (s.p + s.a) : null;
  }, [d.attendance]);
  const activeGoals = d.goals.filter((g) => g.status === "active");
  const openActions = d.actionItems.filter((a) => a.status === "open");
  const overdue = openActions.filter((a) => a.overdue).length;

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-2">
        {d.enrollments.map((e) => {
          const format = formatLabel(e.cohort.format);
          const date = fmtYmd(e.joinedOn, true);
          return (
            <Panel key={e.id} title={e.cohort.name} icon={Users}
              description={e.cohort.mentor ? t("myPage.cohortDesc", { format, mentor: personName(e.cohort.mentor), date }) : t("myPage.cohortDescNoMentor", { format, date })}
              actions={<><StagePill stage={e.stage} /><StatusPill status={e.status} /></>}>
              <Ladder stage={e.stage} />
              {e.note && <p className="mt-2 text-xs text-muted-foreground">{e.note}</p>}
              {/* Next steps of the same process: promotion criteria and the cohort's full schedule. */}
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                <Link href={`/academy/path${readOnly ? `?user=${encodeURIComponent(d.user ?? "")}` : ""}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  {t("myPage.promotion")} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
                <Link href={`/academy/cohorts?id=${e.cohort.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />{t("myPage.openCohort")}
                </Link>
              </div>
            </Panel>
          );
        })}
        <CoursesCard user={readOnly ? d.user ?? undefined : undefined} />
      </div>

      <StatGrid>
        <StatCard label={t("myPage.kpi.next")} icon={CalendarClock}
          value={next ? relMinutes(new Date(next.startUtc).getTime(), now) : "—"}
          hint={next ? t("myPage.kpi.nextHint", { title: next.title, day: dayIn(next.startUtc, LOCAL_TZ) }) : t("myPage.kpi.noNext")} />
        <StatCard label={t("myPage.kpi.att30")} icon={UserCheck} value={fmtRate(att30)}
          tone={att30 == null ? "neutral" : att30 >= 0.9 ? "up" : att30 >= 0.75 ? "warn" : "down"}
          hint={t("myPage.kpi.totalHint", { rate: fmtRate(d.attendance?.total.rate ?? null) })} />
        <StatCard label={t("myPage.kpi.goals")} icon={Target} value={`${d.goals.filter((g) => g.status === "achieved").length} / ${d.goals.filter((g) => g.status !== "cancelled").length}`}
          hint={activeGoals.length ? t("myPage.kpi.inProgress", { n: activeGoals.length }) : t("myPage.kpi.noActive")} />
        <StatCard label={t("myPage.kpi.actions")} icon={ListChecks} value={openActions.length} tone={overdue ? "down" : "neutral"}
          hint={overdue ? t("myPage.kpi.overdue", { n: overdue }) : t("myPage.kpi.open")} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <Upcoming d={d} now={now} readOnly={readOnly} />
        <Goals goals={d.goals} readOnly={readOnly} user={d.user!} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Actions items={d.actionItems} readOnly={readOnly} />
        <AttendancePanel d={d} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Meetings d={d} />
        <History d={d} />
      </div>
    </>
  );
}

/** Курсы рядом с когортой: прогресс программы и «Продолжить» — без похода в «Обучение» за следующим уроком. */
function CoursesCard({ user }: { user?: string }) {
  const { t } = academyCohortsI18n.useT();
  const q = usePrograms(user);
  const list = q.data?.programs ?? [];
  const p = list.find((x) => x.progress.pct < 100 && x.progress.total > 0) ?? list[0];
  return (
    <Panel title={t("myPage.courses.title")} icon={BookOpenCheck}
      actions={<Link href={academyLinks.learn({ program: p?.id, user })} className="text-xs font-medium text-primary hover:underline">{t("myPage.courses.all")}</Link>}>
      {q.isLoading ? (
        <div className="flex flex-col gap-2" aria-busy="true"><span className="skeleton block h-4 w-2/3" /><span className="skeleton block h-1.5 w-full" /><span className="skeleton block h-8 w-48" /></div>
      ) : q.isError ? (
        <p className="text-sm text-muted-foreground">{t("myPage.courses.failed")}</p>
      ) : !p ? (
        <p className="text-sm text-muted-foreground">{t("myPage.courses.empty")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium text-foreground" title={p.title}>{p.title}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t("myPage.courses.progress", { done: p.progress.done, total: p.progress.total, pct: Math.round(p.progress.pct) })}</span>
          </div>
          <PctBar pct={p.progress.pct} label={t("myPage.courses.progressAria", { title: p.title })} />
          {p.progress.next ? (
            <Button size="sm" className="mt-1 self-start" asChild>
              <Link href={academyLinks.item(p.progress.next.kind, p.progress.next.id, { user })}>
                <PlayCircle className="mr-1 h-4 w-4" aria-hidden="true" />
                {(() => {
                  const label = p.progress.done ? t("myPage.courses.continue", { title: p.progress.next.title }) : t("myPage.courses.start", { title: p.progress.next.title });
                  return <span className="max-w-[22rem] truncate" title={label}>{label}</span>;
                })()}
              </Link>
            </Button>
          ) : (
            <Pill tone="up" dot>{t("myPage.courses.completed")}</Pill>
          )}
        </div>
      )}
    </Panel>
  );
}

/** Лестница Стажёр → Джун → Трейдер → Сеньор. */
function Ladder({ stage }: { stage: (typeof STAGES)[number] }) {
  const { t } = academyCohortsI18n.useT();
  const idx = STAGES.indexOf(stage);
  return (
    <ol className="flex items-center gap-1" aria-label={t("myPage.ladderAria", { stage: stageLabel(stage), n: idx + 1, total: STAGES.length })}>
      {STAGES.map((s, i) => (
        <li key={s} className="flex min-w-0 flex-1 flex-col items-center gap-1" aria-current={i === idx ? "step" : undefined}>
          <span className={cn("h-1.5 w-full rounded-full", i <= idx ? "bg-primary" : "bg-[var(--glass-border)]")} aria-hidden="true" />
          <span className={cn("max-w-full truncate text-xs", i === idx ? "font-semibold text-foreground" : "text-muted-foreground")} title={stageLabel(s)}>{stageLabel(s)}</span>
        </li>
      ))}
    </ol>
  );
}

function CheckinButton({ o, now, onDone }: { o: MyOccurrence; now: number; onDone?: () => void }) {
  const { t } = academyCohortsI18n.useT();
  const checkin = useCheckin();
  const { toast } = useToast();
  const opens = new Date(o.checkinOpensAt).getTime();
  const closes = new Date(o.checkinClosesAt).getTime();
  if (o.attendance) return <AttendancePill status={o.attendance.status} self={o.attendance.source === "self"} />;
  if (!o.selfCheckin) return o.mode === "office" ? <span className="text-xs text-muted-foreground">{t("myPage.checkin.byMentor")}</span> : null;
  if (now < opens) return <span className="text-xs tabular-nums text-muted-foreground">{t("myPage.checkin.opensIn", { time: durationShort((opens - now) / 60000) })}</span>;
  if (now > closes) return <span className="text-xs text-muted-foreground">{t("myPage.checkin.closed")}</span>;
  return (
    <Button size="sm" disabled={checkin.isPending}
      onClick={() => checkin.mutate({ sessionId: o.sessionId, date: o.date }, {
        onSuccess: (r) => { toast({ title: r.already ? t("myPage.checkin.already") : r.status === "late" ? t("myPage.checkin.late") : t("myPage.checkin.present") }); onDone?.(); },
        onError: (e) => toast({ title: t("myPage.checkin.failed"), description: e.message, variant: "destructive" }),
      })}>
      <CheckCircle2 className="mr-1 h-4 w-4" aria-hidden="true" />{t("myPage.checkin.button")}
    </Button>
  );
}

function Upcoming({ d, now, readOnly }: { d: MyDashboard; now: number; readOnly: boolean }) {
  const { t } = academyCohortsI18n.useT();
  const groups = useMemo(() => {
    const m = new Map<string, MyOccurrence[]>();
    for (const o of d.upcoming) { const k = dayIn(o.startUtc, LOCAL_TZ); m.set(k, [...(m.get(k) ?? []), o]); }
    return [...m.entries()];
  }, [d.upcoming]);
  const descParams = { tz: LOCAL_TZ, before: d.checkin.beforeMin, after: d.checkin.afterMin, grace: d.checkin.graceMin };
  return (
    <Panel title={t("myPage.upcoming.title")} icon={CalendarClock}
      description={SAME_TZ ? t("myPage.upcoming.descSame", descParams) : t("myPage.upcoming.descDual", descParams)}>
      {groups.length === 0 && <p className="text-sm text-muted-foreground">{t("myPage.upcoming.empty")}</p>}
      <div className="flex flex-col gap-3">
        {groups.slice(0, 7).map(([day, list]) => (
          <section key={day} aria-label={day}>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{day}</h3>
            <ul className="flex flex-col gap-1.5">
              {list.map((o) => {
                const live = now >= new Date(o.startUtc).getTime() && now <= new Date(o.endUtc).getTime();
                return (
                  <li key={`${o.sessionId}-${o.date}`} className={cn("glass-field flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2", live && "ring-1 ring-primary/60")}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{o.title}</span>
                        <Pill tone="neutral">{kindLabel(o.kind)}</Pill>
                        {live && <Pill tone="accent" dot>{t("myPage.upcoming.live")}</Pill>}
                        {d.enrollments.length > 1 && <span className="text-xs text-muted-foreground">{o.cohortName}</span>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <DualTime start={o.startUtc} end={o.endUtc} />
                        <WhereLine mode={o.mode} room={o.room} meetingUrl={o.meetingUrl} />
                      </div>
                    </div>
                    {readOnly
                      ? (o.attendance ? <AttendancePill status={o.attendance.status} self={o.attendance.source === "self"} /> : null)
                      : <CheckinButton o={o} now={now} />}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Panel>
  );
}

function ManualProgress({ goal }: { goal: Goal }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const upd = useUpdateGoal();
  const { toast } = useToast();
  const [v, setV] = useState<number | "">(goal.manualProgress ?? 0);
  return (
    <form className="flex items-center gap-1" onSubmit={(e) => {
      e.preventDefault();
      if (v === "") return;
      upd.mutate({ id: goal.id, manualProgress: Math.max(0, Math.min(100, Number(v))) }, {
        onSuccess: () => toast({ title: t("myPage.manual.saved") }),
        onError: (err) => toast({ title: ct("states.notSaved"), description: err.message, variant: "destructive" }),
      });
    }}>
      <Input aria-label={t("myPage.manual.aria")} type="number" min={0} max={100} className="h-8 w-20" value={v} onChange={(e) => setV(e.target.value === "" ? "" : Number(e.target.value))} />
      <Button type="submit" size="sm" variant="outline" disabled={upd.isPending} title={ct("actions.save")}>%</Button>
    </form>
  );
}

function Goals({ goals, readOnly, user }: { goals: Goal[]; readOnly: boolean; user: string }) {
  const { t } = academyCohortsI18n.useT();
  const visible = goals.filter((g) => g.status !== "cancelled");
  return (
    <Panel title={t("myPage.goals.title")} icon={Target} description={t("myPage.goals.description")}>
      {visible.length === 0 && <p className="text-sm text-muted-foreground">{t("myPage.goals.empty")}</p>}
      <div className="flex flex-col gap-2">
        {visible.map((g) => (
          <GoalCard key={g.id} goal={g}
            actions={g.metric === "manual" && g.status === "active" && !readOnly ? <ManualProgress goal={g} /> : undefined} />
        ))}
      </div>
      {visible.some((g) => g.metric !== "manual") && (
        <p className="mt-3 text-xs text-muted-foreground">
          {withNodes(t("myPage.goals.source", { trades: "{trades}", journal: "{journal}" }), {
            trades: <Link className="text-primary hover:underline" href={links.trades({})}>{t("myPage.goals.trades")}</Link>,
            journal: <Link className="text-primary hover:underline" href={links.journalDay(nyDate(), readOnly ? user : undefined)}>{t("myPage.goals.journal")}</Link>,
          })}
        </p>
      )}
    </Panel>
  );
}

function Actions({ items, readOnly }: { items: ActionItem[]; readOnly: boolean }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const upd = useUpdateAction();
  const { toast } = useToast();
  return (
    <Panel title={t("myPage.actions.title")} icon={ListChecks}>
      {items.length === 0 && <p className="text-sm text-muted-foreground">{t("myPage.actions.empty")}</p>}
      <ul className="flex flex-col divide-y divide-border/50">
        {items.map((a) => (
          <li key={a.id} className="flex items-start gap-3 py-2">
            <Checkbox id={`act-${a.id}`} checked={a.status === "done"} disabled={readOnly || a.owner !== "student" || upd.isPending || a.status === "dropped"}
              onCheckedChange={(c) => upd.mutate({ id: a.id, status: c ? "done" : "open" }, { onError: (e) => toast({ title: ct("states.notSaved"), description: e.message, variant: "destructive" }) })}
              aria-label={t("mentorPage.openActions.doneAria", { title: a.title })} className="mt-0.5" />
            <label htmlFor={`act-${a.id}`} className="min-w-0 flex-1">
              <span className={cn("text-sm", a.status === "done" ? "text-muted-foreground line-through" : "text-foreground")}>{a.title}</span>
              <span className="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
                {a.owner === "mentor" && <span>{t("myPage.actions.byMentor")}</span>}
                {a.dueOn && <span className={cn(a.overdue && "font-medium text-down")}>{t("shared.due", { date: fmtYmd(a.dueOn) })}{a.overdue ? ` · ${t("myPage.actions.overdue")}` : ""}</span>}
                {a.doneAt && <span>{t("myPage.actions.doneAt", { date: dateTimeLocal(a.doneAt) })}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function AttendancePanel({ d }: { d: MyDashboard }) {
  const { t } = academyCohortsI18n.useT();
  return (
    <Panel title={t("myPage.attendance.title")} icon={UserCheck} description={t("myPage.attendance.description")}>
      <div className="grid gap-4 sm:grid-cols-2">
        {(d.attendance?.byCohort ?? []).map((c) => (
          <div key={c.cohortId}>
            <AttendanceSummaryView s={c.last30} title={t("myPage.attendance.cohort30", { cohort: c.cohortName })} />
          </div>
        ))}
      </div>
      {d.recent.length > 0 && (
        <>
          <h3 className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("myPage.attendance.recent")}</h3>
          <ul className="flex flex-col divide-y divide-border/50">
            {d.recent.slice(0, 8).map((o) => (
              <li key={`${o.sessionId}-${o.date}`} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <span className="min-w-0 truncate" title={o.title}><DualTime start={o.startUtc} showDay /> <span className="text-muted-foreground">· {o.title}</span></span>
                <AttendancePill status={o.attendance?.status ?? null} self={o.attendance?.source === "self"} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function Meetings({ d }: { d: MyDashboard }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  return (
    <Panel title={t("myPage.meetings.title")} icon={MessagesSquare}>
      {d.meetings.length === 0 && <p className="text-sm text-muted-foreground">{t("myPage.meetings.empty")}</p>}
      <ul className="flex flex-col gap-2">
        {d.meetings.slice(0, 5).map((m) => (
          <li key={m.id} className="glass-field rounded-xl px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium tabular-nums text-foreground">{dateTimeLocal(m.metAt)}</span>
              <span className="text-muted-foreground">
                {t("myPage.meetings.with", { mentor: personName(m.mentor) })}{m.durationMin ? ` · ${ct("time.minutesShort", { count: m.durationMin })}` : ""} · {meetingFormatLabel(m.format, true)}
              </span>
            </div>
            {m.agenda && <p className="mt-1 text-sm text-foreground"><span className="text-muted-foreground">{t("myPage.meetings.agenda")} </span>{m.agenda}</p>}
            {m.notes && <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{m.notes}</p>}
            {m.privateNotes && <p className="mt-1 whitespace-pre-line text-xs text-warn">{t("myPage.meetings.privately", { text: m.privateNotes })}</p>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function History({ d }: { d: MyDashboard }) {
  const { t } = academyCohortsI18n.useT();
  const h = d.history ?? [];
  return (
    <Panel title={t("myPage.history.title")} icon={GraduationCap}>
      {h.length === 0 && <p className="text-sm text-muted-foreground">{t("myPage.history.empty")}</p>}
      <ol className="flex flex-col gap-1.5">
        {h.map((r) => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="tabular-nums text-muted-foreground">{dateTimeLocal(r.changedAt)}</span>
            {r.fromStage !== r.toStage && r.toStage && <span>{r.fromStage ? stageLabel(r.fromStage) : "—"} → <b>{stageLabel(r.toStage)}</b></span>}
            {r.fromStatus !== r.toStatus && r.toStatus && <span>{r.fromStatus ? statusLabel(r.fromStatus) : "—"} → <b>{statusLabel(r.toStatus)}</b></span>}
            {r.changedBy && <span className="text-xs text-muted-foreground">({personName(r.changedBy)})</span>}
            {r.note && <span className="w-full text-xs text-muted-foreground">{r.note}</span>}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
