import * as React from "react";
import { AlertCircle, MessageSquareQuote, RefreshCw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ds";
import { cn } from "@/lib/utils";
import {
  SECTION_KEYS, SECTION_META, TRADE_SECTIONS, moodMeta, moodTone, relTime,
  type JuniorNote, type Sections,
} from "./junior-lib";
import { notesI18n } from "@/i18n/ns/notes";
import { commonI18n } from "@/i18n/ns/common";
import { personName, personInitials } from "@/i18n";

/** Wraps case-insensitive matches of `q` in <mark>. */
export function Highlight({ text, q }: { text: string; q?: string }) {
  const needle = q?.trim();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const j = lower.indexOf(n, i);
    if (j < 0) { parts.push(text.slice(i)); break; }
    if (j > i) parts.push(text.slice(i, j));
    parts.push(
      <mark key={k++} className="rounded-sm bg-primary/25 px-0.5 text-foreground">
        {text.slice(j, j + n.length)}
      </mark>,
    );
    i = j + n.length;
  }
  return <>{parts}</>;
}

/** Minimal **bold** renderer for AI output. */
export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="space-y-1 text-sm leading-relaxed">
      {text.split("\n").map((line, i) => {
        if (line.startsWith("**") && line.endsWith("**") && line.length > 4) {
          return <p key={i} className="mt-3 font-semibold text-foreground first:mt-0">{line.slice(2, -2)}</p>;
        }
        const parts = line.split(/\*\*([^*]+)\*\*/g);
        if (parts.length > 1) {
          return (
            <p key={i} className="text-muted-foreground">
              {parts.map((p, j) => (j % 2 === 1 ? <strong key={j} className="font-medium text-foreground">{p}</strong> : p))}
            </p>
          );
        }
        if (!line.trim()) return <div key={i} className="h-1" />;
        return <p key={i} className="text-muted-foreground">{line}</p>;
      })}
    </div>
  );
}

/** Read-only rendering of a note's structured sections. */
export function SectionsView({ sections, q, className }: { sections: Sections; q?: string; className?: string }) {
  const { t } = notesI18n.useT();
  const keys = SECTION_KEYS.filter((k) => sections[k]?.trim());
  if (!keys.length) return <p className="text-sm text-muted-foreground">{t("junior.emptyEntry")}</p>;
  return (
    <div className={cn("space-y-4", className)}>
      {keys.map((k) => (
        <section key={k} className="space-y-1">
          {k !== "free" && (
            <h4 className="micro-label">
              {TRADE_SECTIONS.includes(k) ? t("junior.tradesSection", { title: SECTION_META[k].title }) : SECTION_META[k].title}
            </h4>
          )}
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            <Highlight text={sections[k]!.trim()} q={q} />
          </p>
        </section>
      ))}
    </div>
  );
}

export function MoodPill({ mood }: { mood: string | null | undefined }) {
  const m = moodMeta(mood);
  if (!m) return null;
  return <Pill tone={moodTone(mood)} dot>{m.label}</Pill>;
}

/** 1–5 score as five small stars (read-only). */
export function ScoreStars({ score, className }: { score: number | null | undefined; className?: string }) {
  if (score == null) return null;
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-label={notesI18n.t("junior.score.aria", { score })} role="img">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          aria-hidden="true"
          className={cn("h-3.5 w-3.5", i <= score ? "fill-[hsl(var(--chart-3))] text-[hsl(var(--chart-3))]" : "text-muted-foreground/40")}
        />
      ))}
    </span>
  );
}

/** Interactive 1–5 score picker. */
export function ScorePicker({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const { t } = notesI18n.useT();
  const labels = ["", t("junior.score.labels.s1"), t("junior.score.labels.s2"), t("junior.score.labels.s3"), t("junior.score.labels.s4"), t("junior.score.labels.s5")];
  return (
    <div role="radiogroup" aria-label={t("junior.score.pickerAria")} className="flex flex-wrap items-center gap-1">
      {[1, 2, 3, 4, 5].map((i) => {
        const active = value != null && i <= value;
        return (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={value === i}
            aria-label={`${i} — ${labels[i]}`}
            title={labels[i]}
            onClick={() => onChange(value === i ? null : i)}
            className="grid h-9 w-9 place-items-center rounded-full transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Star
              aria-hidden="true"
              className={cn("h-5 w-5", active ? "fill-[hsl(var(--chart-3))] text-[hsl(var(--chart-3))]" : "text-muted-foreground/60")}
            />
          </button>
        );
      })}
      <span className="ml-1 text-xs text-muted-foreground">{value ? labels[value] : t("junior.score.none")}</span>
    </div>
  );
}

/** Curator's answer card shown to the junior (and in sheets). */
export function FeedbackCard({ note, fresh, className }: { note: JuniorNote; fresh?: boolean; className?: string }) {
  const { t } = notesI18n.useT();
  if (!note.reviewed_at) return null;
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        fresh ? "border-primary/40 bg-primary/10" : "border-[var(--field-border)] bg-[var(--glass-bg)]",
        className,
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <MessageSquareQuote className="h-4 w-4 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold">{t("junior.feedbackTitle")}</span>
        {fresh && <Pill tone="accent" dot>{commonI18n.t("states.new")}</Pill>}
        <ScoreStars score={note.curator_score} className="ml-auto" />
      </div>
      {note.curator_feedback ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{note.curator_feedback}</p>
      ) : (
        <p className="text-sm text-muted-foreground">{t("junior.feedbackNoComment")}</p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        {note.reviewed_by ? personName(note.reviewed_by) : t("junior.mentorFallback")} · {relTime(note.reviewed_at)}
      </p>
    </div>
  );
}

export function LoadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-xl bg-down/10 px-4 py-6 text-center">
      <p className="flex items-center gap-1.5 text-sm text-down">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        {text}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        {commonI18n.t("actions.retry")}
      </Button>
    </div>
  );
}

/** Small round initial avatar. */
export function Initial({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary", className)}
    >
      {personInitials(name).slice(0, 1)}
    </span>
  );
}
