import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { getListResearchQueryKey } from "@workspace/api-client-react";
import { BookOpen, ExternalLink, Link2, LineChart, Unlink } from "lucide-react";
import { Pill, toneOf, toneText, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { http } from "@/lib/api/http";
import { isNotFound, nullIfMissing } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { splitTickers, type ResearchNote } from "./research-utils";
import { fmtR, fmtUsd } from "@/lib/format";
import { humanizeApiError } from "@/lib/api/errors";
import { commonI18n } from "@/i18n/ns/common";
import { researchI18n } from "@/i18n/ns/research";

import { personName } from "@/i18n";
/* Evidence for a research note: trades linked through `trades.pattern_id`
 * (`GET /api/research/:id/trades`, scoped to the viewer) and the playbook setups promoted from it.
 * All numbers come from the shared API math — WR excludes BE, net = gross − |fees|. */

type LinkedTrade = {
  id: number; ticker: string; date: string; exitDate: string | null; closeDate: string; side: string | null; setup: string | null;
  result: string | null; horizon: string | null; pnl: number | null; fees: number | null; netPnl: number | null; rMultiple: number | null; signedR: number | null;
  trader: string | null; source: string | null; brokerAccount: string | null; qty: number | null; linked: boolean;
};
type TradeStats = { n: number; wins: number; losses: number; be: number; open: number; winRate: number | null; sumR: number | null; grossPnl: number | null; fees: number | null; netPnl: number | null };
type TradesPayload = { scope: string | null; trades: LinkedTrade[]; stats: TradeStats };
type PlaybookLite = { id: number; name: string; folder?: string | null; sourceType: string | null; sourceId: number | null };
type Candidate = {
  id: number; ticker: string; date: string; side: string | null; setup: string | null; result: string | null;
  netPnl: number | null; signedR: number | null; trader: string | null; patternId: number | null;
};

const MIN_EVIDENCE = 5;

function Stat({ label, value, sub, tone, title }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; title?: string }) {
  return (
    <div className="rounded-xl bg-[var(--glass-bg)] p-2.5" title={title}>
      <div className="micro-label">{label}</div>
      <div className={cn("mt-0.5 text-base font-semibold tabular-nums", tone && toneText(tone))}>{value}</div>
      {sub && <div className="text-2xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function ResearchEvidence({ r }: { r: ResearchNote }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { canEdit } = useAuth();
  const { t: tr } = researchI18n.useT();
  const [tradeId, setTradeId] = useState("");
  const ticker = splitTickers(r.ticker)[0];

  const q = useQuery({
    queryKey: ["research-trades", r.id],
    queryFn: ({ signal }): Promise<TradesPayload | null> =>
      http.get<TradesPayload>(`/api/research/${r.id}/trades`, { signal }).catch(nullIfMissing),
    staleTime: STALE.short,
    retry: false,
  });

  // Setups promoted from this note (playbook.source_type = research). Same cache prefix as AddToPlaybook's invalidation.
  // Lean per-note lookup; an API without it (404) falls back to the full playbook list.
  const lineage = useQuery({
    queryKey: ["playbook", "lineage", r.id],
    queryFn: async ({ signal }): Promise<PlaybookLite[]> => {
      try {
        return await http.get<PlaybookLite[]>(`/api/research/${r.id}/setups`, { signal });
      } catch (e) {
        if (!isNotFound(e)) return [];
      }
      const data = await http.get<PlaybookLite[] | { items?: PlaybookLite[] }>("/api/playbook", { signal }).catch(() => null);
      if (!data) return [];
      return Array.isArray(data) ? data : data.items ?? [];
    },
    staleTime: STALE.short,
    retry: false,
  });
  const promoted = (lineage.data ?? []).filter((p) => p.sourceType === "research" && p.sourceId === r.id);
  const playbookIds = new Set<number>(promoted.map((p) => p.id));
  if (r.playbookId != null) playbookIds.add(r.playbookId);

  // Self-heal lineage: the note remembers the first setup promoted from it (PATCH {playbookId}).
  const healTarget = r.playbookId == null && promoted[0]?.id;
  useEffect(() => {
    if (!canEdit || !healTarget) return;
    let cancelled = false;
    (async () => {
      try {
        await http.patch(`/api/research/${r.id}`, { playbookId: healTarget });
        if (!cancelled) void qc.invalidateQueries({ queryKey: getListResearchQueryKey() });
      } catch { /* lineage is best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [canEdit, healTarget, r.id, qc]);

  const link = useMutation({
    mutationFn: async ({ id, unlink }: { id: number; unlink: boolean }) => {
      await http.post(`/api/research/${r.id}/link-trade`, { tradeId: id, unlink });
    },
    onSuccess: (_d, v) => {
      setTradeId("");
      void qc.invalidateQueries({ queryKey: ["research-trades", r.id] });
      void qc.invalidateQueries({ queryKey: ["research-candidates", r.id] });
      void qc.invalidateQueries({ queryKey: getListResearchQueryKey() });
      toast({ title: v.unlink ? researchI18n.t("toast.unlinked") : researchI18n.t("toast.linked") });
    },
    onError: (e) => toast({ title: researchI18n.t("toast.linkFailed"), description: humanizeApiError(e), variant: "destructive" }),
  });

  // Trades in the note's ticker(s) that can be linked in one click (no trade-ID lookup in the journal).
  const candidates = useQuery({
    queryKey: ["research-candidates", r.id],
    queryFn: async ({ signal }): Promise<Candidate[]> => {
      return http.get<Candidate[]>(`/api/research/${r.id}/candidates`, { signal }).catch(() => []);
    },
    enabled: canEdit && !!ticker,
    staleTime: STALE.short,
    retry: false,
  });
  const cands = candidates.data ?? [];

  if (q.data === null) return null; // endpoint not deployed
  // Live payload when available, else the evidence summary that rides along with the list.
  const stats: TradeStats | null = q.data?.stats
    ?? (r.evidence ? { ...r.evidence, n: r.evidence.tradeCount, open: 0 } : null);
  const n = stats?.n ?? 0;
  const decided = (stats?.wins ?? 0) + (stats?.losses ?? 0);
  const trades = q.data?.trades ?? [];
  const playbookList = Array.from(playbookIds);

  return (
    <section className="rounded-xl border border-border/70 p-3.5" aria-label={tr("evidence.aria")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold"><LineChart className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> {tr("evidence.title")}</h3>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {q.data?.scope && <Pill tone="neutral" className="text-2xs">{q.data.scope}</Pill>}
          {ticker && <Link href={links.trades({ ticker })} className="text-primary hover:underline">{tr("evidence.tickerTrades", { ticker })}</Link>}
        </div>
      </div>

      {q.isLoading ? (
        <Skeleton className="mt-3 h-12 rounded-xl" />
      ) : q.isError ? (
        <p className="mt-2 text-xs text-muted-foreground">{tr("evidence.tradesFailed")}</p>
      ) : (
        <>
          {stats && n > 0 ? (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={tr("evidence.trades")} value={n} sub={stats.open ? tr("evidence.open", { count: stats.open }) : undefined} />
              <Stat
                label="Win rate"
                value={stats.winRate != null ? `${Math.round(stats.winRate)}%` : "—"}
                sub={<>{stats.wins}W / {stats.losses}L{stats.be ? ` · BE ${stats.be}` : ""}</>}
                tone={stats.winRate == null ? "neutral" : stats.winRate >= 50 ? "up" : "down"}
              />
              <Stat label="ΣR" value={stats.sumR != null ? fmtR(stats.sumR, 1) : "—"} tone={stats.sumR != null ? toneOf(stats.sumR) : "neutral"} />
              <Stat
                label={commonI18n.t("trading.netPnl")}
                value={fmtUsd(stats.netPnl, { decimals: 0 })}
                sub={stats.grossPnl != null ? tr("evidence.grossFees", { gross: fmtUsd(stats.grossPnl, { decimals: 0 }), fees: fmtUsd(stats.fees, { decimals: 0 }) }) : undefined}
                tone={stats.netPnl != null ? toneOf(stats.netPnl) : "neutral"}
              />
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">{tr("evidence.none")}</p>
          )}
          {n > 0 && decided < MIN_EVIDENCE && (
            <p className="mt-2 text-2xs text-muted-foreground">{tr("evidence.manualUntil", { min: MIN_EVIDENCE, count: decided })}</p>
          )}

          {trades.length > 0 && (
            <ul className="mt-3 flex flex-col">
              {trades.map((t) => {
                const res = t.result?.toLowerCase();
                const tone = res === "win" ? "up" : res === "loss" ? "down" : "neutral";
                const rr = t.signedR ?? t.rMultiple;
                return (
                  <li key={t.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--glass-hover-bg)]">
                    <Link href={links.trade(t.id)} className="flex min-w-0 flex-1 items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="font-semibold text-foreground">{t.ticker}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{t.date}</span>
                      {t.side && <span className="text-xs text-muted-foreground">{t.side}</span>}
                      {t.setup ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t.setup}</span> : <span className="flex-1" />}
                      {t.trader && <span className="hidden text-xs text-muted-foreground sm:inline">{personName(t.trader)}</span>}
                      {t.brokerAccount && <span className="hidden text-2xs text-muted-foreground lg:inline">{t.brokerAccount}</span>}
                      {rr != null && <span className={cn("text-xs font-semibold tabular-nums", toneText(toneOf(rr)))}>{fmtR(rr, 1)}</span>}
                      {t.netPnl != null && <span className={cn("text-xs tabular-nums", toneText(toneOf(t.netPnl)))} title={tr("evidence.grossFees", { gross: fmtUsd(t.pnl, { decimals: 0 }), fees: fmtUsd(t.fees, { decimals: 0 }) })}>{fmtUsd(t.netPnl, { decimals: 0 })}</span>}
                      <Pill tone={tone} className="text-2xs">{t.result ?? "open"}</Pill>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    </Link>
                    {canEdit && (
                      <button
                        type="button"
                        aria-label={tr("evidence.unlinkAria")}
                        title={tr("evidence.unlink")}
                        disabled={link.isPending}
                        onClick={() => link.mutate({ id: t.id, unlink: true })}
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-bg)] hover:text-foreground"
                      >
                        <Unlink className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {canEdit && cands.length > 0 && (
            <div className="mt-3 border-t border-border/60 pt-3">
              <div className="micro-label mb-1">{tr("evidence.candidates", { tickers: splitTickers(r.ticker).join(", ") })}</div>
              <ul className="flex flex-col">
                {cands.slice(0, 6).map((c) => {
                  const rr = c.signedR;
                  return (
                    <li key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-[var(--glass-hover-bg)]">
                      <Link href={links.trade(c.id)} className="flex min-w-0 flex-1 items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <span className="font-semibold text-foreground">{c.ticker}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">{c.date}</span>
                        {c.side && <span className="text-xs text-muted-foreground">{c.side}</span>}
                        {c.setup ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={c.setup}>{c.setup}</span> : <span className="flex-1" />}
                        {c.trader && <span className="hidden text-xs text-muted-foreground xl:inline">{personName(c.trader)}</span>}
                        {rr != null && <span className={cn("text-xs font-semibold tabular-nums", toneText(toneOf(rr)))}>{fmtR(rr, 1)}</span>}
                        {c.netPnl != null && <span className={cn("w-16 text-right text-xs tabular-nums", toneText(toneOf(c.netPnl)))}>{fmtUsd(c.netPnl, { decimals: 0 })}</span>}
                      </Link>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 min-h-7 shrink-0 px-2.5"
                        disabled={link.isPending}
                        onClick={() => link.mutate({ id: c.id, unlink: false })}
                        title={c.patternId != null ? tr("evidence.relinkTitle") : tr("evidence.linkTitle")}
                      >
                        <Link2 className="h-3.5 w-3.5" aria-hidden="true" /> {c.patternId != null ? tr("evidence.here") : tr("evidence.link")}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {canEdit && (
            <form
              className="mt-3 flex items-center gap-2"
              onSubmit={(e) => { e.preventDefault(); const id = Number(tradeId); if (Number.isInteger(id) && id > 0) link.mutate({ id, unlink: false }); }}
            >
              <label htmlFor={`rs-link-${r.id}`} className="sr-only">{tr("evidence.tradeId")}</label>
              <Input id={`rs-link-${r.id}`} value={tradeId} onChange={(e) => setTradeId(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder={tr("evidence.tradeId")} className="h-8 w-28 text-sm" />
              <Button type="submit" variant="outline" size="sm" disabled={!tradeId || link.isPending}><Link2 className="h-3.5 w-3.5" /> {tr("evidence.link")}</Button>
              <span className="text-2xs text-muted-foreground">{tr("evidence.orById")}</span>
            </form>
          )}
        </>
      )}

      {playbookList.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3 text-xs">
          <BookOpen className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-muted-foreground">{tr("evidence.inPlaybook")}</span>
          {playbookList.map((id) => {
            const p = (lineage.data ?? []).find((x) => x.id === id);
            return (
              <Link key={id} href={links.setup(id)} className="chip inline-flex min-h-7 items-center gap-1 px-2.5 text-xs text-primary hover:underline">
                {p?.name ?? tr("evidence.setupNumber", { id })}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
