import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TradeIdeaForm, type TradeIdeaFormData } from "@/components/trade-idea-form";
import { screenshotUrlsToString, stringToScreenshotUrls } from "@/components/screenshot-fields";
import { useToast } from "@/hooks/use-toast";
import { http } from "@/lib/api/http";
import { KEYS } from "@/lib/api/keys";
import { num, type Quote, type WatchlistItem } from "./lib";
import { watchlistI18n } from "@/i18n/ns/watchlist";

/**
 * One-click "create idea" from a watchlist row: prefilled TradeIdeaForm (ticker, side from levels, stop/target,
 * thesis from catalyst + plan, tags, source link). With `thenTrade` it opens /trades?fromIdea=<id> after saving,
 * which pre-fills the trade form and links idea → trade.
 */
export function IdeaFromWatchlistDialog({
  item, quote, thenTrade, onClose,
}: { item: WatchlistItem | null; quote?: Quote; thenTrade: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = watchlistI18n.useT();
  const [, setLocation] = useLocation();

  const initial = React.useMemo<Partial<TradeIdeaFormData> | null>(() => {
    if (!item) return null;
    const stop = num(item.stopPrice);
    const target = num(item.targetPrice);
    const side = stop != null && target != null && target < stop ? "Short" : "Long";
    const thesis = [item.catalyst, item.notes].filter(Boolean).join("\n\n");
    return {
      ticker: item.ticker,
      side,
      stop: stop != null ? String(stop) : "",
      target: target != null ? String(target) : "",
      entryZone: quote?.price != null ? quote.price.toFixed(2) : "",
      thesis,
      tags: item.tags ?? "",
      watchlistId: item.id,
      score: item.score != null ? String(item.score) : "",
      screenshotUrls: stringToScreenshotUrls(item.screenshotUrl),
      sector: item.sector ?? null,
    };
  }, [item, quote?.price]);

  const createMut = useMutation({
    mutationFn: (data: TradeIdeaFormData) => {
      const { screenshotUrls, ...rest } = data;
      return http.post<{ id: number; ticker: string }>("/api/trade-ideas", {
        ...rest,
        screenshotUrl: screenshotUrlsToString(screenshotUrls) || null,
        score: data.score ? Number(data.score) : null,
        status: "draft",
      });
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["trade-ideas"] });
      qc.invalidateQueries({ queryKey: KEYS.watchlist() });
      onClose();
      if (thenTrade && row?.id) {
        toast({ title: watchlistI18n.t("idea.savedThenTrade", { ticker: row.ticker }), description: watchlistI18n.t("idea.openingTrade") });
        setLocation(`/trades?fromIdea=${row.id}`);
      } else {
        toast({ title: watchlistI18n.t("idea.savedDraft", { ticker: row?.ticker ?? "" }) });
      }
    },
    onError: (e) => toast({ title: watchlistI18n.t("idea.saveFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }),
  });

  return (
    <Dialog open={!!item} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[92vh] w-full max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{thenTrade ? t("idea.titleTrade", { ticker: item?.ticker ?? "" }) : t("idea.titleNew", { ticker: item?.ticker ?? "" })}</DialogTitle>
          <DialogDescription>
            {thenTrade ? t("idea.descTrade") : t("idea.descNew")}
          </DialogDescription>
        </DialogHeader>
        {initial && (
          <TradeIdeaForm
            key={item?.id}
            initial={initial}
            onSubmit={(d) => createMut.mutate(d)}
            onCancel={onClose}
            submitting={createMut.isPending}
            submitLabel={thenTrade ? t("idea.submitTrade") : t("idea.submitNew")}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
