/**
 * Progress per student and per cohort for one program: KPI summary (avg / median / finished / stale) and a
 * students × modules matrix. Students come from F2 enrollments when that table exists (filtered by cohort),
 * otherwise from everyone with activity in the program.
 */
import { useMemo } from "react";
import { Link } from "wouter";
import { Download, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadCsv } from "@/components/analytics-page/metrics";
import { DataTable, EmptyState, Panel, Pill, SortableTh, StatCard, StatGrid, useTableSort } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { stageLabelOf, useProgressMatrix, type ProgressStudent } from "./api";
import { PctBar } from "./bits";
import { academyLinks } from "./links";
import { relativeDays } from "./time";
import { academyI18n } from "@/i18n/ns/academy";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

function cellTone(pct: number, total: number) {
  if (!total) return "text-muted-foreground";
  if (pct >= 100) return "bg-up/15 text-up";
  if (pct > 0) return "bg-primary/10 text-foreground";
  return "text-muted-foreground";
}

type SortKey = "name" | "pct" | "activity" | "pending";

/** Quiz titles often start with «Тест:» (author content) — the column header already says it. */
const stripQuizPrefix = (title: string) => title.replace(/^(Тест|Quiz|Test):\s*/i, ""); // i18n-ignore: matches author-written title prefixes

export function ProgressMatrix({ programId, cohortId }: { programId: number | null; cohortId: number | null }) {
  const { t } = academyI18n.useT();
  const q = useProgressMatrix(programId, cohortId);
  const d = q.data;
  const rows = d?.students ?? [];
  const sorter = useMemo(() => ({
    name: (r: ProgressStudent) => personName(r.userName),
    pct: (r: ProgressStudent) => r.pct,
    activity: (r: ProgressStudent) => r.lastActivity ?? "",
    pending: (r: ProgressStudent) => r.pendingReviews,
  }), []);
  const sort = useTableSort<ProgressStudent, SortKey>(rows, sorter, "pct");

  if (q.isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (q.isError) return <Panel><p className="text-sm text-down">{t("matrix.loadFailed", { message: (q.error as Error).message })}</p></Panel>;
  if (!d?.program) return <Panel><EmptyState icon={Users} title={t("matrix.noPrograms")} description={t("matrix.noProgramsDesc")} /></Panel>;

  const s = d.summary;
  return (
    <div className="flex flex-col gap-4">
      {!d.enrollmentsAvailable && (
        <p className="text-xs text-muted-foreground">{t("matrix.noCohorts")}</p>
      )}
      <StatGrid>
        <StatCard label={t("matrix.students")} value={s.students} />
        <StatCard label={t("matrix.avg")} value={s.avgPct != null ? `${s.avgPct}%` : "—"} hint={s.medianPct != null ? t("matrix.median", { pct: s.medianPct }) : undefined} />
        <StatCard label={t("matrix.finished")} value={s.completed} tone={s.completed ? "up" : "neutral"} />
        <StatCard label={t("matrix.stale")} value={s.stale.length} tone={s.stale.length ? "warn" : "neutral"} hint={s.stale.slice(0, 3).map((n) => personName(n)).join(", ") || undefined} />
      </StatGrid>

      {!rows.length ? (
        <Panel><EmptyState icon={Users} title={t("matrix.noStudents")} description={cohortId ? t("matrix.noStudentsCohort") : t("matrix.noStudentsAll")} /></Panel>
      ) : (
        <Panel padded={false} title={d.program.title} description={t("matrix.tableDesc", { modules: t("units.modules", { count: d.modules.length }) })}
          actions={
            <Button variant="outline" size="sm" className="h-8" title={t("matrix.csvTitle")} onClick={() => {
              const quizzes = d.quizzes ?? [];
              downloadCsv(
                `academy_progress_${d.program!.id}.csv`,
                [t("matrix.student"), t("matrix.stage"), t("matrix.progressPct"), ...d.modules.map((m, i) => t("matrix.moduleShort", { n: i + 1, title: m.title })), ...quizzes.map((qz) => qz.title), t("matrix.pending"), t("matrix.lastActivity"), t("matrix.next")],
                sort.rows.map((r) => [
                  personName(r.userName), stageLabelOf(r.stage), Math.round(r.pct),
                  ...r.modules.map((m) => (m.total ? commonI18n.t("states.ofTotal", { value: m.done, total: m.total }) : "")), // «4/4» would turn into a date in Excel
                  ...quizzes.map((qz) => { const v = r.quizBest[String(qz.id)]; return v == null ? "" : Math.round(v); }),
                  r.pendingReviews, r.lastActivity ?? "", r.next?.title ?? t("matrix.courseDone"),
                ]),
              );
            }}>
              <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />CSV
            </Button>
          }>
          <DataTable ariaLabel={t("matrix.tableAria")} stickyFirstCol maxHeight="65vh">
            <table>
              <thead>
                <tr>
                  <SortableTh {...sort.thProps("name")}>{t("matrix.student")}</SortableTh>
                  <SortableTh {...sort.thProps("pct")}>{t("matrix.progress")}</SortableTh>
                  {d.modules.map((m, i) => <th key={m.id} scope="col" title={m.title} className="max-w-[9rem] truncate">{t("matrix.moduleShort", { n: i + 1, title: m.title })}</th>)}
                  {(d.quizzes ?? []).map((qz) => <th key={qz.id} scope="col" title={qz.title} className="max-w-[10rem] truncate">{t("matrix.quizCol", { title: stripQuizPrefix(qz.title).slice(0, 18) })}</th>)}
                  <SortableTh {...sort.thProps("pending")}>{t("matrix.pending")}</SortableTh>
                  <SortableTh {...sort.thProps("activity")}>{t("matrix.activity")}</SortableTh>
                  <th scope="col">{t("matrix.next")}</th>
                </tr>
              </thead>
              <tbody>
                {sort.rows.map((r) => (
                  <tr key={r.userName}>
                    <td>
                      <Link href={academyLinks.learn({ program: d.program!.id, user: r.userName })} className="font-medium text-foreground hover:text-primary">{personName(r.userName)}</Link>
                      {r.stage && <span className="ml-2 text-xs text-muted-foreground">{stageLabelOf(r.stage)}</span>}
                    </td>
                    <td className="min-w-[9rem]">
                      <div className="flex items-center gap-2">
                        <PctBar pct={r.pct} className="w-20" label={t("matrix.rowProgress", { name: personName(r.userName) })} />
                        <span className="tabular-nums">{Math.round(r.pct)}%</span>
                      </div>
                    </td>
                    {r.modules.map((m) => (
                      <td key={m.moduleId} className="text-center">
                        <span className={cn("inline-block min-w-[3.5rem] rounded-md px-1.5 py-0.5 tabular-nums", cellTone(m.pct, m.total))}>{m.total ? `${m.done}/${m.total}` : "—"}</span>
                      </td>
                    ))}
                    {(d.quizzes ?? []).map((qz) => {
                      const v = r.quizBest[String(qz.id)];
                      return (
                        <td key={qz.id} className="text-center tabular-nums">
                          {v == null ? <span className="text-muted-foreground">—</span> : <Pill tone={qz.passPct != null && v >= qz.passPct ? "up" : "down"}>{Math.round(v)}%</Pill>}
                        </td>
                      );
                    })}
                    <td className="text-center tabular-nums">{r.pendingReviews ? <Pill tone="accent">{r.pendingReviews}</Pill> : <span className="text-muted-foreground">0</span>}</td>
                    <td className={cn("whitespace-nowrap", s.stale.includes(r.userName) && "text-[hsl(var(--chart-3))]")}>{relativeDays(r.lastActivity)}</td>
                    <td className="max-w-[14rem] truncate text-muted-foreground" title={r.next?.title}>{r.next ? r.next.title : <span className="text-up">{t("matrix.courseDone")}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        </Panel>
      )}
    </div>
  );
}
