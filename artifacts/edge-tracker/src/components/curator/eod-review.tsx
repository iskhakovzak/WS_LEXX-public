import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EodReviewSheet } from "@/components/eod/EodReviewSheet";
import type { QueueItem as EodQueueItem } from "@/components/eod/eod-api";
import { curatorKeys } from "./api";

/** A closed day the curator can review in place (from the «Сегодня» queue or a trader's profile). */
export type EodTarget = { eodId: number; trader: string; date: string; closedAt: string | null; hoursWaiting: number | null };

const SLA_HOURS = 24;

function toSheetItem(t: EodTarget): EodQueueItem {
  const h = t.hoursWaiting ?? 0;
  return { id: t.eodId, trader: t.trader, date: t.date, closedAt: t.closedAt, discipline: null, trades: 0, net: null, hoursWaiting: h, overdue: h > SLA_HOURS, mood: null };
}

/**
 * Review closed days without leaving the cabinet. Returns `open(target)` and the sheet element to render.
 * «Сохранить и следующий» walks `list` — the cabinet's own order and scope (my wards / one trader) —
 * instead of the desk-wide queue the EOD API suggests; already reviewed days are skipped.
 */
export function useCuratorEodReview(list: readonly EodTarget[]) {
  const qc = useQueryClient();
  const [current, setCurrent] = React.useState<EodTarget | null>(null);
  const done = React.useRef(new Set<number>());
  const listRef = React.useRef(list);
  listRef.current = list;

  const refresh = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: curatorKeys.all });
  }, [qc]);

  const open = React.useCallback((t: EodTarget) => setCurrent(t), []);

  const goNext = React.useCallback(() => {
    setCurrent((cur) => {
      if (cur) done.current.add(cur.eodId);
      const l = listRef.current;
      const idx = cur ? l.findIndex((x) => x.eodId === cur.eodId) : -1;
      const ordered = idx >= 0 ? [...l.slice(idx + 1), ...l.slice(0, idx)] : [...l];
      return ordered.find((x) => !done.current.has(x.eodId)) ?? null;
    });
    refresh();
  }, [refresh]);

  const close = React.useCallback(() => {
    setCurrent(null);
    refresh();
  }, [refresh]);

  const item = React.useMemo(() => (current ? toSheetItem(current) : null), [current]);
  const sheet = <EodReviewSheet item={item} onClose={close} onNext={goNext} />;
  return { open, sheet, current };
}
