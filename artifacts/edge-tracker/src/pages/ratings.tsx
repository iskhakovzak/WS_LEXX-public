import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Plus, Star, Trophy, UserRound } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Kbd } from "@/components/ui/kbd";
import { useToast } from "@/hooks/use-toast";
import { Page, PageHeader, Segmented } from "@/components/ds";
import { useStoredState } from "@/components/ratings/shared";
import { LeaderboardTab } from "@/components/ratings/leaderboard-tab";
import { ScorecardsTab } from "@/components/ratings/scorecards-tab";
import { MyProgressTab } from "@/components/ratings/my-progress-tab";
import { RatingDialog } from "@/components/ratings/rating-dialog";
import { weekLabel, weekOf, type Rating } from "@/components/ratings/scorecard-model";
import { ratingsI18n } from "@/i18n/ns/ratings";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";

type Tab = "leaderboard" | "curator" | "me";
const TABS: readonly Tab[] = ["leaderboard", "curator", "me"];

export default function RatingsPage() {
  const { user, isCurator, isAdmin, dbUsers } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = ratingsI18n.useT();
  const { t: tc } = commonI18n.useT();
  const me = user?.role !== "guest" ? user?.traderName ?? null : null;

  const [tab, setTab] = useStoredState<Tab>("ratings.tab", isCurator ? "curator" : me ? "me" : "leaderboard", TABS);
  const [dialog, setDialog] = useState<{ open: boolean; trader?: string; editing?: Rating | null }>({ open: false });
  const [deleting, setDeleting] = useState<Rating | null>(null);

  // Only real traders are rated: staff and the synthetic guest identity are excluded from the pending queue.
  const ratingTraders = useMemo(
    () => dbUsers.filter((u) => u.active && u.role !== "curator" && u.role !== "admin" && u.role !== "guest").map((u) => u.name),
    [dbUsers],
  );

  const ratingsQ = useQuery<Rating[]>({
    queryKey: ["ratings", "all"],
    queryFn: ({ signal }) => http.get<Rating[]>("/api/ratings", { signal }),
    // The full history (~850 rows / 400 KB for staff) feeds trends; mutations invalidate it, so no refetch per visit.
    staleTime: STALE.short,
  });
  const ratings = ratingsQ.data ?? [];

  const deleteMut = useMutation({
    mutationFn: (id: number) => http.del(`/api/ratings/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ratings"] });
      setDeleting(null);
      toast({ title: ratingsI18n.t("page.deleted") });
    },
    onError: (e: Error) => toast({ title: commonI18n.t("states.error"), description: humanizeApiError(e, ratingsI18n.t("page.deleteFailed")), variant: "destructive" }),
  });

  const openRate = (trader?: string) => setDialog({ open: true, trader, editing: null });

  // N — new rating (curators), outside of text fields / open dialogs.
  useEffect(() => {
    if (!isCurator) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" && e.key.toLowerCase() !== "т") return; // i18n-ignore (Russian-layout N)
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      if (document.querySelector("[role='dialog'], [role='alertdialog']")) return;
      e.preventDefault();
      openRate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isCurator]);

  const thisWeek = weekOf();
  const pendingCount = isCurator ? ratingTraders.filter((name) => !ratings.some((r) => r.trader === name && r.week === thisWeek)).length : 0;

  const tabOptions = [
    { value: "leaderboard" as const, label: <span className="inline-flex items-center gap-1.5"><BarChart3 className="hidden h-4 w-4 sm:block" aria-hidden="true" />{t("page.tabLeaderboard")}</span> },
    {
      value: "curator" as const,
      label: <span className="inline-flex items-center gap-1.5"><Star className="hidden h-4 w-4 sm:block" aria-hidden="true" /><span className="sm:hidden">{t("page.tabCuratorShort")}</span><span className="hidden sm:inline">{t("page.tabCurator")}</span></span>,
      count: isCurator && pendingCount > 0 && !ratingsQ.isLoading ? pendingCount : undefined,
    },
    ...(me ? [{ value: "me" as const, label: <span className="inline-flex items-center gap-1.5"><UserRound className="hidden h-4 w-4 sm:block" aria-hidden="true" />{t("page.tabMe")}</span> }] : []),
  ];
  const activeTab: Tab = tab === "me" && !me ? "leaderboard" : tab;

  return (
    <Page>
      <PageHeader
        icon={Trophy}
        title={t("page.title")}
        description={t("page.description")}
        actions={isCurator ? (
          <Button onClick={() => openRate()} className="gap-1.5" title={t("page.hotkey")}>
            <Plus className="h-4 w-4" aria-hidden="true" /> {t("dialog.titleNew")}
            <Kbd className="ml-1 hidden sm:inline-flex">N</Kbd>
          </Button>
        ) : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Segmented ariaLabel={t("page.tabsAria")} options={tabOptions} value={activeTab} onChange={setTab} />
          {isCurator && pendingCount > 0 && activeTab !== "curator" && (
            <button type="button" className="chip min-h-8 px-3 text-sm" onClick={() => setTab("curator")}>
              {t("page.pending", { week: weekLabel(thisWeek), count: pendingCount })}
            </button>
          )}
        </div>
      </PageHeader>

      {activeTab === "leaderboard" && <LeaderboardTab me={me} />}
      {activeTab === "curator" && (
        <ScorecardsTab
          ratings={ratings}
          isLoading={ratingsQ.isLoading}
          isError={ratingsQ.isError}
          error={ratingsQ.error}
          onRetry={() => ratingsQ.refetch()}
          isCurator={isCurator}
          isAdmin={isAdmin}
          me={me}
          traders={ratingTraders}
          onRate={openRate}
          onEdit={(r) => setDialog({ open: true, editing: r })}
          onDelete={setDeleting}
        />
      )}
      {activeTab === "me" && <MyProgressTab me={me} ratings={ratings} ratingsLoading={ratingsQ.isLoading} />}

      {isCurator && (
        <RatingDialog
          open={dialog.open}
          onOpenChange={(v) => setDialog((d) => ({ ...d, open: v }))}
          traders={ratingTraders}
          ratings={ratings}
          me={me}
          initialTrader={dialog.trader}
          editing={dialog.editing}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(v) => { if (!v) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("page.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? t("page.deleteDescription", { trader: personName(deleting.trader), week: weekLabel(deleting.week) }) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); if (deleting) deleteMut.mutate(deleting.id); }}
              disabled={deleteMut.isPending}
              className="bg-down text-primary-foreground hover:bg-down/90"
            >
              {deleteMut.isPending ? t("page.deleting") : tc("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
