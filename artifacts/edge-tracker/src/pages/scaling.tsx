/**
 * План масштабирования: rules-based tier ladder & buying power.
 * Curator desk (all traders, recommendations first, approval queue) and the trader's personal plan
 * («до следующего тира»: what is missing, what the next tier gives, history). Tiers & rules are edited in a Sheet.
 */
import * as React from "react";
import { useQueryClient, useIsFetching } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { RefreshCw, Settings2, Sparkles, TrendingUp } from "lucide-react";
import { EmptyState, Page, PageHeader, Panel, Segmented, UpdatedAgo } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { DeskView } from "@/components/scaling/desk-view";
import { MyView } from "@/components/scaling/my-view";
import { ConfigSheet } from "@/components/scaling/config-sheet";
import { scalingKeys, useAutoProposals, useScalingConfig } from "@/components/scaling/use-scaling";
import { tierName } from "@/components/scaling/format";
import { scalingI18n } from "@/i18n/ns/scaling";
import { personName } from "@/i18n";
import { shellI18n } from "@/i18n/ns/shell";

type View = "desk" | "me";
const VIEWS: readonly View[] = ["desk", "me"];

function useStoredView(): [View, (v: View) => void] {
  const [v, setV] = React.useState<View>(() => {
    try {
      const s = localStorage.getItem("scaling.view") as View | null;
      if (s && VIEWS.includes(s)) return s;
    } catch { /* storage unavailable */ }
    return "desk";
  });
  const set = React.useCallback((next: View) => {
    setV(next);
    try { localStorage.setItem("scaling.view", next); } catch { /* ignore */ }
  }, []);
  return [v, set];
}

export default function ScalingPage() {
  const { user, isCurator } = useAuth();
  const { t } = scalingI18n.useT();
  const { t: ts } = shellI18n.useT();
  const me = user && user.role !== "guest" ? user.traderName : null;
  const [stored, setView] = useStoredView();
  const view: View = isCurator ? stored : "me";
  // Deep link /scaling?trader=X (links.scaling): curators get the desk with X's card open
  // (their own name → «Мой план»); a trader always sees their own plan (the API scopes it anyway).
  const search = useSearch();
  const focusTrader = React.useMemo(() => new URLSearchParams(search).get("trader")?.trim() || null, [search]);
  React.useEffect(() => {
    if (!focusTrader || !isCurator) return;
    const want: View = focusTrader === me ? "me" : "desk";
    if (stored !== want) setView(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTrader, isCurator, me]);
  const qc = useQueryClient();
  const fetching = useIsFetching({ queryKey: scalingKeys.all }) > 0;
  const [updatedAt, setUpdatedAt] = React.useState<number>();
  const [configOpen, setConfigOpen] = React.useState(false);
  const config = useScalingConfig(!!me && isCurator);
  const auto = useAutoProposals();
  const { toast } = useToast();

  const refresh = React.useCallback(() => { qc.invalidateQueries({ queryKey: scalingKeys.all }); }, [qc]);
  const runAuto = async () => {
    try {
      const r = await auto.mutateAsync();
      toast({ title: r.created ? t("page.autoCreated", { count: r.created }) : t("page.autoNone"), description: r.created ? r.proposals.map((p) => `${personName(p.trader)} → ${tierName(config.data?.tiers ?? [], p.toTier)}`).join(", ") : t("page.autoNoneHint") });
    } catch (e) {
      toast({ title: t("page.autoFailed"), description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <Page>
      <PageHeader
        title={ts("nav.scaling")}
        description={view === "desk" ? t("page.descDesk") : t("page.descMe")}
        icon={TrendingUp}
        actions={me ? (
          <>
            <UpdatedAgo at={updatedAt} className="hidden 2xl:inline-flex" />
            <Button variant="outline" size="icon" onClick={refresh} aria-label={t("page.refresh")} title={t("page.refresh")} disabled={fetching}>
              <RefreshCw className={cn("h-4 w-4", fetching && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
            </Button>
            {isCurator && (
              <>
                <Button variant="outline" onClick={() => setConfigOpen(true)}>
                  <Settings2 className="h-4 w-4" aria-hidden="true" /> {t("page.config")}
                </Button>
                {view === "desk" && (
                  <Button onClick={runAuto} disabled={auto.isPending} aria-label={t("page.autoAria")} title={t("page.autoTitle")}>
                    <Sparkles className="h-4 w-4" aria-hidden="true" /> {auto.isPending ? t("page.autoRunning") : t("page.auto")}
                  </Button>
                )}
                <Segmented ariaLabel={t("page.viewAria")} value={view} onChange={setView} options={[{ value: "desk", label: t("page.viewDesk") }, { value: "me", label: t("page.viewMe") }]} />
              </>
            )}
          </>
        ) : undefined}
      />

      {!me ? (
        <Panel><EmptyState icon={TrendingUp} title={t("page.signInTitle")} description={t("page.signInHint")} /></Panel>
      ) : view === "desk" ? (
        <DeskView onUpdatedAt={setUpdatedAt} focusTrader={focusTrader && focusTrader !== me ? focusTrader : null} />
      ) : (
        <MyView trader={me} onUpdatedAt={setUpdatedAt} />
      )}

      {isCurator && <ConfigSheet config={config.data} open={configOpen} onOpenChange={setConfigOpen} />}
    </Page>
  );
}
