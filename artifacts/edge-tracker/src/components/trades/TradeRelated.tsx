import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { BookOpen, ChevronRight, Lightbulb, ShieldAlert, ShieldCheck, ShieldQuestion, History } from "lucide-react";
import type { Trade } from "@workspace/api-client-react";
import { Pill } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { DEFAULT_FILTERS, computeStats, dayOf, effectiveR } from "./trade-utils";
import { ResultPill } from "./trade-bits";
import { TRADES_PAGE_KEY, buildTradesPageParams, fetchTradesPage } from "@/hooks/use-trades-page";
import { fmtDate, fmtR, fmtRate } from "@/lib/format";
import { tradesI18n } from "@/i18n/ns/trades";
import { commonI18n } from "@/i18n/ns/common";
import { withNodes } from "./rich-text";
import { shellI18n } from "@/i18n/ns/shell";

const shellPlaybook = () => shellI18n.t("nav.playbook");

type PlaybookLite = { id: number; name: string; setupType: string | null; ticker: string | null; sourceType: string | null; sourceId: number | null; folder: string | null };
type IdeaLite = { id: number; ticker: string; side: string | null; status: string | null; thesis: string | null; createdAt: string; convertedTradeId?: number | null; trader?: string | null; target?: string | null };
type ChecklistResp = { id: number; passed: boolean; responses: string; createdAt: string };


/** Idea status code → label (unknown codes as is). */
const ideaStatus = (s: string | null | undefined) => (s ? tradesI18n.tryT(`related.ideaStatus.${s}`) ?? s : "—");

function Row({ icon: Icon, children, onClick, label }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm hover:bg-[var(--glass-hover-bg)]">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/** Checklist gate result for the trade. */
export function ChecklistStatus({ tradeId }: { tradeId: number }) {
  const { t } = tradesI18n.useT();
  const q = useQuery<ChecklistResp[]>({
    queryKey: ["trade-checklist-response", tradeId],
    queryFn: ({ signal }) => http.get<ChecklistResp[]>(`/api/checklist-responses?tradeId=${tradeId}`, { signal }),
    staleTime: STALE.long,
  });
  if (q.isLoading) return <Skeleton className="h-7 w-40 rounded-full" />;
  const r = q.data?.[0];
  if (!r) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <ShieldQuestion className="h-4 w-4" aria-hidden="true" /> {t("related.checklistNone")}
      </span>
    );
  }
  let yes = 0, total = 0;
  try {
    const parsed = JSON.parse(r.responses) as Record<string, string>;
    for (const v of Object.values(parsed)) { if (v === "na") continue; total++; if (v === "yes") yes++; }
  } catch { /* legacy format */ }
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${r.passed ? "text-up" : "text-down"}`}>
      {r.passed ? <ShieldCheck className="h-4 w-4" aria-hidden="true" /> : <ShieldAlert className="h-4 w-4" aria-hidden="true" />}
      {r.passed ? t("related.checklistPassed") : t("related.checklistFailed")}
      {total > 0 && <span className="tabular-nums text-muted-foreground">· {yes}/{total}</span>}
      <span className="text-muted-foreground">· #{r.id}</span>
    </span>
  );
}

/** Ideas for a ticker (shared cache with the "Связи" block). */
export function useTickerIdeas(ticker: string | null | undefined) {
  return useQuery<IdeaLite[]>({
    queryKey: ["trades-related-ideas", ticker ?? ""],
    queryFn: ({ signal }) => http.get<IdeaLite[]>(`/api/trade-ideas?ticker=${encodeURIComponent(ticker ?? "")}`, { signal }),
    staleTime: 2 * 60_000,
    enabled: !!ticker,
  });
}

/** Profit target of the idea this trade was converted from, if any. */
export function useSourceIdeaTarget(trade: Trade | null): string | null {
  const ideas = useTickerIdeas(trade?.ticker);
  if (!trade) return null;
  const src = (ideas.data ?? []).find((i) => i.convertedTradeId === trade.id);
  return src?.target?.trim() || null;
}

/** Cross-links: playbook setups, ideas and history for the same ticker. */
export function TradeRelated({ trade, allTrades, onOpenTrade }: { trade: Trade; allTrades: Trade[]; onOpenTrade: (t: Trade) => void }) {
  const { t: tt } = tradesI18n.useT();
  const [, setLocation] = useLocation();
  const playbook = useQuery<PlaybookLite[]>({
    queryKey: ["trades-related-playbook"],
    queryFn: ({ signal }) => http.get<PlaybookLite[]>("/api/playbook", { signal }),
    staleTime: STALE.long,
  });
  const ideas = useTickerIdeas(trade.ticker);

  const setup = (trade.setup ?? "").trim().toLowerCase();
  const pbMatches = React.useMemo(() => {
    const list = playbook.data ?? [];
    const scored = list.map((e) => {
      let score = 0;
      if (e.sourceType === "trade" && e.sourceId === trade.id) score += 10;
      if (setup && (e.setupType ?? "").trim().toLowerCase() === setup) score += 5;
      if (setup && e.name.toLowerCase().includes(setup)) score += 2;
      if (e.ticker && e.ticker.toUpperCase() === trade.ticker.toUpperCase()) score += 1;
      return { e, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, 4);
  }, [playbook.data, setup, trade.id, trade.ticker]);

  // Ticker history comes from the paginated endpoint (the page only holds one slice of the book);
  // the rows already on the page are the fallback while it loads / when the API predates it.
  const historyQ = useQuery<Trade[]>({
    queryKey: [TRADES_PAGE_KEY, "history", trade.ticker],
    queryFn: async () => {
      const params = buildTradesPageParams({ ...DEFAULT_FILTERS, ticker: trade.ticker }, { col: "date", dir: "desc" }, { limit: 200 });
      return (await fetchTradesPage(params)).items;
    },
    staleTime: 60_000,
    retry: false,
  });
  const history = React.useMemo(() => {
    const src = historyQ.data ?? allTrades;
    return src.filter((t) => t.ticker === trade.ticker && t.id !== trade.id);
  }, [historyQ.data, allTrades, trade.ticker, trade.id]);
  const hStats = React.useMemo(() => computeStats(history), [history]);
  const ideaList = (ideas.data ?? []).slice(0, 4);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-1">
        <p className="micro-label px-2.5">{shellPlaybook()}</p>
        {playbook.isLoading ? <Skeleton className="h-9 rounded-xl" /> : pbMatches.length === 0 ? (
          <p className="px-2.5 text-sm text-muted-foreground">{setup ? tt("related.playbookNoSetup") : tt("related.playbookSetSetup")}</p>
        ) : pbMatches.map(({ e, score }) => (
          <Row key={e.id} icon={BookOpen} label={tt("related.openInPlaybook", { name: e.name })} onClick={() => setLocation(`/playbook?highlight=${e.id}`)}>
            <span className="block truncate">{e.name}</span>
            <span className="text-xs text-muted-foreground">{score >= 10 ? tt("related.fromThisTrade") : e.setupType ?? e.folder ?? tt("related.byTicker")}</span>
          </Row>
        ))}
      </div>

      <div className="space-y-1">
        <p className="micro-label px-2.5">{tt("related.ideasFor", { ticker: trade.ticker })}</p>
        {ideas.isLoading ? <Skeleton className="h-9 rounded-xl" /> : ideaList.length === 0 ? (
          <p className="px-2.5 text-sm text-muted-foreground">{tt("related.noIdeas")}</p>
        ) : ideaList.map((i) => (
          <Row key={i.id} icon={Lightbulb} label={tt("related.ideaAria", { ticker: i.ticker, id: i.id })} onClick={() => setLocation(`/trade-ideas?highlight=${i.id}`)}>
            <span className="flex items-center gap-2">
              <span className="truncate">{i.thesis?.split("\n")[0] || tt("related.ideaFallback", { id: i.id })}</span>
              {i.convertedTradeId === trade.id && <Pill tone="accent">{tt("related.source")}</Pill>}
            </span>
            <span className="text-xs text-muted-foreground">{fmtDate(i.createdAt.substring(0, 10), "shortYY")} · {ideaStatus(i.status)}</span>
          </Row>
        ))}
      </div>

      <div className="space-y-1 md:col-span-2">
        <p className="micro-label px-2.5">{tt("related.historyFor", { ticker: trade.ticker })}</p>
        {history.length === 0 ? (
          <p className="px-2.5 text-sm text-muted-foreground">{tt("related.firstTrade")}</p>
        ) : (
          <>
            <p className="px-2.5 pb-1 text-sm text-muted-foreground">
              {withNodes(tt("related.historyStats", { trades: commonI18n.t("units.trades", { count: history.length }), wr: "{wr}", r: "{r}" }), {
                wr: <span className="font-medium text-foreground tabular-nums">{fmtRate(hStats.winRate)}</span>,
                r: <span className="font-medium text-foreground tabular-nums">{fmtR(hStats.avgR)}</span>,
              })}
            </p>
            {history.slice(0, 5).map((t) => (
              <Row key={t.id} icon={History} label={tt("related.openTrade", { ticker: t.ticker, date: dayOf(t) })} onClick={() => onOpenTrade(t)}>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">{fmtDate(dayOf(t), "shortYY")}</span>
                  <ResultPill result={t.result} />
                  <span className="tabular-nums text-muted-foreground">{fmtR(effectiveR(t).value, 1)}</span>
                  <span className="truncate text-muted-foreground">{t.setup ?? ""}</span>
                </span>
              </Row>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
