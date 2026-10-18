/** Linked trades of a setup: R-strip, sortable table, link/unlink. Link dialog suggests trades whose setup name matches. */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ExternalLink, Link2, List, Search, TrendingUp, Unlink } from "lucide-react";
import { WriteOnly } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pill, SortableTh, toneText, useTableSort, type Tone } from "@/components/ds";
import { IconAction } from "@/components/playbook-sub/bits";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { byCloseDate, horizonOf, isDecided, netPnl, resultOf, signedR, type Horizon } from "@/lib/trade-math";
import { invalidateTradeLinks, useTradePicker } from "./api";
import { http } from "@/lib/api/http";
import { DocSection, InlineError, redactedHint, RedactedHint } from "./setup-bits";
import { HORIZON_LABEL, type LinkedTrade, type PickerTrade, type PlaybookEntry } from "./model";
import { fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { playbookExamplesI18n } from "@/i18n/ns/playbookExamples";

import { personName } from "@/i18n";
const et = playbookExamplesI18n.t; // called at render / call time only

type PickRow = LinkedTrade & { matchesSetup: boolean };
/** Lean picker row → the LinkedTrade shape the row renderer uses (net P&L goes in as `pnl`, fees already netted). */
const fromPicker = (t: PickerTrade): PickRow => ({
  id: t.id, ticker: t.ticker, date: t.date, closeDate: t.closeDate, side: t.side, result: t.result ?? "",
  pnl: t.netPnl, fees: 0, netPnl: t.netPnl, rMultiple: null, signedR: t.signedR, horizon: t.horizon,
  setup: t.setup, trader: t.trader, playbookId: t.playbookId, redacted: t.redacted, matchesSetup: t.matchesSetup,
});

const resultTone = (t: LinkedTrade): Tone => { const r = resultOf(t); return r === "win" ? "up" : r === "loss" ? "down" : "neutral"; };
/** Net $ when P&L is known (labelled «нетто» in the title), else the result word (also for redacted rows). */
const resultLabel = (t: LinkedTrade) => {
  const n = t.redacted ? null : netPnl(t);
  if (n != null) return fmtUsd(n, { signed: true, decimals: 0 });
  const r = resultOf(t);
  return r === "win" ? commonI18n.t("trading.win") : r === "loss" ? commonI18n.t("trading.loss") : r === "be" ? commonI18n.t("trading.breakeven") : et("linked.open");
};
/**
 * Signed R: the server's value first (it is computed before $ redaction, so it survives for other traders'
 * trades whose pnl / risk $ come back null), else the shared trade math (sign follows the result; falls back to prices).
 */
const rOf = (t: LinkedTrade): number | null => (t.signedR != null && Number.isFinite(t.signedR) ? t.signedR : signedR(t));

/** Tiny chronological bar strip of R-multiples (or ±1 by result when R is missing). */
function RStrip({ trades }: { trades: LinkedTrade[] }) {
  const pts = byCloseDate(trades).slice(-40);
  if (pts.length < 2) return null;
  const vals = pts.map((t) => { const r = rOf(t); const res = resultOf(t); return r != null ? r : res === "win" ? 1 : res === "loss" ? -1 : 0; });
  const max = Math.max(1, ...vals.map((v) => Math.abs(v)));
  return (
    <div className="mb-3 flex h-12 items-center gap-[3px]" role="img" aria-label={et("linked.rStripAria", { count: pts.length })}>
      {vals.map((v, i) => (
        <div key={pts[i].id} className="flex h-full min-w-[3px] flex-1 flex-col justify-center" title={`${pts[i].ticker} ${pts[i].date?.slice(0, 10)}: ${v > 0 ? "+" : ""}${v.toFixed(2)}R`}>
          <div className="flex h-1/2 items-end">
            {v > 0 && <div className="w-full rounded-t-sm bg-up" style={{ height: `${(v / max) * 100}%` }} />}
          </div>
          <div className="flex h-1/2 items-start">
            {v < 0 && <div className="w-full rounded-b-sm bg-down" style={{ height: `${(-v / max) * 100}%` }} />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** «Setup · trader» line (the trader in the display language). */
const whoText = (t: LinkedTrade) => [t.setup, t.trader ? personName(t.trader) : null].filter(Boolean).join(" · ");

type LinkedKey = "ticker" | "date" | "horizon" | "who" | "r" | "result";
/** «Итог» sorts by net $ when it is shown, else by the result (win > be > loss). */
const LINKED_ACCESSORS: Record<LinkedKey, (t: LinkedTrade) => number | string | null | undefined> = {
  ticker: (t) => t.ticker,
  date: (t) => (t.exitDate || t.date || "").slice(0, 10),
  horizon: (t) => horizonOf(t),
  who: (t) => whoText(t) || null,
  r: (t) => rOf(t),
  result: (t) => { const n = t.redacted ? null : netPnl(t); if (n != null) return n; const r = resultOf(t); return r === "win" ? 1 : r === "loss" ? -1 : r === "be" ? 0 : null; },
};

const HORIZONS: Horizon[] = ["intraday", "overnight", "swing"];

/** Edge split by holding horizon (shared trade math) — only shown when the setup was traded on more than one horizon. */
function HorizonSplit({ trades }: { trades: LinkedTrade[] }) {
  const rows = HORIZONS.map((key) => {
    const list = trades.filter((t) => horizonOf(t) === key);
    const decided = list.filter(isDecided);
    const wins = decided.filter((t) => resultOf(t) === "win").length;
    const rs = list.map(rOf).filter((r): r is number => r != null);
    return {
      key, label: HORIZON_LABEL[key] ?? key,
      n: list.length,
      wr: decided.length ? wins / decided.length : null,
      avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    };
  }).filter((r) => r.n > 0);
  if (rows.length < 2) return null;
  return (
    <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label={et("linked.horizonAria")}>
      {rows.map((r) => (
        <div key={r.key} className="rounded-xl bg-[var(--glass-bg)] px-3 py-2">
          <div className="text-xs text-muted-foreground">{r.label} · {r.n}</div>
          <div className="mt-0.5 flex items-baseline gap-3 text-sm font-semibold tabular-nums">
            <span className={toneText(r.wr == null ? "neutral" : r.wr >= 0.55 ? "up" : r.wr >= 0.4 ? "warn" : "down")}>{r.wr == null ? "—" : `${Math.round(r.wr * 100)}%`}</span>
            <span className={toneText(r.avgR == null ? "neutral" : r.avgR > 0 ? "up" : r.avgR < 0 ? "down" : "neutral")}>
              {r.avgR == null ? "—" : `${r.avgR > 0 ? "+" : r.avgR < 0 ? "−" : ""}${Math.abs(r.avgR).toFixed(2)}R`}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function LinkedTradesSection({ entry }: { entry: PlaybookEntry }) {
  const { t: tr } = playbookExamplesI18n.useT();
  const entryId = entry.id;
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [linkOpen, setLinkOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data: linked = [], refetch, isLoading, isError } = useQuery<LinkedTrade[]>({
    queryKey: ["playbook-trades", entryId],
    queryFn: () => http.get<LinkedTrade[]>(`/api/playbook/${entryId}/trades`),
  });
  // Lean server picker (recent trades in scope + server-side setup matching) instead of the full /api/trades payload.
  // A ticker-like query also searches the whole history on the server; setup / trader text filters the recent list.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);
  const tickerQ = /^[a-z0-9.-]{1,10}$/i.test(debounced) ? debounced : "";
  const baseQ = useTradePicker({ setupId: entryId }, linkOpen);
  const tickerHits = useTradePicker({ setupId: entryId, q: tickerQ }, linkOpen && !!tickerQ);
  const allLoading = baseQ.isLoading || (!!tickerQ && tickerHits.isLoading);
  const allError = baseQ.isError;
  const allTrades = useMemo(() => {
    const out = new Map<number, PickRow>();
    for (const t of baseQ.data?.trades ?? []) out.set(t.id, fromPicker(t));
    if (tickerQ) for (const t of tickerHits.data?.trades ?? []) if (!out.has(t.id)) out.set(t.id, fromPicker(t));
    return [...out.values()];
  }, [baseQ.data, tickerHits.data, tickerQ]);

  const { rows: sortedLinked, thProps } = useTableSort<LinkedTrade, LinkedKey>(linked, LINKED_ACCESSORS, "date", "desc", { ticker: "asc", horizon: "asc", who: "asc" });
  const linkedIds = useMemo(() => new Set(linked.map((t) => t.id)), [linked]);
  const { suggested, rest } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const keys = [entry.name, entry.setupType].filter(Boolean).map((s) => s!.toLowerCase());
    const matchesSetup = (t: PickRow) => {
      if (t.matchesSetup) return true;
      const s = (t.setup || "").toLowerCase();
      return !!s && keys.some((k) => s.includes(k) || k.includes(s));
    };
    const list = allTrades
      .filter((t) => !linkedIds.has(t.id))
      .filter((t) => !q || t.ticker.toLowerCase().includes(q) || (t.setup || "").toLowerCase().includes(q) || (t.trader || "").toLowerCase().includes(q))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    return { suggested: list.filter(matchesSetup), rest: list.filter((t) => !matchesSetup(t)).slice(0, 200) };
  }, [allTrades, linkedIds, search, entry.name, entry.setupType]);

  async function link(t: LinkedTrade) {
    try {
      await http.post(`/api/playbook/${entryId}/link-trade`, { tradeId: t.id });
      invalidateTradeLinks(qc);
      toast({ title: tr("linked.linked", { ticker: t.ticker }) });
    } catch (e: any) {
      toast({ title: tr("linked.linkFailed"), description: e?.message, variant: "destructive" });
    }
  }
  async function unlink(t: LinkedTrade) {
    try {
      await http.del(`/api/playbook/${entryId}/link-trade/${t.id}`);
      invalidateTradeLinks(qc);
      toast({ title: tr("linked.unlinked", { ticker: t.ticker }) });
    } catch (e: any) {
      toast({ title: tr("linked.unlinkFailed"), description: e?.message, variant: "destructive" });
    }
  }

  const tradeRow = (t: LinkedTrade, onPick?: () => void) => {
    const tone = resultTone(t);
    const r = rOf(t);
    const hz = horizonOf(t);
    const body = (
      <>
        <span className="w-14 shrink-0 font-semibold text-foreground">{t.ticker}</span>
        {t.side && <span className={cn("shrink-0 text-xs", t.side === "Long" ? "text-up" : "text-down")}>{t.side === "Long" ? "▲" : "▼"}</span>}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t.date?.slice(0, 10)}</span>
        {hz !== "intraday" && <span className="shrink-0 text-xs text-muted-foreground">{HORIZON_LABEL[hz] ?? hz}</span>}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{whoText(t)}</span>
        {r != null && <span className={cn("shrink-0 text-xs tabular-nums", toneText(r > 0 ? "up" : r < 0 ? "down" : "neutral"))}>{r > 0 ? "+" : ""}{r.toFixed(1)}R</span>}
        <Pill tone={tone} className="shrink-0"><span title={t.redacted ? redactedHint() : netPnl(t) != null ? commonI18n.t("trading.netPnl") : undefined}>{resultLabel(t)}</span></Pill>
      </>
    );
    if (onPick) {
      return (
        <button key={t.id} type="button" onClick={onPick} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {body}
        </button>
      );
    }
    return (
      <div key={t.id} className="group flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm hover:bg-[var(--glass-hover-bg)]">
        {body}
        <IconAction aria-label={tr("linked.openTrade", { ticker: t.ticker })} title={tr("linked.openTrade", { ticker: t.ticker })} onClick={() => setLocation(links.trade(t.id))} className="md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100">
          <ExternalLink />
        </IconAction>
        <WriteOnly>
          <IconAction aria-label={tr("linked.unlinkTrade", { ticker: t.ticker })} title={tr("linked.unlinkTrade", { ticker: t.ticker })} onClick={() => unlink(t)} className="hover:text-down md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100">
            <Unlink />
          </IconAction>
        </WriteOnly>
      </div>
    );
  };

  return (
    <DocSection
      id="pb-linked-trades"
      title={<>{tr("linked.title")} {linked.length > 0 && <span className="font-normal tabular-nums text-muted-foreground">{linked.length}</span>}</>}
      icon={TrendingUp}
      actions={
        <div className="flex items-center gap-1">
          {linked.length > 0 && (
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setLocation(links.trades({ playbookId: entryId }))} title={tr("linked.allTitle")}>
              <List className="h-4 w-4" aria-hidden="true" /> {tr("linked.all")}
            </Button>
          )}
          <WriteOnly>
            <Button size="sm" variant="outline" className="h-8" onClick={() => setLinkOpen(true)}>
              <Link2 className="h-4 w-4" aria-hidden="true" /> {tr("linked.link")}
            </Button>
          </WriteOnly>
        </div>
      }
    >
      {isLoading ? (
        <div className="space-y-2"><Skeleton className="h-9 rounded-xl" /><Skeleton className="h-9 rounded-xl" /></div>
      ) : isError ? (
        <InlineError text={tr("linked.loadFailed")} onRetry={() => refetch()} />
      ) : linked.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {tr("linked.empty")}
        </p>
      ) : (
        <>
          <RStrip trades={linked} />
          <HorizonSplit trades={linked} />
          <div className="-mx-2 max-h-[min(60dvh,560px)] overflow-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="sticky top-0 z-raised bg-surface-solid text-xs text-muted-foreground [&_th]:px-2 [&_th]:py-1.5 [&_th]:font-medium">
                <tr className="border-b border-border/60">
                  <SortableTh {...thProps("ticker")}>{tr("linked.colTicker")}</SortableTh>
                  <SortableTh {...thProps("date")}>{tr("linked.colDate")}</SortableTh>
                  <SortableTh {...thProps("horizon")}>{tr("linked.colHorizon")}</SortableTh>
                  <SortableTh {...thProps("who")}>{tr("linked.colWho")}</SortableTh>
                  <SortableTh {...thProps("r")} align="right">R</SortableTh>
                  <SortableTh {...thProps("result")} align="right">{tr("linked.colResult")}</SortableTh>
                  <th className="w-20"><span className="sr-only">{tr("linked.colActions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {sortedLinked.map((t) => {
                  const r = rOf(t);
                  const hz = horizonOf(t);
                  return (
                    <tr key={t.id} className="group border-b border-border/40 last:border-0 hover:bg-[var(--glass-hover-bg)]">
                      <td className="px-2 py-1.5 font-semibold text-foreground">
                        {t.ticker}
                        {t.side && <span className={cn("ml-1 text-xs", t.side === "Long" ? "text-up" : "text-down")} aria-label={t.side === "Long" ? commonI18n.t("trading.long") : commonI18n.t("trading.short")}>{t.side === "Long" ? "▲" : "▼"}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-xs tabular-nums text-muted-foreground">{(t.exitDate || t.date)?.slice(0, 10)}</td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">{HORIZON_LABEL[hz] ?? hz}</td>
                      <td className="max-w-[220px] truncate px-2 py-1.5 text-xs text-muted-foreground" title={whoText(t) || undefined}>{whoText(t) || "—"}</td>
                      <td className={cn("px-2 py-1.5 text-right text-xs tabular-nums", toneText(r == null ? "neutral" : r > 0 ? "up" : r < 0 ? "down" : "neutral"))}>{r == null ? "—" : `${r > 0 ? "+" : ""}${r.toFixed(1)}R`}</td>
                      <td className="px-2 py-1.5 text-right"><Pill tone={resultTone(t)}><span title={t.redacted ? redactedHint() : netPnl(t) != null ? commonI18n.t("trading.netPnl") : undefined}>{resultLabel(t)}</span></Pill></td>
                      <td className="px-1 py-1 text-right">
                        <span className="inline-flex">
                          <IconAction aria-label={tr("linked.openTrade", { ticker: t.ticker })} title={tr("linked.openTrade", { ticker: t.ticker })} onClick={() => setLocation(links.trade(t.id))} className="md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100">
                            <ExternalLink />
                          </IconAction>
                          <WriteOnly>
                            <IconAction aria-label={tr("linked.unlinkTrade", { ticker: t.ticker })} title={tr("linked.unlinkTrade", { ticker: t.ticker })} onClick={() => unlink(t)} className="hover:text-down md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100">
                              <Unlink />
                            </IconAction>
                          </WriteOnly>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {linked.some((t) => t.redacted) && <RedactedHint className="mt-2" />}
        </>
      )}

      <Dialog open={linkOpen} onOpenChange={(v) => { setLinkOpen(v); if (!v) setSearch(""); }}>
        <DialogContent className="flex max-h-[85dvh] max-w-3xl flex-col">
          <DialogHeader>
            <DialogTitle>{tr("linked.dialogTitle")}</DialogTitle>
            <DialogDescription>{tr("linked.dialogDesc", { name: entry.name })}</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} aria-label={tr("linked.searchAria")} placeholder={tr("linked.searchPlaceholder")} className="pl-9" autoFocus />
          </div>
          <div className="-mx-2 min-h-0 flex-1 overflow-y-auto">
            {allLoading && <div className="space-y-2 px-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9 rounded-xl" />)}</div>}
            {allError && <p className="py-4 text-center text-sm text-down">{tr("linked.loadFailedShort")}</p>}
            {!allLoading && !allError && suggested.length + rest.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">{search ? commonI18n.t("states.nothingFound") : tr("linked.noneToLink")}</p>
            )}
            {suggested.length > 0 && (
              <div className="mb-2">
                <div className="px-3 pb-1 text-xs text-muted-foreground">{tr("linked.suggested")}</div>
                {suggested.map((t) => tradeRow(t, () => { link(t); setLinkOpen(false); setSearch(""); }))}
              </div>
            )}
            {rest.length > 0 && (
              <div>
                {suggested.length > 0 && <div className="px-3 pb-1 text-xs text-muted-foreground">{tr("linked.rest")}</div>}
                {rest.map((t) => tradeRow(t, () => { link(t); setLinkOpen(false); setSearch(""); }))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </DocSection>
  );
}
