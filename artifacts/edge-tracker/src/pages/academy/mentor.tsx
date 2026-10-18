import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearch } from "wouter";
import { AlertTriangle, CalendarClock, ClipboardCheck, Eye, ListChecks, MessagesSquare, MoreHorizontal, Plus, Target, UserCog, Users, X } from "lucide-react";
import {
  DataTable, EmptyState, ErrorState, Page, PageHeader, Panel, PanelSkeleton, Pill, Segmented, SortableTh, StatCard, StatGrid, StatGridSkeleton, useTableSort, type Tone,
} from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import {
  type ActionItem, type MentorDashboard, type MentorStudent, type TodaySession, type AttendanceStatus, attendanceLabel, kindLabel, meetingFormatLabel,
  useArchiveGoal, useIdp, useMeetings, useMentorDashboard, useUpdateAction, useUpdateGoal,
} from "@/components/academy/cohorts/api";
import { ActionDialog, EnrollmentEditDialog, GoalDialog, MeetingDialog, RosterDialog } from "@/components/academy/cohorts/dialogs";
import {
  ATT_TONE, DualTime, GoalCard, StagePill, WhereLine, dateTimeLocal, fmtYmd, withNodes,
} from "@/components/academy/cohorts/shared";
import { fmtRate } from "@/lib/format";
import { academyCohortsI18n } from "@/i18n/ns/academyCohorts";
import { commonI18n } from "@/i18n/ns/common";
import { shellI18n } from "@/i18n/ns/shell";
import { personName } from "@/i18n";

/**
 * /academy/mentor — дашборд наставника: мои студенты и кто отстаёт (с причинами), сегодняшние занятия с отметкой,
 * открытые договорённости и журнал 1:1. Только staff. ?student=Имя — открыть карточку студента (ссылки из уведомлений).
 */
export default function AcademyMentorPage() {
  const { t } = academyCohortsI18n.useT();
  const { isCurator, user } = useAuth();
  const search = useSearch();
  const [all, setAll] = useState(false);
  const q = useMentorDashboard(all);
  const d = q.data;
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(search).get("student"));
  useEffect(() => { const s = new URLSearchParams(search).get("student"); if (s) setSelected(s); }, [search]);
  const [meetingFor, setMeetingFor] = useState<string | null | undefined>(undefined);
  // 1:1 dialog: each student with their cohort's format, so the meeting format is prefilled (remote → online).
  const meetingStudents = useMemo(() => {
    const fmt = new Map((d?.cohorts ?? []).map((c) => [c.id, c.format]));
    return (d?.students ?? []).map((s) => ({ name: s.enrollment.userName, cohortId: s.enrollment.cohortId, cohortFormat: fmt.get(s.enrollment.cohortId) }));
  }, [d?.cohorts, d?.students]);
  const title = shellI18n.t("nav.academyMentor");

  if (!isCurator) {
    return (
      <Page>
        <PageHeader icon={UserCog} title={title} />
        <Panel><EmptyState icon={UserCog} title={t("mentorPage.staffOnly")}
          description={withNodes(t("mentorPage.staffOnlyDesc", { link: "{link}" }), {
            link: <Link className="text-primary hover:underline" href="/academy/my">{t("mentorPage.staffOnlyLink")}</Link>,
          })} /></Panel>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        icon={UserCog}
        title={title}
        description={t("mentorPage.description")}
        actions={<>
          {d?.hasOwnCohorts && (
            <Segmented ariaLabel={t("mentorPage.scopeAria")} value={all ? "all" : "mine"} onChange={(v) => setAll(v === "all")}
              options={[{ value: "mine", label: t("mentorPage.mine") }, { value: "all", label: t("mentorPage.all") }]} />
          )}
          <Button onClick={() => setMeetingFor(selected)} disabled={!d?.students.length}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />{t("mentorPage.newMeeting")}</Button>
        </>}
      />
      {q.isLoading && <><StatGridSkeleton count={4} /><PanelSkeleton height={280} /></>}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} title={t("mentorPage.loadFailed")} />}
      {d && d.cohorts.length === 0 && (
        <Panel><EmptyState icon={Users} title={t("mentorPage.noCohorts")} description={t("mentorPage.noCohortsDesc")} action={<Button asChild><Link href="/academy/cohorts">{t("mentorPage.toCohorts")}</Link></Button>} /></Panel>
      )}
      {d && d.cohorts.length > 0 && (
        <>
          {!d.hasOwnCohorts && <p className="text-xs text-muted-foreground">{t("mentorPage.notAssigned")}</p>}
          <Kpis d={d} />
          {/* Side-by-side only on wide screens: at 1280–1440 px the students table needs the full width («Почему отстаёт»). */}
          <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <Students d={d} selected={selected} onSelect={setSelected} onMeeting={(s) => setMeetingFor(s)} />
            <Today sessions={d.today} />
          </div>
          {selected && d.students.some((s) => s.enrollment.userName === selected) && (
            <StudentDetail student={d.students.find((s) => s.enrollment.userName === selected)!} onClose={() => setSelected(null)} onMeeting={() => setMeetingFor(selected)} />
          )}
          <div className="grid gap-4 xl:grid-cols-2">
            <OpenActions items={d.openActions} />
            <MeetingLog d={d} />
          </div>
          <MeetingDialog open={meetingFor !== undefined} onOpenChange={(v) => { if (!v) setMeetingFor(undefined); }}
            students={meetingStudents} defaultStudent={meetingFor ?? null} mentor={user?.traderName ?? null} />
        </>
      )}
    </Page>
  );
}

function Kpis({ d }: { d: MentorDashboard }) {
  const { t } = academyCohortsI18n.useT();
  const overdue = d.openActions.filter((a) => a.overdue).length;
  const rates = d.students.map((s) => s.attendance30).filter((a) => a.rate != null);
  const avg = rates.length ? rates.reduce((x, a) => x + (a.rate ?? 0), 0) / rates.length : null;
  return (
    <StatGrid>
      <StatCard label={t("mentorPage.kpi.students")} icon={Users} value={new Set(d.students.map((s) => s.enrollment.userName)).size} hint={t("mentorPage.kpi.cohortsHint", { n: d.cohorts.length })} />
      <StatCard label={t("mentorPage.kpi.lagging")} icon={AlertTriangle} value={d.lagging} tone={d.lagging ? "warn" : "up"} hint={d.lagging ? t("mentorPage.kpi.laggingHint") : t("mentorPage.kpi.onTrackHint")} />
      <StatCard label={t("mentorPage.kpi.attendance30")} icon={ClipboardCheck} value={fmtRate(avg)} tone={avg == null ? "neutral" : avg >= 0.9 ? "up" : avg >= 0.75 ? "warn" : "down"} hint={t("mentorPage.kpi.avgHint")} />
      <StatCard label={t("mentorPage.kpi.openActions")} icon={ListChecks} value={d.openActions.length} tone={overdue ? "down" : "neutral"} hint={overdue ? t("mentorPage.kpi.overdueHint", { n: overdue }) : t("mentorPage.kpi.noOverdue")} />
    </StatGrid>
  );
}

const sevTone = (s: "warn" | "critical"): Tone => (s === "critical" ? "down" : "warn");

type StudentRow = MentorDashboard["students"][number];
const STAGE_ORDER: Record<string, number> = { trainee: 0, junior: 1, trader: 2, senior: 3 };
const STUDENT_ACCESSORS = {
  name: (s: StudentRow) => personName(s.enrollment.userName),
  stage: (s: StudentRow) => STAGE_ORDER[s.enrollment.stage] ?? 9,
  att: (s: StudentRow) => s.attendance30.rate,
  goals: (s: StudentRow) => {
    const n = s.goals.active + s.goals.achieved + s.goals.missed;
    return n ? s.goals.achieved / n : null;
  },
  actions: (s: StudentRow) => s.overdueActions * 1000 + s.openActions,
  last: (s: StudentRow) => s.lastTradeDate ?? s.lastJournalDate ?? null,
  score: (s: StudentRow) => s.score,
};

function Students({ d, selected, onSelect, onMeeting }: { d: MentorDashboard; selected: string | null; onSelect: (s: string | null) => void; onMeeting: (s: string) => void }) {
  const { t } = academyCohortsI18n.useT();
  const [filter, setFilter] = useState<"all" | "lagging">("all");
  const filtered = useMemo(() => (filter === "lagging" ? d.students.filter((s) => s.score > 0) : d.students), [d.students, filter]);
  const { rows, thProps } = useTableSort(filtered, STUDENT_ACCESSORS, "score");
  return (
    <Panel title={t("mentorPage.students.title")} icon={Users} description={t("mentorPage.students.description")}
      actions={<Segmented ariaLabel={t("mentorPage.students.filterAria")} size="sm" value={filter} onChange={setFilter}
        options={[{ value: "all", label: t("mentorPage.students.all"), count: d.students.length }, { value: "lagging", label: t("mentorPage.students.lagging"), count: d.lagging }]} />}>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{filter === "lagging" ? t("mentorPage.students.noLagging") : t("mentorPage.students.noActive")}</p> : (
        <DataTable ariaLabel={t("mentorPage.students.tableAria")} maxHeight="60vh">
          <table>
            <thead>
              <tr>
                <SortableTh {...thProps("name")}>{t("cols.student")}</SortableTh>
                <SortableTh {...thProps("stage")}>{t("cols.stage")}</SortableTh>
                <SortableTh {...thProps("att")}><span title={t("mentorPage.students.colAtt30Title")}>{t("mentorPage.students.colAtt30")}</span></SortableTh>
                <SortableTh {...thProps("goals")}><span title={t("mentorPage.students.colIdpTitle")}>{t("mentorPage.students.colIdp")}</span></SortableTh>
                <SortableTh {...thProps("actions")}><span title={t("mentorPage.students.colActionsTitle")}>{t("mentorPage.students.colActions")}</span></SortableTh>
                <SortableTh {...thProps("last")}><span title={t("mentorPage.students.colLastTitle")}>{t("mentorPage.students.colLast")}</span></SortableTh>
                <SortableTh {...thProps("score")}>{t("mentorPage.students.colWhy")}</SortableTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const u = s.enrollment.userName;
                const a = s.attendance30;
                return (
                  <tr key={s.enrollment.id} aria-selected={selected === u} className={cn("cursor-pointer", selected === u && "bg-[var(--glass-bg)]")}
                    onClick={() => onSelect(selected === u ? null : u)}>
                    <td>
                      <button type="button" className="text-left font-medium text-foreground hover:underline" onClick={(e) => { e.stopPropagation(); onSelect(u); }}>{personName(u)}</button>
                      <div className="text-xs text-muted-foreground">{s.cohortName}{s.enrollment.status === "paused" ? ` · ${t("mentorPage.students.paused")}` : ""}</div>
                    </td>
                    <td><StagePill stage={s.enrollment.stage} /></td>
                    <td>
                      <span className={cn(a.rate == null ? "text-muted-foreground" : a.rate >= 0.9 ? "text-up" : a.rate >= 0.75 ? "text-warn" : "text-down")}>{fmtRate(a.rate)}</span>
                      {a.total > 0 && <div className="text-xs text-muted-foreground" title={t("mentorPage.students.attBreakdownTitle")}>{a.present}/{a.late}/{a.absent}{a.unmarked ? ` · ? ${a.unmarked}` : ""}</div>}
                    </td>
                    <td>
                      {s.goals.active + s.goals.achieved + s.goals.missed === 0 ? <span className="text-muted-foreground">—</span> : (
                        <>
                          <span>{s.goals.achieved}/{s.goals.active + s.goals.achieved + s.goals.missed}</span>
                          {s.goals.avgProgress != null && <div className="text-xs text-muted-foreground">{t("mentorPage.students.goalsInProgress", { pct: Math.round(s.goals.avgProgress * 100) })}</div>}
                        </>
                      )}
                    </td>
                    <td>
                      {s.openActions}
                      {s.overdueActions > 0 && <span className="ml-1 text-xs text-down">{t("mentorPage.students.overdue", { n: s.overdueActions })}</span>}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      <div>{s.lastTradeDate ? <Link href={links.trades({ date: s.lastTradeDate })} className="hover:underline" onClick={(e) => e.stopPropagation()}>{fmtYmd(s.lastTradeDate)}</Link> : "—"}</div>
                      <div className="text-muted-foreground">{s.lastJournalDate ? <Link href={links.journalDay(s.lastJournalDate, u)} className="hover:underline" onClick={(e) => e.stopPropagation()}>{fmtYmd(s.lastJournalDate)}</Link> : t("mentorPage.students.noJournal")}</div>
                    </td>
                    <td>
                      {s.reasons.length === 0 ? <Pill tone="up">{t("mentorPage.students.onTrack")}</Pill> : (
                        <div className="flex max-w-[22rem] flex-wrap gap-1">
                          {s.reasons.map((r) => <Pill key={r.code} tone={sevTone(r.severity)} className="whitespace-normal rounded-lg" title={r.text}>{r.text}</Pill>)}
                        </div>
                      )}
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t("mentorPage.students.lastMeeting", { when: s.lastMeetingAt ? dateTimeLocal(s.lastMeetingAt) : t("mentorPage.students.never") })}{" "}
                        <button type="button" className="text-primary hover:underline" onClick={(e) => { e.stopPropagation(); onMeeting(u); }}>{t("mentorPage.students.record")}</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTable>
      )}
    </Panel>
  );
}

const PHASE_TONE: Record<TodaySession["phase"], Tone> = { upcoming: "neutral", live: "accent", done: "neutral" };

function Today({ sessions }: { sessions: TodaySession[] }) {
  const { t } = academyCohortsI18n.useT();
  const [roster, setRoster] = useState<TodaySession | null>(null);
  return (
    <Panel title={t("mentorPage.today.title")} icon={CalendarClock} description={t("mentorPage.today.description")}>
      {sessions.length === 0 && <p className="text-sm text-muted-foreground">{t("mentorPage.today.empty")}</p>}
      <ul className="flex flex-col gap-2">
        {sessions.map((o) => {
          const missing = Math.max(0, o.expected - o.marked);
          return (
            <li key={`${o.sessionId}-${o.date}`} className={cn("glass-field rounded-xl px-3 py-2", o.phase === "live" && "ring-1 ring-primary/60")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{o.title}</span>
                <Pill tone={PHASE_TONE[o.phase]} dot={o.phase === "live"}>{t(`mentorPage.phase.${o.phase}`)}</Pill>
                <span className="text-xs text-muted-foreground">{kindLabel(o.kind)} · {o.cohortName}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm"><DualTime start={o.startUtc} end={o.endUtc} /><WhereLine mode={o.mode} room={o.room} meetingUrl={o.meetingUrl} /></div>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1 text-xs">
                  {(Object.keys(o.byStatus) as AttendanceStatus[]).map((k) => <Pill key={k} tone={ATT_TONE[k]}>{attendanceLabel(k)} {o.byStatus[k]}</Pill>)}
                  {o.phase !== "upcoming" && missing > 0 && <Pill tone="warn">{t("mentorPage.today.unmarked", { n: missing })}</Pill>}
                  {o.expected === 0 && <span className="text-muted-foreground">{t("mentorPage.today.noStudents")}</span>}
                </div>
                <Button size="sm" variant={o.phase === "upcoming" ? "outline" : "default"} onClick={() => setRoster(o)} disabled={o.expected === 0}>{t("mentorPage.today.mark")}</Button>
              </div>
            </li>
          );
        })}
      </ul>
      <RosterDialog open={!!roster} onOpenChange={(v) => { if (!v) setRoster(null); }} sessionId={roster?.sessionId ?? null} date={roster?.date ?? ""} title={roster?.title} />
    </Panel>
  );
}

function StudentDetail({ student, onClose, onMeeting }: { student: MentorStudent; onClose: () => void; onMeeting: () => void }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const u = student.enrollment.userName;
  const idp = useIdp(u);
  const meetings = useMeetings(u);
  const [allMeetings, setAllMeetings] = useState(false);
  const archive = useArchiveGoal();
  const updGoal = useUpdateGoal();
  const { toast } = useToast();
  const [goalOpen, setGoalOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);
  const err = (e: Error) => toast({ title: ct("states.notSaved"), description: e.message, variant: "destructive" });
  // The card opens under the (long) students table — bring it into view when a student is picked.
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    boxRef.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [u]);
  const archiveGoal = (id: number, title: string) => {
    if (!window.confirm(t("mentorPage.detail.archiveConfirm", { title }))) return;
    archive.mutate(id, { onSuccess: () => toast({ title: t("mentorPage.detail.goalArchived") }), onError: err });
  };
  return (
    <div ref={boxRef} className="scroll-mt-[var(--sticky-top)]">
    <Panel title={`${personName(u)} · ${student.cohortName}`} icon={Target}
      description={t("mentorPage.detail.since", { date: fmtYmd(student.enrollment.joinedOn, true), rate: fmtRate(student.attendance.rate) })}
      actions={<>
        <StagePill stage={student.enrollment.stage} />
        {/* The three everyday actions stay visible; rarer ones (stage change, student view) live under «Ещё». */}
        <Button size="sm" variant="outline" onClick={() => setGoalOpen(true)}><Target className="mr-1 h-4 w-4" aria-hidden="true" />{t("mentorPage.detail.goal")}</Button>
        <Button size="sm" variant="outline" onClick={() => setActionOpen(true)}><ListChecks className="mr-1 h-4 w-4" aria-hidden="true" />{t("mentorPage.detail.action")}</Button>
        <Button size="sm" variant="outline" onClick={onMeeting}><MessagesSquare className="mr-1 h-4 w-4" aria-hidden="true" />1:1</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost"><MoreHorizontal className="mr-1 h-4 w-4" aria-hidden="true" />{t("mentorPage.detail.more")}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setStageOpen(true)}><UserCog className="mr-2 h-4 w-4" aria-hidden="true" />{t("mentorPage.detail.stageStatus")}</DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/academy/my?user=${encodeURIComponent(u)}`}><Eye className="mr-2 h-4 w-4" aria-hidden="true" />{t("mentorPage.detail.asStudent")}</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon" variant="ghost" aria-label={t("mentorPage.detail.close")} title={t("mentorPage.detail.close")} onClick={onClose}><X className="h-4 w-4" /></Button>
      </>}>
      {student.reasons.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1" aria-label={t("mentorPage.detail.reasonsAria")}>
          {student.reasons.map((r) => <Pill key={r.code} tone={sevTone(r.severity)}>{r.text}</Pill>)}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label={t("mentorPage.detail.idpAria")}>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("mentorPage.detail.idp")}</h3>
          {idp.isLoading && <p className="text-sm text-muted-foreground">{t("mentorPage.detail.recalculating")}</p>}
          {idp.data && idp.data.goals.length === 0 && <p className="text-sm text-muted-foreground">{t("mentorPage.detail.noGoals")}</p>}
          <div className="flex flex-col gap-2">
            {idp.data?.goals.map((g) => (
              <GoalCard key={g.id} goal={g} compact actions={<>
                {g.status === "active" && <Button size="sm" variant="ghost" onClick={() => updGoal.mutate({ id: g.id, status: "cancelled" }, { onError: err })}>{t("mentorPage.detail.cancel")}</Button>}
                {(g.status === "cancelled" || g.status === "missed") && <Button size="sm" variant="ghost" onClick={() => updGoal.mutate({ id: g.id, status: "active" }, { onError: err })}>{t("mentorPage.detail.reopen")}</Button>}
                <Button size="sm" variant="ghost" onClick={() => archiveGoal(g.id, g.title)} disabled={archive.isPending}>{ct("actions.archive")}</Button>
              </>} />
            ))}
          </div>
        </section>
        <section aria-label={t("mentorPage.detail.meetings")}>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("mentorPage.detail.meetings")}</h3>
          {meetings.data && meetings.data.meetings.length === 0 && <p className="text-sm text-muted-foreground">{t("mentorPage.detail.noMeetings")}</p>}
          <ul className="flex flex-col gap-2">
            {meetings.data?.meetings.slice(0, allMeetings ? undefined : 6).map((m) => (
              <li key={m.id} className="glass-field rounded-xl px-3 py-2 text-sm">
                <div className="flex flex-wrap gap-2"><b className="tabular-nums">{dateTimeLocal(m.metAt)}</b><span className="text-muted-foreground">{personName(m.mentor)}{m.durationMin ? ` · ${ct("time.minutesShort", { count: m.durationMin })}` : ""}</span></div>
                {m.agenda && <p className="mt-1">{m.agenda}</p>}
                {m.notes && <p className="mt-1 whitespace-pre-line text-muted-foreground">{m.notes}</p>}
                {m.privateNotes && <p className="mt-1 whitespace-pre-line text-xs text-warn">{t("mentorPage.detail.privately", { text: m.privateNotes })}</p>}
                {m.actionItems && m.actionItems.length > 0 && (
                  <ul className="mt-1 text-xs text-muted-foreground">
                    {m.actionItems.map((a) => <li key={a.id} className={cn(a.status === "done" && "line-through", a.overdue && "text-down")}>• {a.title}{a.dueOn ? ` — ${fmtYmd(a.dueOn)}` : ""}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {(meetings.data?.meetings.length ?? 0) > 6 && (
            <button type="button" onClick={() => setAllMeetings((v) => !v)} className="mt-2 text-xs text-primary hover:underline">
              {allMeetings ? ct("actions.collapse") : t("mentorPage.detail.showAll", { n: meetings.data!.meetings.length })}
            </button>
          )}
        </section>
      </div>
      <GoalDialog open={goalOpen} onOpenChange={setGoalOpen} student={u} />
      <ActionDialog open={actionOpen} onOpenChange={setActionOpen} student={u} />
      <EnrollmentEditDialog open={stageOpen} onOpenChange={setStageOpen} enrollment={student.enrollment} />
    </Panel>
    </div>
  );
}

function OpenActions({ items }: { items: ActionItem[] }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const upd = useUpdateAction();
  const { toast } = useToast();
  const sorted = useMemo(() => [...items].sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999")), [items]);
  const failed = (e: Error) => toast({ title: ct("states.notSaved"), description: e.message, variant: "destructive" });
  return (
    <Panel title={t("mentorPage.openActions.title")} icon={ListChecks}>
      {sorted.length === 0 && <p className="text-sm text-muted-foreground">{t("mentorPage.openActions.allDone")}</p>}
      <ul className="flex flex-col divide-y divide-border/50">
        {sorted.slice(0, 40).map((a) => (
          <li key={a.id} className="flex items-start gap-3 py-2">
            <Checkbox id={`ma-${a.id}`} checked={a.status === "done"} aria-label={t("mentorPage.openActions.doneAria", { title: a.title })} className="mt-0.5"
              onCheckedChange={(c) => upd.mutate({ id: a.id, status: c ? "done" : "open" }, { onError: failed })} />
            <label htmlFor={`ma-${a.id}`} className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{personName(a.student)}</span>: {a.title}
              <span className="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
                {a.owner === "mentor" && <span>{t("mentorPage.openActions.onMentor")}</span>}
                {a.dueOn && <span className={cn(a.overdue && "font-medium text-down")}>{t("shared.due", { date: fmtYmd(a.dueOn) })}{a.overdue ? ` · ${t("mentorPage.openActions.overdue")}` : ""}</span>}
              </span>
            </label>
            <Button size="sm" variant="ghost" disabled={upd.isPending} aria-label={t("mentorPage.openActions.dropAria", { title: a.title })}
              onClick={() => upd.mutate({ id: a.id, status: "dropped" }, {
                onSuccess: () => toast({ title: t("mentorPage.openActions.dropped"), description: a.title }),
                onError: failed,
              })}>{t("mentorPage.openActions.drop")}</Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function MeetingLog({ d }: { d: MentorDashboard }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const [all, setAll] = useState(false);
  return (
    <Panel title={t("mentorPage.log.title")} icon={MessagesSquare} description={t("mentorPage.log.description")}>
      {d.meetings.length === 0 && <p className="text-sm text-muted-foreground">{t("mentorPage.log.empty")}</p>}
      <ul className="flex flex-col gap-2">
        {d.meetings.slice(0, all ? undefined : 12).map((m) => (
          <li key={m.id} className="glass-field rounded-xl px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <b className="tabular-nums">{dateTimeLocal(m.metAt)}</b>
              <span className="font-medium">{personName(m.student)}</span>
              <span className="text-xs text-muted-foreground">{t("mentorPage.log.with", { mentor: personName(m.mentor), format: meetingFormatLabel(m.format, true) })}</span>
            </div>
            {m.agenda && <p className="mt-1 text-muted-foreground">{m.agenda}</p>}
          </li>
        ))}
      </ul>
      {d.meetings.length > 12 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-2 text-xs text-primary hover:underline">
          {all ? ct("actions.collapse") : t("mentorPage.detail.showAll", { n: d.meetings.length })}
        </button>
      )}
    </Panel>
  );
}
