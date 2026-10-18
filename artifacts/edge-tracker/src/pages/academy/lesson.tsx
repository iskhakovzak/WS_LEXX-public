import { useEffect, useMemo, useRef } from "react";
import { Link, useSearch } from "wouter";
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, Circle, Clock, Eye, Layers, Loader2, PencilRuler } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, Page, PageHeader, Panel, Pill } from "@/components/ds";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import {
  kindLabel, api, useAcademyMeta, useAcademyMutation, useAssignment, useLesson, useQuiz,
  type ItemKind, type Nav,
} from "@/components/academy/content/api";
import { ApiError } from "@/lib/api/http";
import { Markdown } from "@/components/academy/content/markdown";
import { outlineOf, parseMarkdown, readingMinutes } from "@/components/academy/content/markdown-parse";
import { AttachmentList, KindIcon, VideoPlayer } from "@/components/academy/content/bits";
import { QuizRunner } from "@/components/academy/content/quiz-runner";
import { AssignmentPanel } from "@/components/academy/content/assignment-panel";
import { academyLinks } from "@/components/academy/content/links";
import { DualTime } from "@/components/academy/content/time";
import { academyI18n } from "@/i18n/ns/academy";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

/**
 * /academy/lesson — один элемент программы: ?id=<урок> | ?quiz=<тест> | ?assignment=<задание>
 * (&submission=<сдача> подсвечивает сдачу из уведомления, &user=<ученик> — staff смотрит глазами ученика).
 * Слева — оглавление программы (nav.outline), снизу — «назад / дальше».
 */

/** One translated sentence with a bold name inside: the key carries `{name}`, filled with a slot marker and split here. */
const NAME_SLOT = "\u0000";
function withName(text: string, name: React.ReactNode): React.ReactNode {
  const [before, after = ""] = text.split(NAME_SLOT);
  return <>{before}{name}{after}</>;
}

function useTarget(): { kind: ItemKind; id: number } | null {
  const search = useSearch();
  return useMemo(() => {
    const p = new URLSearchParams(search);
    for (const [kind, key] of [["lesson", "id"], ["quiz", "quiz"], ["assignment", "assignment"]] as const) {
      const n = Number(p.get(key));
      if (Number.isInteger(n) && n > 0) return { kind, id: n };
    }
    return null;
  }, [search]);
}

export default function AcademyLesson() {
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const target = useTarget();
  const { isCurator } = useAuth();
  const meta = useAcademyMeta();
  const staff = isCurator || !!meta.data?.staff;
  const viewUser = staff ? params.get("user") ?? undefined : undefined;
  const submission = Number(params.get("submission")) || null;
  const { t } = academyI18n.useT();

  if (!target) {
    return (
      <Page>
        <Panel>
          <EmptyState icon={BookOpen} title={t("lesson.noTarget")} description={t("lesson.noTargetDesc")} action={<Button asChild><Link href={academyLinks.learn()}>{t("lesson.toCourses")}</Link></Button>} />
        </Panel>
      </Page>
    );
  }
  return (
    <Page>
      {target.kind === "lesson" && <LessonView id={target.id} user={viewUser} staff={staff} />}
      {target.kind === "quiz" && <QuizView id={target.id} user={viewUser} staff={staff} />}
      {target.kind === "assignment" && <AssignmentView id={target.id} user={viewUser} staff={staff} focus={submission} />}
    </Page>
  );
}

/* ─── shared chrome ─────────────────────────────────────────────────────── */

function LoadState({ error }: { error: unknown }) {
  const { t } = academyI18n.useT();
  if (!error) return <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]"><Skeleton className="h-80 rounded-2xl" /><Skeleton className="h-[28rem] rounded-2xl" /></div>;
  const status = error instanceof ApiError ? error.status : 0;
  return (
    <Panel>
      <EmptyState
        icon={BookOpen}
        title={status === 404 ? t("lesson.notFound") : t("lesson.loadFailed")}
        description={status === 404 ? t("lesson.notFoundDesc") : (error as Error).message}
        action={<Button asChild><Link href={academyLinks.learn()}>{t("lesson.toCourses")}</Link></Button>}
      />
    </Panel>
  );
}

function OutlineNav({ nav, current, user }: { nav: Nav; current: { kind: ItemKind; id: number }; user?: string }) {
  const { t } = academyI18n.useT();
  return (
    <nav aria-label={t("lesson.outlineAria")} className="glass-panel sticky top-[var(--sticky-top)] hidden max-h-[calc(100dvh-var(--header-h)-0.75rem-2*var(--sticky-top))] overflow-y-auto rounded-2xl p-3 lg:block">
      <Link href={academyLinks.learn({ program: nav.program.id, user })} className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground hover:text-primary">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />{nav.program.title}
      </Link>
      <ol className="flex flex-col gap-3">
        {nav.outline.map((m, mi) => (
          <li key={m.id}>
            <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{mi + 1}. {m.title}</p>
            <ol className="mt-1 flex flex-col">
              {m.items.map((i) => {
                const active = i.kind === current.kind && i.id === current.id;
                return (
                  <li key={`${i.kind}-${i.id}`}>
                    <Link
                      href={academyLinks.item(i.kind, i.id, { user })}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-[var(--glass-bg)]",
                        active ? "bg-primary/10 font-medium text-primary" : "text-foreground/85",
                      )}
                    >
                      <KindIcon kind={i.kind} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate" title={i.title}>{i.title}</span>
                      {i.draft && <Pill tone="warn">{t("tree.draftShort")}</Pill>}
                    </Link>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** «Дальше: …» after finishing an item — the next step of the program is one click away. */
function NextButton({ next }: { next: NonNullable<Nav["next"]> }) {
  const { t } = academyI18n.useT();
  const short = next.title.length > 32 ? `${next.title.slice(0, 32)}…` : next.title;
  return (
    <Button size="sm" asChild>
      <Link href={academyLinks.item(next.kind, next.id)} title={next.title}>
        {t("lesson.nextUp", { title: short })}<ArrowRight aria-hidden="true" />
      </Link>
    </Button>
  );
}

function PrevNext({ nav, user }: { nav: Nav; user?: string }) {
  const { t } = academyI18n.useT();
  if (!nav.prev && !nav.next) return null;
  return (
    <nav aria-label={t("lesson.adjacentAria")} className="grid gap-3 sm:grid-cols-2">
      {nav.prev ? (
        <Link href={academyLinks.item(nav.prev.kind, nav.prev.id, { user })} className="glass-panel group flex items-center gap-3 rounded-2xl p-4 hover:bg-[var(--glass-hover-bg)]">
          <ArrowLeft className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
          <span className="min-w-0"><span className="block text-xs text-muted-foreground">{t("lesson.prevKind", { kind: kindLabel(nav.prev.kind) })}</span><span className="block truncate font-medium" title={nav.prev.title}>{nav.prev.title}</span></span>
        </Link>
      ) : <span />}
      {nav.next && (
        <Link href={academyLinks.item(nav.next.kind, nav.next.id, { user })} className="glass-panel group flex items-center justify-end gap-3 rounded-2xl p-4 text-right hover:bg-[var(--glass-hover-bg)]">
          <span className="min-w-0"><span className="block text-xs text-muted-foreground">{t("lesson.nextKind", { kind: kindLabel(nav.next.kind) })}</span><span className="block truncate font-medium" title={nav.next.title}>{nav.next.title}</span></span>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
        </Link>
      )}
    </nav>
  );
}

function Shell({ nav, current, user, staff, title, kind, meta, actions, children }: {
  nav: Nav; current: { kind: ItemKind; id: number }; user?: string; staff: boolean;
  title: string; kind: ItemKind; meta?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode;
}) {
  const { t } = academyI18n.useT();
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <OutlineNav nav={nav} current={current} user={user} />
      <div className="flex min-w-0 flex-col gap-4">
        <PageHeader
          title={title}
          icon={kind === "lesson" ? BookOpen : kind === "quiz" ? Layers : PencilRuler}
          description={<>{nav.program.title} · {kindLabel(kind)}</>}
          meta={meta}
          actions={
            <>
              {actions}
              {staff && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={academyLinks.admin({ program: nav.program.id })}><PencilRuler aria-hidden="true" />{t("lesson.inEditor")}</Link>
                </Button>
              )}
            </>
          }
        />
        {user && (
          <p className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
            <Eye className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><span>{withName(t("lesson.viewingAs", { name: NAME_SLOT }), <b>{personName(user)}</b>)}</span>
          </p>
        )}
        {children}
        <PrevNext nav={nav} user={user} />
      </div>
    </div>
  );
}

/* ─── lesson ────────────────────────────────────────────────────────────── */

function LessonView({ id, user, staff }: { id: number; user?: string; staff: boolean }) {
  const q = useLesson(id, user);
  const { toast } = useToast();
  const { t } = academyI18n.useT();
  const toggle = useAcademyMutation((completed: boolean) => api.lessonProgress(id, completed));
  const pinged = useRef<number | null>(null);
  const data = q.data;

  // Auto «started» ping once per lesson open (own progress only; not when staff previews a student).
  useEffect(() => {
    if (!data || user || data.lesson.draft || pinged.current === id || data.progress.startedAt) return;
    pinged.current = id;
    api.lessonProgress(id).catch(() => { /* non-critical */ });
  }, [data, id, user]);

  const blocks = useMemo(() => parseMarkdown(data?.lesson.bodyMd ?? ""), [data?.lesson.bodyMd]);
  const toc = useMemo(() => outlineOf(blocks), [blocks]);

  if (!data) return <LoadState error={q.error} />;
  const { lesson, progress, setups, nav } = data;
  const minutes = lesson.durationMin ?? readingMinutes(lesson.bodyMd);
  const done = progress.completed;

  const onToggle = () =>
    toggle.mutate(!done, {
      onSuccess: () => toast({ title: done ? t("lesson.unmarked") : t("lesson.lessonDone"), description: !done && nav.next ? t("lesson.nextUp", { title: nav.next.title }) : undefined }),
      onError: (e) => toast({ title: commonI18n.t("states.saveFailed"), description: (e as Error).message, variant: "destructive" }),
    });

  return (
    <Shell
      nav={nav}
      current={{ kind: "lesson", id }}
      user={user}
      staff={staff}
      title={lesson.title}
      kind="lesson"
      meta={
        <>
          <span className="inline-flex items-center gap-1 tabular-nums"><Clock className="h-3 w-3" aria-hidden="true" />{t("units.minutesApprox", { count: minutes })}</span>
          {lesson.draft && <Pill tone="warn">{t("lesson.draftHidden")}</Pill>}
          {done ? <Pill tone="up" dot>{t("lesson.completed")}</Pill> : progress.startedAt ? <Pill tone="accent">{t("lesson.started")}</Pill> : null}
          {progress.completedAt && <span>{t("lesson.markedAt")} <DualTime iso={progress.completedAt} /></span>}
        </>
      }
      actions={!user && !lesson.draft ? (
        <>
          <Button variant={done ? "outline" : "default"} size="sm" onClick={onToggle} disabled={toggle.isPending} aria-pressed={done}>
            {toggle.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : done ? <CheckCircle2 aria-hidden="true" /> : <Circle aria-hidden="true" />}
            {done ? t("lesson.completed") : t("lesson.markDone")}
          </Button>
          {done && nav.next && <NextButton next={nav.next} />}
        </>
      ) : undefined}
    >
      {lesson.summary && <p className="text-sm text-muted-foreground">{lesson.summary}</p>}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_220px]">
        <div className="flex min-w-0 flex-col gap-4">
          {lesson.video && <VideoPlayer video={lesson.video} title={lesson.title} />}
          <Panel>
            <Markdown blocks={blocks} />
          </Panel>
          {lesson.attachments.length > 0 && (
            <Panel title={t("lesson.materials")}>
              <AttachmentList items={lesson.attachments} />
            </Panel>
          )}
          {(setups.length > 0 || lesson.setupNames.length > 0) && (
            <Panel title={t("lesson.setups")} description={t("lesson.setupsDesc")}>
              <ul className="flex flex-wrap gap-2">
                {setups.map((s) => (
                  <li key={s.id}>
                    <Link href={links.setup(s.id)} className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-sm hover:border-primary/60 hover:text-primary">
                      {s.name}{s.trader && <span className="text-xs text-muted-foreground">· {personName(s.trader)}</span>}
                    </Link>
                  </li>
                ))}
                {lesson.setupNames.filter((n) => !setups.some((s) => s.name.toLowerCase() === n.toLowerCase())).map((n) => (
                  <li key={n}>
                    <Link href={links.trades({ setup: n })} className="inline-flex items-center rounded-full border border-dashed border-border/60 px-3 py-1 text-sm text-muted-foreground hover:text-primary" title={t("lesson.setupTrades")}>
                      {n}
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
        {toc.length > 1 && (
          <nav aria-label={t("lesson.tocAria")} className="glass-panel sticky top-[var(--sticky-top)] hidden rounded-2xl p-3 xl:block">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("lesson.inLesson")}</p>
            <ol className="mt-1 flex flex-col">
              {toc.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`} className={cn("block truncate rounded-md px-2 py-1 text-sm text-foreground/80 hover:bg-[var(--glass-bg)] hover:text-primary", h.level === 3 && "pl-5 text-xs")}>{h.text}</a>
                </li>
              ))}
            </ol>
          </nav>
        )}
      </div>
    </Shell>
  );
}

/* ─── quiz ──────────────────────────────────────────────────────────────── */

function QuizView({ id, user, staff }: { id: number; user?: string; staff: boolean }) {
  const q = useQuiz(id, user);
  const { t } = academyI18n.useT();
  if (!q.data) return <LoadState error={q.error} />;
  const d = q.data;
  return (
    <Shell
      nav={d.nav}
      current={{ kind: "quiz", id }}
      user={user}
      staff={staff}
      title={d.quiz.title}
      kind="quiz"
      meta={
        <>
          <span className="tabular-nums">{t("units.questions", { count: d.quiz.questions.length })} · {t("lesson.passFrom", { pct: d.quiz.passPct })} · {d.quiz.maxAttempts ? t("lesson.attemptsN", { count: d.quiz.maxAttempts }) : t("lesson.attemptsUnlimited")}</span>
          {d.quiz.draft && <Pill tone="warn">{commonI18n.t("states.draft")}</Pill>}
          {d.state.passed && <Pill tone="up" dot>{t("lesson.passed")}</Pill>}
        </>
      }
    >
      {d.quiz.description && <Panel><Markdown source={d.quiz.description} /></Panel>}
      <QuizRunner data={d} canAnswer={!user && !d.quiz.draft} />
    </Shell>
  );
}

/* ─── assignment ────────────────────────────────────────────────────────── */

function AssignmentView({ id, user, staff, focus }: { id: number; user?: string; staff: boolean; focus: number | null }) {
  // Staff opening from the review queue / a notification (no ?user) sees every student's submissions.
  const all = staff && !user;
  const q = useAssignment(id, user, all);
  const { t } = academyI18n.useT();
  if (!q.data) return <LoadState error={q.error} />;
  const d = q.data;
  return (
    <Shell
      nav={d.nav}
      current={{ kind: "assignment", id }}
      user={user}
      staff={staff}
      title={d.assignment.title}
      kind="assignment"
      meta={
        <>
          <span className="tabular-nums">{t("lesson.passFrom", { pct: d.assignment.passPct })}{d.assignment.minTrades ? ` · ${t("lesson.minTradesMeta", { count: d.assignment.minTrades })}` : ""}</span>
          {d.assignment.draft && <Pill tone="warn">{commonI18n.t("states.draft")}</Pill>}
        </>
      }
    >
      <AssignmentPanel data={d} canSubmit={!user && !d.assignment.draft} staff={staff} focusSubmission={focus} />
    </Shell>
  );
}
