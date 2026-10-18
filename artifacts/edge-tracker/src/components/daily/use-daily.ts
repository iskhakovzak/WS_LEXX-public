// Data hooks of the daily loop. GET /api/daily/me and the personal plan share their cache entries with other features
// through lib/api/queries (one endpoint ⇒ one key); POST /api/daily/review lives here (only the day line writes it).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { KEYS, POLL } from "@/lib/api/keys";
import { dailyMeQuery, myPlanQuery } from "@/lib/api/queries";
import type { DailyMe } from "@/lib/daily/types";
import { nyDate } from "@/lib/trading-date";
import { planContract } from "./daily-model";

/** The viewer's daily loop; refreshed every 5 minutes so the phase (premarket → after close) follows the clock. */
export function useDailyMe(enabled = true) {
  return useQuery({
    ...dailyMeQuery(nyDate()),
    enabled,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: POLL.fiveMinutes,
  });
}

type MyPlanAnswer = { plan: { doc: Record<string, unknown> | null } | null } | null;

/** Today's own contract from the personal plan (same cache entry as the plan editor, so a save shows up at once). */
export function useTodayContract(date: string | null, enabled = true) {
  return useQuery({
    ...myPlanQuery<MyPlanAnswer>(date ?? ""),
    select: planContract,
    retry: false,
    enabled: enabled && !!date,
  });
}

export type ReviewInput = { date: string; note?: string | null; dispute?: boolean };

/** «Разобрал» / «Это не ошибка»: marks the evening card reviewed; the card collapses as soon as the server agrees. */
export function useDailyReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: ReviewInput) => http.post<unknown>("/api/daily/review", { date: b.date, note: b.note?.trim() || null, dispute: !!b.dispute }),
    onSuccess: (_res, b) => {
      qc.setQueriesData<DailyMe | null>({ queryKey: ["daily", "me"] }, (prev) => {
        if (!prev?.evening || prev.evening.date !== b.date) return prev;
        const focus = prev.evening.focus && b.dispute ? { ...prev.evening.focus, disputed: true } : prev.evening.focus;
        return { ...prev, evening: { ...prev.evening, reviewed: true, reviewNote: b.note?.trim() || null, focus } };
      });
      void qc.invalidateQueries({ queryKey: KEYS.dailyMe(nyDate()) });
    },
  });
}
