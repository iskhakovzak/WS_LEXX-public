import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { BarChart3, BookOpenCheck, Database, GraduationCap, Inbox, Loader2, PencilRuler } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, Page, PageHeader, Panel, SectionTabs, Toolbar } from "@/components/ds";
import { api, invalidateAcademy, useAcademyMeta, useProgramTree, usePrograms } from "@/components/academy/content/api";
import { ProgramCard, ProgramOutline } from "@/components/academy/content/program-view";
import { ReviewQueue } from "@/components/academy/content/review-queue";
import { ProgressMatrix } from "@/components/academy/content/progress-matrix";
import { academyLinks } from "@/components/academy/content/links";
import { PersonSelect } from "@/components/people/person-select";
import { academyI18n } from "@/i18n/ns/academy";
import { commonI18n } from "@/i18n/ns/common";
import { shellI18n } from "@/i18n/ns/shell";
import { comparePersonNames, personName } from "@/i18n";

/**
 * /academy/learn — «Обучение»: каталог программ с прогрессом, дерево модулей выбранной программы,
 * для наставников — очередь проверки заданий и прогресс учеников/когорт.
 * URL: ?program=<id>&tab=catalog|review|progress&user=<ученик> (staff смотрит прогресс глазами ученика).
 */

type Tab = "catalog" | "review" | "progress";
const SEED_KEYS = ["programs", "modules", "lessons", "quizzes", "assignments"] as const;
/** «уроков: 6, тестов: 2» from the seed response (unknown keys are shown as is). */
const seedSummary = (created: Record<string, number>) =>
  Object.entries(created).filter(([, n]) => n).map(([k, n]) => {
    const key = SEED_KEYS.find((x) => x === k);
    return key ? academyI18n.t(`learn.seedCount.${key}`, { count: n }) : `${k}: ${n}`;
  }).join(", ");
const ME = "__me__";
const cohortFormat = (f: string) => (f === "office" || f === "remote" || f === "hybrid" ? academyI18n.t(`learn.cohortFormat.${f}`) : f);
const ALL = "__all__";

export default function AcademyLearn() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const { isCurator, dbUsers } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { t } = academyI18n.useT();
  const meta = useAcademyMeta();
  const staff = isCurator || !!meta.data?.staff;

  const tabParam = params.get("tab");
  const tab: Tab = staff && (tabParam === "review" || tabParam === "progress") ? tabParam : "catalog";
  const viewUser = staff ? params.get("user") ?? "" : "";
  const programParam = Number(params.get("program")) || null;

  const setParams = (patch: Record<string, string | number | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, String(v));
    }
    const s = next.toString();
    navigate(`/academy/learn${s ? `?${s}` : ""}`, { replace: true });
  };

  const programs = usePrograms(viewUser || undefined);
  const list = programs.data?.programs ?? [];
  const selectedId = programParam && list.some((p) => p.id === programParam) ? programParam : list[0]?.id ?? null;
  const tree = useProgramTree(tab === "catalog" ? selectedId : null, viewUser || undefined);

  // undefined = not chosen yet → default to the viewer's own cohort when they mentor exactly one.
  const [cohortPick, setCohortId] = useState<number | null | undefined>(undefined);
  const [progressProgram, setProgressProgram] = useState<number | null>(null);
  useEffect(() => { if (!progressProgram && selectedId) setProgressProgram(selectedId); }, [selectedId, progressProgram]);

  const traders = useMemo(
    () => dbUsers.filter((u) => u.active && !u.banned && u.role !== "guest").map((u) => u.name).sort(comparePersonNames).map((n) => ({ value: n, label: personName(n) })),
    [dbUsers],
  );

  const [seeding, setSeeding] = useState(false);
  const seed = async () => {
    setSeeding(true);
    try {
      const r = await api.seedDemo();
      toast({ title: r.alreadySeeded ? t("learn.demoAlready") : t("learn.demoLoaded"), description: seedSummary(r.created) || t("learn.noNewItems") });
      await invalidateAcademy(qc);
      setParams({ program: r.programId });
    } catch (e) {
      toast({ title: t("learn.demoFailed"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setSeeding(false);
    }
  };

  const pending = meta.data?.pendingReviews ?? 0;
  const cohorts = meta.data?.cohorts ?? [];
  const ownCohorts = cohorts.filter((c) => c.mentor && c.mentor === meta.data?.me);
  const cohortId = cohortPick !== undefined ? cohortPick : ownCohorts.length === 1 ? ownCohorts[0].id : null;

  const cohortSelect = meta.data?.cohortsAvailable ? (
    <Select value={cohortId ? String(cohortId) : ALL} onValueChange={(v) => setCohortId(v === ALL ? null : Number(v))}>
      <SelectTrigger className="h-9 w-full rounded-full sm:w-[220px]" aria-label={t("learn.cohort")}><SelectValue placeholder={t("learn.allCohorts")} /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t("learn.allStudents")}</SelectItem>
        {cohorts.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}{c.format ? ` · ${cohortFormat(c.format)}` : ""}</SelectItem>)}
      </SelectContent>
    </Select>
  ) : null;

  return (
    <Page>
      <PageHeader
        title={shellI18n.t("nav.academyLearn")}
        icon={GraduationCap}
        description={t("learn.description")}
        actions={staff ? (
          <>
            <Button variant="outline" asChild><Link href={academyLinks.admin({ program: selectedId ?? undefined })}><PencilRuler aria-hidden="true" />{t("learn.contentEditor")}</Link></Button>
          </>
        ) : undefined}
      >
        {staff && (
          <SectionTabs
            ariaLabel={t("learn.tabsAria")}
            value={tab}
            onChange={(v) => setParams({ tab: v === "catalog" ? null : v })}
            tabs={[
              { value: "catalog", label: t("learn.tabCourses"), icon: BookOpenCheck },
              { value: "review", label: t("learn.tabReview"), icon: Inbox, count: pending || undefined },
              { value: "progress", label: t("learn.tabProgress"), icon: BarChart3 },
            ]}
          />
        )}
      </PageHeader>

      {tab === "catalog" && (
        <>
          {staff && (
            <Toolbar>
              <span className="px-2 text-sm text-muted-foreground">{t("learn.viewAs")}</span>
              <PersonSelect value={viewUser || ME} onValueChange={(v) => setParams({ user: v === ME ? null : v })} allValue={ME} allLabel={t("learn.mePreview")} options={traders} ariaLabel={t("learn.whoseAria")} className="h-9 w-full sm:w-[220px]" />
            </Toolbar>
          )}

          {programs.isLoading ? (
            <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]"><Skeleton className="h-48 rounded-2xl" /><Skeleton className="h-96 rounded-2xl" /></div>
          ) : programs.isError ? (
            <Panel><p className="text-sm text-down">{t("learn.coursesFailed", { message: (programs.error as Error).message })}</p></Panel>
          ) : !list.length ? (
            <Panel>
              <EmptyState
                icon={GraduationCap}
                title={t("learn.noCourses")}
                description={staff ? t("learn.noCoursesStaff") : t("learn.noCoursesStudent")}
                action={staff ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={seed} disabled={seeding}>{seeding ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Database aria-hidden="true" />}{t("learn.loadDemo")}</Button>
                    <Button variant="outline" asChild><Link href={academyLinks.admin()}>{t("learn.openEditor")}</Link></Button>
                  </div>
                ) : undefined}
              />
            </Panel>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
              <nav aria-label={t("learn.programsAria")} className="flex flex-col gap-3">
                {list.map((p) => <ProgramCard key={p.id} p={p} active={p.id === selectedId} onSelect={() => setParams({ program: p.id })} />)}
              </nav>
              <div className="min-w-0">
                {tree.isError ? (
                  <Panel>
                    <EmptyState
                      icon={BookOpenCheck}
                      title={t("learn.programFailed")}
                      description={(tree.error as Error | null)?.message ?? commonI18n.t("states.tryAgain")}
                      action={<Button variant="outline" onClick={() => void tree.refetch()} disabled={tree.isFetching}>{commonI18n.t("actions.retry")}</Button>}
                    />
                  </Panel>
                ) : tree.isLoading || !tree.data ? (
                  <Skeleton className="h-96 rounded-2xl" />
                ) : (
                  <ProgramOutline tree={tree.data} user={viewUser || undefined} viewingOther={!!viewUser} />
                )}
              </div>
            </div>
          )}
        </>
      )}

      {tab === "review" && staff && (
        <>
          {cohortSelect && <Toolbar><span className="px-2 text-sm text-muted-foreground">{t("learn.cohort")}</span>{cohortSelect}</Toolbar>}
          <ReviewQueue cohortId={cohortId} />
        </>
      )}

      {tab === "progress" && staff && (
        <>
          <Toolbar>
            <span className="px-2 text-sm text-muted-foreground">{t("learn.program")}</span>
            <Select value={progressProgram ? String(progressProgram) : ""} onValueChange={(v) => setProgressProgram(Number(v))}>
              <SelectTrigger className="h-9 w-full rounded-full sm:w-[280px]" aria-label={t("learn.program")}><SelectValue placeholder={t("learn.pickProgram")} /></SelectTrigger>
              <SelectContent>{list.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.title}</SelectItem>)}</SelectContent>
            </Select>
            {cohortSelect}
          </Toolbar>
          <ProgressMatrix programId={progressProgram} cohortId={cohortId} />
        </>
      )}
    </Page>
  );
}
