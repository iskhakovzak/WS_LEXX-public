/** Mentor review queue: submissions waiting for a grade (oldest first), with inline rubric grading. */
import { useState } from "react";
import { Link } from "wouter";
import { Inbox } from "lucide-react";
import { EmptyState, Panel, Segmented } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useReviewQueue } from "./api";
import { GradeForm, SubmissionCard } from "./assignment-panel";
import { academyLinks } from "./links";
import { daysSince } from "./time";
import { academyI18n } from "@/i18n/ns/academy";
import { commonI18n } from "@/i18n/ns/common";

type Status = "submitted" | "returned" | "graded" | "all";

/** «ждёт 3 дня» / «отправлено сегодня» — how long a submission has been waiting. */
const waiting = (days: number | null) => (days ? academyI18n.t("review.waitingDays", { count: days }) : academyI18n.t("review.sentToday"));

export function ReviewQueue({ cohortId }: { cohortId: number | null }) {
  const { t } = academyI18n.useT();
  const [status, setStatus] = useState<Status>("submitted");
  const [open, setOpen] = useState<number | null>(null);
  const q = useReviewQueue(status, cohortId);
  const items = q.data?.items ?? [];
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        ariaLabel={t("review.statusAria")}
        value={status}
        onChange={setStatus}
        options={[
          { value: "submitted", label: t("review.tabs.submitted") },
          { value: "returned", label: t("review.tabs.returned") },
          { value: "graded", label: t("review.tabs.graded") },
          { value: "all", label: commonI18n.t("states.all") },
        ]}
      />
      {q.isLoading ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : q.isError ? (
        <Panel><p className="text-sm text-down">{t("review.loadFailed", { message: (q.error as Error).message })}</p></Panel>
      ) : !items.length ? (
        <Panel><EmptyState icon={Inbox} title={status === "submitted" ? t("review.emptyTitle") : t("review.nothing")} description={status === "submitted" ? t("review.emptyDesc") : undefined} /></Panel>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((s) => (
            <li key={s.id} className="flex flex-col gap-2">
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>{s.programTitle} · {s.moduleTitle} ·</span>
                <Link href={academyLinks.item("assignment", s.assignmentId, { submission: s.id })} className="font-medium text-foreground hover:text-primary">{s.assignmentTitle}</Link>
                {s.status === "submitted" && <span>· {waiting(daysSince(s.createdAt))}</span>}
              </p>
              <SubmissionCard
                s={s}
                rubric={s.rubric}
                showUser
                actions={
                  <Button size="sm" variant={open === s.id ? "secondary" : "outline"} onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
                    {s.status === "submitted" ? t("review.grade") : t("review.regrade")}
                  </Button>
                }
              />
              {open === s.id && <GradeForm submission={s} rubric={s.rubric} passPct={s.passPct} onDone={() => setOpen(null)} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
