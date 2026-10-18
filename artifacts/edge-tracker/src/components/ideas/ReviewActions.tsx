import * as React from "react";
import { CheckCircle2, RotateCcw, XCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Pill, type Tone } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { TradeIdea } from "./model";
import { fmtDate } from "@/lib/format";
import { ideasI18n } from "@/i18n/ns/ideas";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

type Decision = "approved" | "needs_work" | "rejected";

const DECISIONS: { key: Decision; icon: React.ElementType; tone: Tone; cls: string }[] = [
  { key: "approved", icon: CheckCircle2, tone: "up", cls: "aria-pressed:bg-up/20 aria-pressed:text-up hover:text-up" },
  { key: "needs_work", icon: RotateCcw, tone: "warn", cls: "aria-pressed:bg-[hsl(var(--chart-3)/0.2)] aria-pressed:text-[hsl(var(--chart-3))] hover:text-[hsl(var(--chart-3))]" },
  { key: "rejected", icon: XCircle, tone: "down", cls: "aria-pressed:bg-down/20 aria-pressed:text-down hover:text-down" },
];

/** Quick-note chips: inserted into the reason the author receives, written in the curator's UI language. */
const QUICK_NOTES = {
  approved: ["plan", "rr", "catalyst"],
  needs_work: ["entry", "stopWide", "noCatalyst", "weakRr", "screenshot"],
  rejected: ["trend", "liquidity", "edge", "duplicate"],
} as const;
const quickNotes = (d: Decision): string[] => QUICK_NOTES[d].map((k) => ideasI18n.tryT(`review.quick.${d}.${k}`) ?? k);

const REVIEW_TONE: Record<string, Tone> = { approved: "up", needs_work: "warn", rejected: "down" };
/** Review verdict label + tone for a stored review_status (undefined for unknown codes). */
export function reviewLabel(status: string): { label: string; tone: Tone } | undefined {
  const tone = REVIEW_TONE[status];
  const label = ideasI18n.tryT(`review.verdict.${status}`);
  return tone && label ? { label, tone } : undefined;
}

/** Current review verdict (visible to everyone). */
export function ReviewVerdict({ idea }: { idea: TradeIdea }) {
  if (!idea.review_status) return null;
  const v = reviewLabel(idea.review_status);
  if (!v) return null;
  return (
    <div className={cn(
      "rounded-xl border p-3 text-sm",
      v.tone === "up" ? "border-up/30 bg-up/10" : v.tone === "down" ? "border-down/30 bg-down/10" : "border-[hsl(var(--chart-3)/0.3)] bg-[hsl(var(--chart-3)/0.1)]",
    )}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={v.tone}><ShieldCheck className="h-3 w-3" aria-hidden="true" />{v.label}</Pill>
        {idea.reviewed_by && <span className="text-xs text-muted-foreground">{personName(idea.reviewed_by)}{idea.reviewed_at ? ` · ${fmtDate(idea.reviewed_at, "dayMonth")}` : ""}</span>}
      </div>
      {idea.review_reason && <p className="mt-1.5 whitespace-pre-wrap text-foreground">{idea.review_reason}</p>}
    </div>
  );
}

/** Curator decision: pick verdict → optional note (quick chips) → confirm. */
export function ReviewActions({
  idea,
  onSubmit,
  pending,
}: {
  idea: TradeIdea;
  onSubmit: (status: Decision, reason: string) => void;
  pending: boolean;
}) {
  const { t } = ideasI18n.useT();
  const [decision, setDecision] = React.useState<Decision | null>(null);
  const [note, setNote] = React.useState("");
  const noteId = React.useId();

  React.useEffect(() => { setDecision(null); setNote(""); }, [idea.id]);

  const addQuick = (q: string) => setNote((n) => (n.includes(q) ? n : n ? `${n.trim()}; ${q}` : q));

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={t("review.groupAria")} className="grid grid-cols-3 gap-2">
        {DECISIONS.map((d) => {
          const Icon = d.icon;
          const current = idea.review_status === d.key;
          return (
            <button
              key={d.key}
              type="button"
              aria-pressed={decision === d.key}
              onClick={() => setDecision(decision === d.key ? null : d.key)}
              className={cn(
                "chip flex min-h-10 flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-xs font-medium sm:flex-row sm:gap-1.5",
                d.cls,
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{t(`review.decision.${d.key}`)}</span>
              {current && <span className="sr-only">{t("review.currentStatus")}</span>}
            </button>
          );
        })}
      </div>

      {decision && (
        <div className="flex flex-col gap-2">
          <label htmlFor={noteId} className="text-xs text-muted-foreground">
            {t(decision === "approved" ? "review.noteApproved" : decision === "needs_work" ? "review.noteNeedsWork" : "review.noteRejected")}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {quickNotes(decision).map((q) => (
              <button key={q} type="button" onClick={() => addQuick(q)} className="chip min-h-7 px-2.5 text-xs">+ {q}</button>
            ))}
          </div>
          <Textarea
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && (decision === "approved" || note.trim())) { e.preventDefault(); onSubmit(decision, note.trim()); } }}
            rows={2}
            maxLength={2000}
            placeholder={t("review.placeholder")}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setDecision(null); setNote(""); }}>{commonI18n.t("actions.cancel")}</Button>
            <Button
              size="sm"
              onClick={() => onSubmit(decision, note.trim())}
              disabled={pending || (decision !== "approved" && !note.trim())}
            >
              {pending ? t("saving") : t(`review.decision.${decision}`)}
            </Button>
          </div>
          {decision !== "approved" && !note.trim() && (
            <p className="text-2xs text-muted-foreground">{t("review.needComment")}</p>
          )}
        </div>
      )}
    </div>
  );
}
