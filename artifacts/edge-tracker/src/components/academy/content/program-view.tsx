/** Catalog cards and the module/item outline of one program (with per-item status for the viewed student). */
import { Link } from "wouter";
import { ArrowRight, Clock, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, Pill, ProgressRing } from "@/components/ds";
import { cn } from "@/lib/utils";
import { kindLabel, stageLabel, type CatalogProgram, type ProgramTree, type TreeItem } from "./api";
import { KindIcon, PctBar, StatusIcon, SubmissionPill } from "./bits";
import { academyLinks } from "./links";
import { academyI18n } from "@/i18n/ns/academy";
import { commonI18n } from "@/i18n/ns/common";

export function ProgramCard({ p, active, onSelect }: { p: CatalogProgram; active: boolean; onSelect: () => void }) {
  const { t } = academyI18n.useT();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "glass-panel flex w-full items-start gap-3 rounded-2xl p-4 text-left transition-colors hover:bg-[var(--glass-hover-bg)]",
        active && "ring-1 ring-primary/60",
      )}
    >
      <ProgressRing value={p.progress.pct} size={48} stroke={5} tone={p.progress.pct >= 100 ? "up" : "accent"} ariaLabel={t("program.progressAria", { pct: Math.round(p.progress.pct) })} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold text-foreground">{p.title}</span>
          {p.stage && <Pill tone="purple">{stageLabel(p.stage)}</Pill>}
          {!p.published && <Pill tone="warn">{commonI18n.t("states.draft")}</Pill>}
        </span>
        {p.description && <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{p.description}</span>}
        <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
          <span>{commonI18n.t("units.lessons", { count: p.counts.lessons })}</span>
          <span>{t("units.quizzes", { count: p.counts.quizzes })}</span>
          <span>{t("units.assignments", { count: p.counts.assignments })}</span>
          {p.durationMin > 0 && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" aria-hidden="true" />{t("units.minutesApprox", { count: p.durationMin })}</span>}
          <span>{t("program.doneOf", { done: p.progress.done, total: p.progress.total })}</span>
        </span>
      </span>
    </button>
  );
}

function itemMeta(i: TreeItem): string {
  const t = academyI18n.t;
  const parts: string[] = [kindLabel(i.kind)];
  if (i.kind === "lesson" && i.durationMin) parts.push(commonI18n.t("time.minutesShort", { count: i.durationMin }));
  if (i.kind === "lesson" && i.hasVideo) parts.push(t("program.video"));
  if (i.kind === "quiz") { if (i.questionCount) parts.push(t("units.questions", { count: i.questionCount })); if (i.passPct != null) parts.push(t("program.passAt", { pct: i.passPct })); }
  if (i.kind === "assignment" && i.minTrades) parts.push(t("program.fromTrades", { count: i.minTrades }));
  return parts.join(" · ");
}

export function ProgramOutline({ tree, user, viewingOther }: { tree: ProgramTree; user?: string; viewingOther: boolean }) {
  const { t } = academyI18n.useT();
  const next = tree.progress.next;
  const linkUser = viewingOther ? user : undefined;
  const bk = tree.progress.byKind;
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <div className="flex flex-wrap items-center gap-4">
          <ProgressRing value={tree.progress.pct} size={64} stroke={6} tone={tree.progress.pct >= 100 ? "up" : "accent"} ariaLabel={t("program.progressProgram")} />
          {/* Keeps the text readable: the «Начать: …» button wraps under it instead of squeezing it into a narrow column. */}
          <div className="min-w-[min(100%,20rem)] flex-1">
            <h2 className="text-lg font-semibold text-foreground">{tree.program.title}</h2>
            {tree.program.description && <p className="mt-0.5 text-sm text-muted-foreground">{tree.program.description}</p>}
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {viewingOther && <>{t("program.studentLabel")} <b className="text-foreground">{tree.user}</b> · </>}
              {t("program.byKind", { lessons: `${bk.lesson.done}/${bk.lesson.total}`, quizzes: `${bk.quiz.done}/${bk.quiz.total}`, assignments: `${bk.assignment.done}/${bk.assignment.total}` })}
            </p>
          </div>
          {next ? (
            <Button asChild>
              <Link href={academyLinks.item(next.kind, next.id, { user: linkUser })} title={next.title}>
                <PlayCircle aria-hidden="true" />
                {t(tree.progress.done ? "program.continueWith" : "program.startWith", { title: next.title.length > 36 ? `${next.title.slice(0, 36)}…` : next.title })}
              </Link>
            </Button>
          ) : tree.progress.total > 0 ? (
            <Pill tone="up" dot>{t("program.completed")}</Pill>
          ) : null}
        </div>
      </Panel>

      {tree.modules.map((m, mi) => (
        <Panel
          key={m.id}
          title={<span>{t("program.moduleTitle", { n: mi + 1, title: m.title })}</span>}
          description={m.description ?? undefined}
          actions={m.progress && m.progress.total > 0 ? (
            <span className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
              <PctBar pct={m.progress.pct} className="w-24" label={t("program.moduleProgress", { title: m.title })} />{m.progress.done}/{m.progress.total}
            </span>
          ) : undefined}
        >
          {!m.items.length ? (
            <p className="text-sm text-muted-foreground">{t("program.moduleEmpty")}</p>
          ) : (
            <ol className="flex flex-col divide-y divide-border/50">
              {m.items.map((i) => (
                <li key={`${i.kind}-${i.id}`}>
                  <Link
                    href={academyLinks.item(i.kind, i.id, { user: linkUser })}
                    className="group flex items-center gap-3 rounded-lg px-1 py-2.5 transition-colors hover:bg-[var(--glass-bg)]"
                  >
                    <StatusIcon status={i.status} />
                    <KindIcon kind={i.kind} className="text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-foreground group-hover:text-primary">{i.title}</span>
                        {i.draft && <Pill tone="warn">{commonI18n.t("states.draft")}</Pill>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground" title={i.kind === "lesson" && i.summary ? i.summary : undefined}>{itemMeta(i)}{i.kind === "lesson" && i.summary ? ` — ${i.summary}` : ""}</span>
                    </span>
                    {i.kind === "quiz" && i.bestPct != null && <Pill tone={i.status === "completed" ? "up" : "down"}>{Math.round(i.bestPct)}%</Pill>}
                    {i.kind === "assignment" && i.submission && <SubmissionPill status={i.submission.status} passed={i.submission.passed} />}
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      ))}
    </div>
  );
}
