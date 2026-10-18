import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Check, ExternalLink } from "lucide-react";
import { Pill } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { fmtDate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { eodI18n } from "@/i18n/ns/eod";
import { personName } from "@/i18n";
import { useJournalRange } from "@/components/journal/use-journal-days";
import { eodApi, hoursText, slaText, useBrokerDaily, useEodDay, useEodMutation, type QueueItem } from "./eod-api";
import { EodDayReadOnly } from "./EodDayReadOnly";

const SCORE_KEYS = ["none", "formal", "ok", "good", "exemplary"] as const;

/** Curator review of one closed day: read-only day + comment + score 1–5, «Сохранить и следующий». */
export function EodReviewSheet({ item, onClose, onNext }: { item: QueueItem | null; onClose: () => void; onNext: (n: QueueItem | null) => void }) {
  const { toast } = useToast();
  const { t } = eodI18n.useT();
  const { t: tc } = commonI18n.useT();
  const SCORE_HINT = SCORE_KEYS.map((k) => t(`sheet.score.${k}`));
  const open = !!item;
  const dayQ = useEodDay(item?.trader ?? "", item?.date ?? "", open);
  const brokerQ = useBrokerDaily(item?.trader ?? "", item?.date ?? "", open);
  const journalQ = useJournalRange(item?.trader ?? "", item?.date ?? "", item?.date ?? "", open && !!item?.trader);
  const journal = journalQ.entries.find((e) => e.trader === item?.trader && e.date === item?.date) ?? null;
  const reviewed = !!item?.reviewedAt || dayQ.data?.status === "reviewed";
  // The loaded day is the source of truth (callers outside the queue, e.g. the curator cabinet, don't know the count).
  const tradesN = dayQ.data?.trades?.length ?? item?.trades ?? 0;
  const [comment, setComment] = useState("");
  const [score, setScore] = useState<number | null>(null);
  useEffect(() => {
    setComment(dayQ.data?.day?.curatorComment ?? "");
    setScore(dayQ.data?.day?.curatorScore ?? null);
  }, [item?.id, dayQ.data?.day?.curatorComment, dayQ.data?.day?.curatorScore]);

  const review = useEodMutation((b: { id: number; comment: string; score: number; next: boolean }) =>
    eodApi.curatorReview(b.id, { comment: b.comment, score: b.score }).then((out) => ({ ...out, goNext: b.next })),
  (out) => {
    toast({ title: eodI18n.t("sheet.reviewedToast", { trader: personName(out.day.trader), date: fmtDate(out.day.date, "dayMonth") }) });
    if (out.goNext) onNext(out.next);
    else onClose();
  });

  const submit = (next: boolean) => {
    if (!item || score == null) return;
    if (!comment.trim()) { toast({ title: t("sheet.writeComment"), variant: "destructive" }); return; }
    review.mutate({ id: item.id, comment: comment.trim(), score, next }, {
      onError: (e) => toast({ title: t("sheet.saveFailed"), description: (e as Error).message, variant: "destructive" }),
    });
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-[var(--glass-border)] px-5 py-4 text-left">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {personName(item?.trader)} · {item ? fmtDate(item.date, "long") : ""}
            {item && !reviewed && <Pill tone={item.overdue ? "warn" : "neutral"}>{t("sheet.waiting", { time: hoursText(item.hoursWaiting), sla: slaText(item.hoursWaiting, 24) })}</Pill>}
            {reviewed && <Pill tone="up">{item?.reviewedBy ? t("sheet.reviewedBy", { name: personName(item.reviewedBy) }) : t("sheet.reviewed")}</Pill>}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-3">
            <span>{t("sheet.closedAt", { trades: tc("units.trades", { count: tradesN }), date: item?.closedAt ? fmtDate(item.closedAt, "shortDateTimeSeconds") : "—" })}</span>
            {item && (
              <Link href={links.journalDay(item.date, item.trader)} className="inline-flex items-center gap-1 text-primary hover:underline" onClick={onClose}>
                <ExternalLink className="h-3 w-3" aria-hidden="true" />{t("sheet.openInJournal")}
              </Link>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {dayQ.isLoading ? (
            <div className="space-y-2"><Skeleton className="h-24 w-full rounded-xl" /><Skeleton className="h-40 w-full rounded-xl" /></div>
          ) : dayQ.data ? (
            <EodDayReadOnly data={dayQ.data} broker={brokerQ.data ?? null} journal={journal} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("sheet.notFound")}</p>
          )}
        </div>

        <div className="space-y-3 border-t border-[var(--glass-border)] px-5 py-4">
          <div className="flex items-center justify-between gap-2">
            <span id="eod-score" className="text-xs text-muted-foreground">{t("sheet.scoreLabel")}</span>
            <span className="text-xs font-medium">{score != null ? SCORE_HINT[score - 1] : "—"}</span>
          </div>
          <div role="group" aria-labelledby="eod-score" className="glass-field flex items-center gap-0.5 p-1">
            {SCORE_HINT.map((l, i) => {
              const v = i + 1;
              const active = score === v;
              return (
                <button key={l} type="button" aria-pressed={active} aria-label={`${v} — ${l}`} title={l} onClick={() => setScore(v)}
                  className={cn("min-h-7 flex-1 rounded-full text-xs font-semibold tabular-nums transition-colors",
                    active ? v <= 2 ? "bg-down/20 text-down" : v === 3 ? "bg-primary/20 text-primary" : "bg-up/20 text-up" : "text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground")}>
                  {v}
                </button>
              );
            })}
          </div>
          <Textarea
            aria-label={t("sheet.commentAria")}
            value={comment}
            maxLength={4000}
            placeholder={t("sheet.commentPlaceholder")}
            onChange={(e) => setComment(e.target.value)}
            className="min-h-[90px] leading-relaxed"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" disabled={score == null || review.isPending} onClick={() => submit(false)}>
              <Check aria-hidden="true" />{reviewed ? t("sheet.update") : tc("actions.save")}
            </Button>
            {!reviewed && (
              <Button size="sm" disabled={score == null || review.isPending} onClick={() => submit(true)}>
                {t("sheet.saveNext")}<ArrowRight aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
