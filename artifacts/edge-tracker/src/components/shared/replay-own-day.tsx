/**
 * «Переиграть этот день» — the entry point into the simulator's own mode («Мои худшие дни») from places that show
 * one trade (the trade sheet). The button appears only for the viewer's own losing trade that the server can replay
 * (GET /api/sim/own/candidates — own trades only, archived bars, timed fills), so it never leads to an error.
 * The candidates query lives here (shared) and the simulator re-uses it (components/sim/api).
 */
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { links } from "@/lib/links";
import { simOwnI18n } from "@/i18n/ns/simOwn";

export type OwnCandidate = { tradeId: number; ticker: string; date: string; side: "long" | "short"; net: number; r: number | null; mistakes: string[]; played: boolean };
export type OwnCandidates = { trades: OwnCandidate[]; worst: number | null; windowDays: number };

export const OWN_CANDIDATES_KEY = ["sim", "own"] as const;
export const ownCandidatesQuery = () => queryOptions({
  queryKey: OWN_CANDIDATES_KEY,
  queryFn: () => http.get<OwnCandidates>("/api/sim/own/candidates"),
  staleTime: STALE.short,
  meta: { i18n: false },
});

/** `own` = the trade belongs to the viewer and lost money (the caller knows both; the server re-checks). */
export function ReplayOwnDayButton({ tradeId, own }: { tradeId: number; own: boolean }) {
  const { t } = simOwnI18n.useT();
  const q = useQuery({ ...ownCandidatesQuery(), enabled: own });
  if (!own || !q.data?.trades.some((x) => x.tradeId === tradeId)) return null;
  return (
    <Button asChild variant="outline" size="sm" className="gap-1.5" title={t("sheet.replayHint")}>
      <Link href={links.simOwn(tradeId)}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t("sheet.replay")}</Link>
    </Button>
  );
}
