/** Small shared pieces of the learning UI: item icons/status, video player, attachments, setup → lessons link. */
import { BookOpen, CheckCircle2, CircleDashed, CircleDot, ClipboardCheck, ExternalLink, GraduationCap, ListChecks, Paperclip, PlayCircle } from "lucide-react";
import { Link } from "wouter";
import { Pill, type Tone } from "@/components/ds";
import { cn } from "@/lib/utils";
import { kindLabel, useSetupLessons, type Attachment, type ItemKind, type ItemStatus, type SubmissionStatus, type VideoEmbed } from "./api";
import { academyLinks } from "./links";
import { PROVIDER_LABEL } from "./video";
import { academyI18n } from "@/i18n/ns/academy";
import { commonI18n } from "@/i18n/ns/common";

export const KIND_ICON: Record<ItemKind, typeof BookOpen> = { lesson: BookOpen, quiz: ListChecks, assignment: ClipboardCheck };

export function KindIcon({ kind, className }: { kind: ItemKind; className?: string }) {
  const I = KIND_ICON[kind];
  return <I className={cn("h-4 w-4", className)} aria-label={kindLabel(kind)} />;
}

const STATUS_META: Record<ItemStatus, { tone: Tone; icon: typeof CheckCircle2 }> = {
  completed: { tone: "up", icon: CheckCircle2 },
  in_progress: { tone: "warn", icon: CircleDot },
  not_started: { tone: "neutral", icon: CircleDashed },
};
const statusLabel = (s: ItemStatus) => academyI18n.t(`itemStatus.${s}`);

export function StatusIcon({ status, className }: { status: ItemStatus; className?: string }) {
  const m = STATUS_META[status];
  const I = m.icon;
  return (
    <I
      className={cn("h-4 w-4 shrink-0", status === "completed" ? "text-up" : status === "in_progress" ? "text-[hsl(var(--chart-3))]" : "text-muted-foreground", className)}
      aria-label={statusLabel(status)}
      role="img"
    />
  );
}

export function StatusPill({ status }: { status: ItemStatus }) {
  const m = STATUS_META[status];
  return <Pill tone={m.tone} dot>{statusLabel(status)}</Pill>;
}

export const SUBMISSION_TONE: Record<SubmissionStatus, Tone> = { submitted: "accent", graded: "up", returned: "warn" };

export function SubmissionPill({ status, passed }: { status: SubmissionStatus; passed?: boolean | null }) {
  const { t } = academyI18n.useT();
  if (status === "graded" && passed === false) return <Pill tone="down" dot>{t("submission.failed")}</Pill>;
  return <Pill tone={SUBMISSION_TONE[status]} dot>{status === "graded" ? t("submission.passed") : t(`submission.${status}`)}</Pill>;
}

export function VideoPlayer({ video, title }: { video: VideoEmbed; title: string }) {
  const { t } = academyI18n.useT();
  return (
    <figure className="overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-black/40">
      <div className="relative aspect-video w-full">
        <iframe
          src={video.embedUrl}
          title={t("bits.videoTitle", { title })}
          className="absolute inset-0 h-full w-full"
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </div>
      <figcaption className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />{PROVIDER_LABEL[video.provider]}</span>
        <a href={video.watchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
          {t("bits.openOn", { provider: PROVIDER_LABEL[video.provider] })} <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </figcaption>
    </figure>
  );
}

export function AttachmentList({ items }: { items: Attachment[] }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-col gap-1.5" aria-label={academyI18n.t("bits.attachmentsAria")}>
      {items.map((a, i) => (
        <li key={i}>
          <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" className="glass-field inline-flex max-w-full items-center gap-2 px-3 py-1.5 text-sm hover:text-primary">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{a.title}</span>
            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Drop-in for the trade sheet / playbook card: «Как торговать этот сетап» — lessons linked to a playbook setup
 * (by playbook id, or by setup name). Renders nothing when there are no linked lessons.
 * Usage: <SetupLessonsLink playbookId={trade.playbookId} setup={trade.setup} />
 */
export function SetupLessonsLink({ playbookId, setup, className, compact = false }: { playbookId?: number | null; setup?: string | null; className?: string; compact?: boolean }) {
  const { t } = academyI18n.useT();
  const q = useSetupLessons(playbookId ?? null, setup ?? null);
  const lessons = q.data?.lessons ?? [];
  if (!lessons.length) return null;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {!compact && (
        <p className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" /> {t("bits.setupLessons")}
        </p>
      )}
      <ul className="flex flex-wrap gap-1.5">
        {lessons.slice(0, compact ? 2 : 5).map((l) => (
          <li key={l.id}>
            <Link href={academyLinks.item("lesson", l.id)} className="chip inline-flex min-h-7 items-center gap-1.5 px-2.5 text-xs font-medium" title={`${l.programTitle}${l.summary ? ` — ${l.summary}` : ""}`}>
              <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
              {l.title}
              {l.durationMin ? <span className="tabular-nums text-muted-foreground">{commonI18n.t("time.minutesShort", { count: l.durationMin })}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PctBar({ pct, className, label }: { pct: number; className?: string; label?: string }) {
  const v = Math.max(0, Math.min(100, pct));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-[var(--glass-bg)]", className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-label={label ?? academyI18n.t("bits.progress")}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", v >= 100 ? "bg-up" : "bg-primary")} style={{ width: `${v}%` }} />
    </div>
  );
}

export const toneOfNum = (v: number | null | undefined): Tone => (v == null || v === 0 ? "neutral" : v > 0 ? "up" : "down");
