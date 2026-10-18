// One-click «в вотчлист «Сегодня»» for other market pages (Катализаторы, Big 7): the same POST /watchlist/quick
// the watchlist input uses (existing rows move, archived come back), plus a light index of the shared
// watchlist (["watchlist"] cache) so a page can show «уже в вотчлисте».
import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { http } from "@/lib/api/http";
import { KEYS, STALE } from "@/lib/api/keys";
import { links } from "@/lib/links";
import { LIST_LABELS, isListName, type ListName, type WatchlistItem } from "./lib";
import { watchlistI18n } from "@/i18n/ns/watchlist";
import { commonI18n } from "@/i18n/ns/common";

/** ticker → working list of the non-archived rows of the shared watchlist. */
export function useWatchlistIndex(enabled = true) {
  const q = useQuery<WatchlistItem[]>({
    queryKey: KEYS.watchlist(),
    queryFn: ({ signal }) => http.get<WatchlistItem[]>("/api/watchlist", { signal }),
    staleTime: STALE.short,
    enabled,
  });
  return React.useMemo(() => {
    const m = new Map<string, ListName>();
    for (const r of Array.isArray(q.data) ? q.data : []) {
      if (String(r.status ?? "").toLowerCase() === "passed") continue;
      m.set(r.ticker.toUpperCase(), isListName(r.list) ? r.list : r.inPlay ? "today" : "watch");
    }
    return m;
  }, [q.data]);
}

export function useQuickAddToWatchlist() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [busy, setBusy] = React.useState<string | null>(null);
  const add = React.useCallback(async (ticker: string, list: ListName = "today") => {
    const t = ticker.trim().toUpperCase();
    setBusy(t);
    try {
      await http.post("/api/watchlist/quick", { tickers: [t], list });
      await qc.invalidateQueries({ queryKey: KEYS.watchlist() });
      toast({
        title: watchlistI18n.t("toast.quickAdded", { ticker: t, list: LIST_LABELS[list] }),
        action: <ToastAction altText={watchlistI18n.t("toast.openInWatchlist")} onClick={() => navigate(links.watchlist(t))}>{commonI18n.t("actions.open")}</ToastAction>,
      });
      return true;
    } catch (e) {
      toast({ title: watchlistI18n.t("toast.quickAddFailed", { ticker: t }), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      return false;
    } finally {
      setBusy(null);
    }
  }, [qc, toast, navigate]);
  return { add, busy };
}
