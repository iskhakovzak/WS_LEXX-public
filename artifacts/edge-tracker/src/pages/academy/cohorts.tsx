import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { Archive, CalendarDays, History as HistoryIcon, Pencil, Plus, RotateCcw, Sparkles, UserCheck, UserPlus, Users } from "lucide-react";
import {
  DataTable, EmptyState, ErrorState, ListSkeleton, Page, PageHeader, Panel, PanelSkeleton, Pill, SectionTabs, Segmented, SortableTh, StatCard, StatGrid, useTableSort,
} from "@/components/ds";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { addDays, nyDate } from "@/lib/trading-date";
import { cn } from "@/lib/utils";
import {
  type CohortDetail, type CohortListItem, type Enrollment, type Session, STAGES, attendanceLabel, attendanceTitle, formatLabel, kindLabel, stageLabel, statusLabel,
  useArchiveCohort, useArchiveEnrollment, useArchiveSession, useCohort, useCohorts, useSchedule, useSeedDemo,
} from "@/components/academy/cohorts/api";
import { CohortDialog, EnrollDialog, EnrollmentEditDialog, RosterDialog, SessionDialog } from "@/components/academy/cohorts/dialogs";
import {
  AttendanceSummaryView, DualTime, StagePill, StatusPill, WhereLine, dateTimeLocal, fmtYmd,
} from "@/components/academy/cohorts/shared";
import { fmtRate } from "@/lib/format";
import { academyCohortsI18n } from "@/i18n/ns/academyCohorts";
import { commonI18n } from "@/i18n/ns/common";
import { shellI18n } from "@/i18n/ns/shell";
import { personName } from "@/i18n";

/**
 * /academy/cohorts — управление когортами деска (офис / удалённо / гибрид): состав и ступени
 * (Стажёр → Джун → Трейдер → Сеньор), расписание занятий, посещаемость, история изменений. Правки — только staff;
 * студент видит свои когорты в режиме чтения. ?id=N — открыть когорту.
 */
export default function AcademyCohortsPage() {
  const { t } = academyCohortsI18n.useT();
  const search = useSearch();
  const [archived, setArchived] = useState(false);
  const list = useCohorts(archived);
  const staff = !!list.data?.staff;
  const cohorts = list.data?.cohorts ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(() => Number(new URLSearchParams(search).get("id")) || null);
  useEffect(() => {
    if (!cohorts.length) return;
    if (!selectedId || !cohorts.some((c) => c.id === selectedId)) setSelectedId(cohorts[0].id);
  }, [cohorts, selectedId]);
  const [createOpen, setCreateOpen] = useState(false);
  const seed = useSeedDemo();
  const { toast } = useToast();

  const runSeed = () => seed.mutate(undefined, {
    onSuccess: (r) => {
      const c = r.created ?? {};
      const total = Object.values(c).reduce((s, n) => s + (Number(n) || 0), 0);
      toast({
        title: total ? t("cohortsPage.demoCreated") : t("cohortsPage.demoExists"),
        description: total
          ? t("cohortsPage.demoCreatedDesc", { cohorts: c.cohorts ?? 0, enrollments: c.enrollments ?? 0, sessions: c.sessions ?? 0, goals: c.goals ?? 0 })
          : t("cohortsPage.demoExistsDesc"),
      });
    },
    onError: (e) => toast({ title: t("cohortsPage.demoFailed"), description: e.message, variant: "destructive" }),
  });

  return (
    <Page>
      <PageHeader
        icon={Users}
        title={shellI18n.t("nav.academyCohorts")}
        description={t("cohortsPage.description")}
        actions={<>
          <Segmented ariaLabel={t("cohortsPage.showAria")} value={archived ? "arch" : "live"} onChange={(v) => setArchived(v === "arch")}
            options={[{ value: "live", label: t("cohortsPage.live") }, { value: "arch", label: t("cohortsPage.archive") }]} />
          {staff && <Button onClick={() => setCreateOpen(true)}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />{t("cohortsPage.newCohort")}</Button>}
        </>}
      />
      {list.isError && <ErrorState error={list.error} onRetry={() => list.refetch()} title={t("cohortsPage.loadFailed")} />}
      {list.isLoading && <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]"><Panel><ListSkeleton rows={4} /></Panel><PanelSkeleton height={320} /></div>}
      {list.data && cohorts.length === 0 && (
        <Panel>
          <EmptyState icon={Users} title={archived ? t("cohortsPage.archiveEmpty") : t("cohortsPage.empty")}
            description={staff ? t("cohortsPage.emptyStaff") : t("cohortsPage.emptyStudent")}
            action={staff && !archived ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => setCreateOpen(true)}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />{t("cohortsPage.create")}</Button>
                {/* The demo seed is a one-off setup action: offered only while there is nothing yet (it never duplicates). */}
                <Button variant="outline" onClick={runSeed} disabled={seed.isPending} title={t("cohortsPage.demoTitle")}>
                  <Sparkles className="mr-1 h-4 w-4" aria-hidden="true" />{t("cohortsPage.demo")}
                </Button>
              </div>
            ) : undefined} />
        </Panel>
      )}
      {cohorts.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav aria-label={t("cohortsPage.listAria")} className="flex flex-col gap-2">
            {cohorts.map((c) => <CohortCard key={c.id} c={c} active={c.id === selectedId} onClick={() => setSelectedId(c.id)} />)}
          </nav>
          {selectedId && <Detail id={selectedId} staff={staff} />}
        </div>
      )}
      <CohortDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Page>
  );
}

function CohortCard({ c, active, onClick }: { c: CohortListItem; active: boolean; onClick: () => void }) {
  const { t } = academyCohortsI18n.useT();
  return (
    <button type="button" onClick={onClick} aria-current={active ? "true" : undefined}
      className={cn("glass-panel lift rounded-2xl p-3 text-left", active && "ring-2 ring-primary")}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-foreground" title={c.name}>{c.name}</span>
        <Pill tone={c.format === "office" ? "accent" : c.format === "remote" ? "purple" : "neutral"}>{formatLabel(c.format)}</Pill>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {c.mentor ? t("cohortsPage.mentorBy", { name: personName(c.mentor) }) : t("cohortsPage.noMentor")} · {fmtYmd(c.startsOn)}{c.endsOn ? ` – ${fmtYmd(c.endsOn)}` : ""}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1 text-xs tabular-nums">
        <Pill tone="up">{t("cohortsPage.activeCount", { n: c.counts.active })}</Pill>
        {c.counts.paused > 0 && <Pill tone="warn">{t("cohortsPage.pausedCount", { n: c.counts.paused })}</Pill>}
        {c.counts.graduated > 0 && <Pill tone="accent">{t("cohortsPage.graduatedCount", { n: c.counts.graduated })}</Pill>}
        <Pill tone="neutral">{t("cohortsPage.sessionsCount", { n: c.sessions })}</Pill>
      </div>
    </button>
  );
}

type Tab = "members" | "schedule" | "attendance" | "history";

function Detail({ id, staff }: { id: number; staff: boolean }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const q = useCohort(id);
  const [tab, setTab] = useState<Tab>("members");
  const [editOpen, setEditOpen] = useState(false);
  const archive = useArchiveCohort();
  const { toast } = useToast();
  if (q.isLoading) return <PanelSkeleton height={320} />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} title={t("cohortsPage.openFailed")} />;
  const d = q.data;
  const c = d.cohort;
  const isArchived = !!c.archivedAt;
  const toggleArchive = () => {
    if (!isArchived && !window.confirm(t("cohortsPage.archiveConfirm", { name: c.name }))) return;
    archive.mutate({ id: c.id, restore: isArchived }, {
      onSuccess: () => toast({ title: isArchived ? t("cohortsPage.restored") : t("cohortsPage.archived"), description: c.name }),
      onError: (e) => toast({ title: t("cohortsPage.failed"), description: e.message, variant: "destructive" }),
    });
  };
  const active = d.enrollments.filter((e) => e.status === "active").length;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel title={c.name} icon={Users}
        description={<>
          {formatLabel(c.format)} · {c.mentor ? t("cohortsPage.mentorBy", { name: personName(c.mentor) }) : t("cohortsPage.noMentor")} · {fmtYmd(c.startsOn, true)}{c.endsOn ? ` – ${fmtYmd(c.endsOn, true)}` : ""} · {c.timezone}
          {isArchived && <> · <b>{t("cohortsPage.inArchive")}</b></>}
        </>}
        actions={staff ? <>
          {!isArchived && <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}><Pencil className="mr-1 h-4 w-4" aria-hidden="true" />{ct("actions.edit")}</Button>}
          <Button size="sm" variant="ghost" onClick={toggleArchive} disabled={archive.isPending}>
            {isArchived ? <><RotateCcw className="mr-1 h-4 w-4" aria-hidden="true" />{t("cohortsPage.restore")}</> : <><Archive className="mr-1 h-4 w-4" aria-hidden="true" />{ct("actions.archive")}</>}
          </Button>
        </> : undefined}>
        {(c.description || c.room || c.meetingUrl) && (
          <div className="flex flex-col gap-1">
            {c.description && <p className="text-sm text-muted-foreground">{c.description}</p>}
            <WhereLine mode={c.format === "remote" ? "online" : c.format === "office" ? "office" : "hybrid"} room={c.room} meetingUrl={c.meetingUrl} />
          </div>
        )}
        <StatGrid className="mt-3">
          <StatCard label={t("cohortsPage.statActive")} value={active} hint={t("cohortsPage.statActiveHint", { n: d.enrollments.length })} />
          <StatCard label={t("cohortsPage.statAttendance")} value={fmtRate(d.attendance.rate)} tone={d.attendance.rate == null ? "neutral" : d.attendance.rate >= 0.9 ? "up" : d.attendance.rate >= 0.75 ? "warn" : "down"}
            hint={staff ? t("cohortsPage.hintAll") : t("cohortsPage.hintMine")} />
          <StatCard label={t("cohortsPage.statPunctuality")} value={fmtRate(d.attendance.punctuality)} hint={t("cohortsPage.punctualityHint")} />
          <StatCard label={t("cohortsPage.statSessions")} value={d.sessions.length} />
        </StatGrid>
      </Panel>
      <SectionTabs ariaLabel={t("cohortsPage.tabsAria")} value={tab} onChange={setTab} tabs={[
        { value: "members", label: t("cohortsPage.tabMembers"), icon: Users, count: d.enrollments.length },
        { value: "schedule", label: t("cohortsPage.tabSchedule"), icon: CalendarDays, count: d.sessions.length },
        { value: "attendance", label: t("cohortsPage.tabAttendance"), icon: UserCheck },
        ...(staff ? [{ value: "history" as const, label: t("cohortsPage.tabHistory"), icon: HistoryIcon, count: d.history.length }] : []),
      ]} />
      {tab === "members" && <Members d={d} staff={staff && !isArchived} />}
      {tab === "schedule" && <Schedule d={d} staff={staff && !isArchived} />}
      {tab === "attendance" && <AttendanceTab d={d} />}
      {tab === "history" && staff && <HistoryTab d={d} />}
      {staff && <CohortDialog open={editOpen} onOpenChange={setEditOpen} cohort={c} />}
    </div>
  );
}

type MemberRow = CohortDetail["enrollments"][number];
const STAGE_ORDER: Record<string, number> = { trainee: 0, junior: 1, trader: 2, senior: 3 };
const MEMBER_ACCESSORS = {
  name: (e: MemberRow) => personName(e.userName),
  stage: (e: MemberRow) => STAGE_ORDER[e.stage] ?? 9,
  status: (e: MemberRow) => statusLabel(e.status),
  joined: (e: MemberRow) => e.joinedOn,
  att: (e: MemberRow) => e.attendance?.rate ?? null,
  att30: (e: MemberRow) => e.attendance30?.rate ?? null,
};
const ATT_ACCESSORS = {
  name: (e: MemberRow) => personName(e.userName),
  total: (e: MemberRow) => e.attendance?.total ?? null,
  present: (e: MemberRow) => e.attendance?.present ?? null,
  late: (e: MemberRow) => e.attendance?.late ?? null,
  absent: (e: MemberRow) => e.attendance?.absent ?? null,
  excused: (e: MemberRow) => e.attendance?.excused ?? null,
  unmarked: (e: MemberRow) => e.attendance?.unmarked ?? null,
  rate: (e: MemberRow) => e.attendance?.rate ?? null,
  rate30: (e: MemberRow) => e.attendance30?.rate ?? null,
  streak: (e: MemberRow) => e.attendance?.absentStreak ?? null,
};

function Members({ d, staff }: { d: CohortDetail; staff: boolean }) {
  const { t } = academyCohortsI18n.useT();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [edit, setEdit] = useState<Enrollment | null>(null);
  const archive = useArchiveEnrollment();
  const { toast } = useToast();
  const { rows: members, thProps } = useTableSort(d.enrollments, MEMBER_ACCESSORS, "name", "asc");
  const remove = (e: Enrollment) => {
    if (!window.confirm(t("cohortsPage.members.removeConfirm", { name: personName(e.userName) }))) return;
    archive.mutate(e.id, {
      onSuccess: () => toast({ title: t("cohortsPage.members.removed"), description: personName(e.userName) }),
      onError: (err) => toast({ title: t("cohortsPage.failed"), description: err.message, variant: "destructive" }),
    });
  };
  return (
    <Panel title={t("cohortsPage.members.title")} icon={Users} description={t("cohortsPage.members.description", { ladder: STAGES.map(stageLabel).join(" → ") })}
      actions={staff ? <Button size="sm" onClick={() => setEnrollOpen(true)}><UserPlus className="mr-1 h-4 w-4" aria-hidden="true" />{t("cohortsPage.members.enroll")}</Button> : undefined}>
      {d.enrollments.length === 0 ? <p className="text-sm text-muted-foreground">{t("cohortsPage.members.empty")}</p> : (
        <DataTable ariaLabel={t("cohortsPage.members.tableAria")}>
          <table>
            <thead><tr>
              <SortableTh {...thProps("name")}>{t("cols.student")}</SortableTh>
              <SortableTh {...thProps("stage")}>{t("cols.stage")}</SortableTh>
              <SortableTh {...thProps("status")}>{t("cols.status")}</SortableTh>
              <SortableTh {...thProps("joined")}><span title={t("cohortsPage.members.colSinceTitle")}>{t("cohortsPage.members.colSince")}</span></SortableTh>
              <SortableTh {...thProps("att")} align="right">{t("cohortsPage.members.colAtt")}</SortableTh>
              <SortableTh {...thProps("att30")} align="right"><span title={t("cohortsPage.members.colAtt30Title")}>{t("cohortsPage.members.colAtt30")}</span></SortableTh>
              {staff && <th scope="col"><span className="sr-only">{t("cohortsPage.members.colActions")}</span></th>}
            </tr></thead>
            <tbody>
              {members.map((e) => (
                <tr key={e.id}>
                  <td>
                    {staff ? <Link href={`/academy/mentor?student=${encodeURIComponent(e.userName)}`} className="font-medium text-foreground hover:underline">{personName(e.userName)}</Link>
                      : <span className="font-medium">{personName(e.userName)}</span>}
                    {e.note && <div className="text-xs text-muted-foreground">{e.note}</div>}
                  </td>
                  <td><StagePill stage={e.stage} /></td>
                  <td><StatusPill status={e.status} /></td>
                  <td className="whitespace-nowrap">{fmtYmd(e.joinedOn)}</td>
                  <td className="text-right">{e.attendance ? fmtRate(e.attendance.rate) : "—"}</td>
                  <td className="text-right">{e.attendance30 ? fmtRate(e.attendance30.rate) : "—"}</td>
                  {staff && (
                    <td className="whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEdit(e)}>{t("cohortsPage.members.stageStatus")}</Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(e)} aria-label={t("cohortsPage.members.removeAria", { name: personName(e.userName) })} title={t("cohortsPage.members.removeTitle")}><Archive className="h-4 w-4" /></Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      )}
      {staff && <EnrollDialog open={enrollOpen} onOpenChange={setEnrollOpen} cohort={d.cohort} existing={d.enrollments.map((e) => e.userName)} />}
      <EnrollmentEditDialog open={!!edit} onOpenChange={(v) => { if (!v) setEdit(null); }} enrollment={edit} />
    </Panel>
  );
}

function Schedule({ d, staff }: { d: CohortDetail; staff: boolean }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const [edit, setEdit] = useState<Session | null | undefined>(undefined);
  const [roster, setRoster] = useState<{ sessionId: number; date: string; title: string } | null>(null);
  const archive = useArchiveSession();
  const { toast } = useToast();
  const today = nyDate();
  const [weekOffset, setWeekOffset] = useState(0);
  const from = addDays(today, weekOffset * 7 - 7);
  const to = addDays(from, 20);
  const sched = useSchedule(d.cohort.id, from, to);
  const occ = sched.data?.occurrences ?? [];
  const now = Date.now();
  const removeSession = (s: Session) => {
    if (!window.confirm(t("cohortsPage.schedule.removeConfirm", { title: s.title }))) return;
    archive.mutate(s.id, {
      onSuccess: () => toast({ title: t("cohortsPage.schedule.removed"), description: s.title }),
      onError: (e) => toast({ title: t("cohortsPage.failed"), description: e.message, variant: "destructive" }),
    });
  };
  const byDay = useMemo(() => {
    const m = new Map<string, typeof occ>();
    for (const o of occ) m.set(o.date, [...(m.get(o.date) ?? []), o]);
    return [...m.entries()];
  }, [occ]);
  return (
    <div className="flex flex-col gap-4">
      <Panel title={t("cohortsPage.schedule.title")} icon={CalendarDays} description={t("cohortsPage.schedule.description")}
        actions={staff ? <Button size="sm" onClick={() => setEdit(null)}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />{t("cohortsPage.schedule.add")}</Button> : undefined}>
        {d.sessions.length === 0 && <p className="text-sm text-muted-foreground">{t("cohortsPage.schedule.empty")}</p>}
        <ul className="flex flex-col gap-2">
          {d.sessions.map((s) => (
            <li key={s.id} className="glass-field flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{s.title}</span>
                  <Pill tone="neutral">{kindLabel(s.kind)}</Pill>
                  {s.host && <span className="text-xs text-muted-foreground">{t("cohortsPage.schedule.host", { name: personName(s.host) })}</span>}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {s.ruleText} · {ct("time.minutesShort", { count: s.durationMin })}{s.endDate ? ` · ${ct("time.until", { date: fmtYmd(s.endDate) })}` : ""}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm">
                  {s.next
                    ? <span>{t("cohortsPage.schedule.next")} <DualTime start={s.next.startUtc} end={s.next.endUtc} showDay /></span>
                    : <span className="text-xs text-muted-foreground">{t("cohortsPage.schedule.noRepeat")}</span>}
                  <WhereLine mode={s.mode} room={s.room} meetingUrl={s.meetingUrl} />
                </div>
              </div>
              {staff && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEdit(s)} aria-label={t("cohortsPage.schedule.editAria", { title: s.title })} title={ct("actions.edit")}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => removeSession(s)} aria-label={t("cohortsPage.schedule.removeAria", { title: s.title })} title={t("cohortsPage.schedule.removeTitle")}><Archive className="h-4 w-4" /></Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title={t("cohortsPage.schedule.calendar")} icon={CalendarDays} description={t("cohortsPage.schedule.calendarDesc", { from: fmtYmd(from), to: fmtYmd(to) })}
        actions={<div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => setWeekOffset((w) => w - 1)} aria-label={t("cohortsPage.schedule.prevWeek")} title={t("cohortsPage.schedule.prevWeek")}>←</Button>
          <Button size="sm" variant="outline" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>{ct("time.today")}</Button>
          <Button size="sm" variant="outline" onClick={() => setWeekOffset((w) => w + 1)} aria-label={t("cohortsPage.schedule.nextWeek")} title={t("cohortsPage.schedule.nextWeek")}>→</Button>
        </div>}>
        {sched.isLoading && <ListSkeleton rows={4} dense />}
        {sched.isError && <ErrorState error={sched.error} compact />}
        {sched.data && byDay.length === 0 && <p className="text-sm text-muted-foreground">{t("cohortsPage.schedule.rangeEmpty")}</p>}
        <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
          {byDay.map(([day, list]) => (
            <section key={day} aria-label={fmtYmd(day)} className={cn("glass-field rounded-xl p-2", day === today && "ring-1 ring-primary/60")}>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">{day === today ? t("cohortsPage.schedule.dayToday", { date: fmtYmd(day) }) : fmtYmd(day)}</h3>
              <ul className="flex flex-col gap-1">
                {list.map((o) => {
                  const started = now >= new Date(o.startUtc).getTime() - 10 * 60000;
                  return (
                    <li key={`${o.sessionId}-${o.date}`} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate" title={o.title}><DualTime start={o.startUtc} /> <span className="text-muted-foreground">{o.title}</span></span>
                      {staff && (
                        <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => setRoster({ sessionId: o.sessionId, date: o.date, title: o.title })}
                          title={started ? undefined : t("cohortsPage.schedule.excusedTitle")}>
                          {started ? t("cohortsPage.schedule.marks") : attendanceLabel("excused")}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </Panel>
      {staff && <SessionDialog open={edit !== undefined} onOpenChange={(v) => { if (!v) setEdit(undefined); }} cohort={d.cohort} session={edit ?? null} />}
      <RosterDialog open={!!roster} onOpenChange={(v) => { if (!v) setRoster(null); }} sessionId={roster?.sessionId ?? null} date={roster?.date ?? ""} title={roster?.title} />
    </div>
  );
}

function AttendanceTab({ d }: { d: CohortDetail }) {
  const { t } = academyCohortsI18n.useT();
  const withStats = useMemo(() => d.enrollments.filter((e) => e.attendance), [d.enrollments]);
  const { rows: sorted, thProps } = useTableSort(withStats, ATT_ACCESSORS, "rate", "asc");
  return (
    <Panel title={t("cohortsPage.attendanceTab.title")} icon={UserCheck} description={t("cohortsPage.attendanceTab.description")}>
      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <AttendanceSummaryView s={d.attendance} title={t("cohortsPage.attendanceTab.wholeCohort")} />
        {withStats.length === 0 ? <p className="text-sm text-muted-foreground">{t("cohortsPage.attendanceTab.noData")}</p> : (
          <DataTable ariaLabel={t("cohortsPage.attendanceTab.tableAria")}>
            <table>
              <thead><tr>
                <SortableTh {...thProps("name")}>{t("cols.student")}</SortableTh>
                <SortableTh {...thProps("total")}>{t("cohortsPage.attendanceTab.colTotal")}</SortableTh>
                <SortableTh {...thProps("present")}>{attendanceLabel("present")}</SortableTh>
                <SortableTh {...thProps("late")}>{attendanceLabel("late")}</SortableTh>
                <SortableTh {...thProps("absent")}>{attendanceLabel("absent")}</SortableTh>
                <SortableTh {...thProps("excused")}><span title={attendanceTitle("excused")}>{attendanceLabel("excused")}</span></SortableTh>
                <SortableTh {...thProps("unmarked")}>{t("cohortsPage.attendanceTab.colUnmarked")}</SortableTh>
                <SortableTh {...thProps("rate")}>{t("cohortsPage.attendanceTab.colRate")}</SortableTh>
                <SortableTh {...thProps("rate30")}>{t("cohortsPage.attendanceTab.colRate30")}</SortableTh>
                <SortableTh {...thProps("streak")}>{t("cohortsPage.attendanceTab.colStreak")}</SortableTh>
              </tr></thead>
              <tbody>
                {sorted.map((e) => {
                  const a = e.attendance!;
                  return (
                    <tr key={e.id}>
                      <td className="font-medium">{personName(e.userName)}</td><td>{a.total}</td><td>{a.present}</td><td>{a.late}</td><td>{a.absent}</td><td>{a.excused}</td><td>{a.unmarked}</td>
                      <td className={cn(a.rate != null && (a.rate >= 0.9 ? "text-up" : a.rate >= 0.75 ? "text-warn" : "text-down"))}>{fmtRate(a.rate)}</td>
                      <td>{fmtRate(e.attendance30?.rate ?? null)}</td>
                      <td className={cn(a.absentStreak > 1 && "text-down")}>{a.absentStreak || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTable>
        )}
      </div>
    </Panel>
  );
}

function HistoryTab({ d }: { d: CohortDetail }) {
  const { t } = academyCohortsI18n.useT();
  return (
    <Panel title={t("cohortsPage.history.title")} icon={HistoryIcon} description={t("cohortsPage.history.description")}>
      {d.history.length === 0 && <p className="text-sm text-muted-foreground">{t("cohortsPage.history.empty")}</p>}
      <ol className="flex flex-col divide-y divide-border/50">
        {d.history.map((h) => (
          <li key={h.id} className="flex flex-wrap items-baseline gap-x-3 py-1.5 text-sm">
            <span className="tabular-nums text-muted-foreground">{dateTimeLocal(h.changedAt)}</span>
            <span className="font-medium">{personName(h.userName)}</span>
            {h.fromStage !== h.toStage && h.toStage && <span>{h.fromStage ? stageLabel(h.fromStage) : "—"} → <b>{stageLabel(h.toStage)}</b></span>}
            {h.fromStatus !== h.toStatus && h.toStatus && <span>{h.fromStatus ? statusLabel(h.fromStatus) : "—"} → <b>{statusLabel(h.toStatus)}</b></span>}
            {h.changedBy && <span className="text-xs text-muted-foreground">({personName(h.changedBy)})</span>}
            {h.note && <span className="w-full text-xs text-muted-foreground">{h.note}</span>}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
