import { useState } from "react";
import { CheckCheck, ClipboardCheck, Flame, Lock, LockOpen } from "lucide-react";
import { Pill } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { commonI18n } from "@/i18n/ns/common";
import { eodI18n } from "@/i18n/ns/eod";
import { STATUS_LABEL, queueItemFromDay, useEodDay, type EodStatus, type QueueItem } from "./eod-api";
import { EodReviewSheet } from "./EodReviewSheet";

function statusTone(s: EodStatus): "up" | "accent" | "neutral" {
  return s === "reviewed" ? "up" : s === "closed" ? "accent" : "neutral";
}

/**
 * Compact EOD status for the day header: «День открыт / закрыт / проверен», the close streak,
 * and for the curator a «Проверить» button that opens the review sheet right from the day.
 */
export function EodStatusBadge({
  trader, date, today, canReview,
}: { trader: string; date: string; today: string; canReview: boolean }) {
  const { t } = eodI18n.useT();
  const dayQ = useEodDay(trader, date, !!trader && date <= today);
  const [item, setItem] = useState<QueueItem | null>(null);
  const d = dayQ.data;
  if (!trader || !d) return null;
  const s = d.streaks;
  const Icon = d.status === "reviewed" ? CheckCheck : d.status === "closed" ? Lock : LockOpen;
  const reviewItem = canReview ? queueItemFromDay(d) : null;
  return (
    <>
      <Pill tone={statusTone(d.status)}>
        <Icon className="h-3 w-3" aria-hidden="true" />{STATUS_LABEL[d.status]}
        {d.status === "reviewed" && d.day?.curatorScore != null ? ` · ${d.day.curatorScore}/5` : ""}
      </Pill>
      {s.closedStreak > 1 && (
        <Pill tone={s.closedStreak >= 5 ? "up" : "neutral"} title={t("badge.streakTitle", { total: s.closedTotal })}>
          <Flame className="h-3 w-3" aria-hidden="true" />{t("badge.streak", { days: commonI18n.t("units.days", { count: s.closedStreak }) })}
        </Pill>
      )}
      {reviewItem && (
        <Button size="sm" variant={d.status === "closed" ? "default" : "outline"} onClick={() => setItem(reviewItem)}>
          <ClipboardCheck aria-hidden="true" />{d.status === "closed" ? t("badge.review") : t("badge.editReview")}
        </Button>
      )}
      <EodReviewSheet item={item} onClose={() => setItem(null)} onNext={(n) => setItem(n)} />
    </>
  );
}
