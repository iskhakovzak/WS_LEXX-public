import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import type { MarketEvent } from "@workspace/api-client-react";
import { Pencil, Trash2, LineChart, History, ArrowLeftRight, Info, Wand2, ExternalLink, Link2, Unlink, BookOpen, MessageSquare } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Pill, StatRow, TermLabel, toneOf, toneText } from "@/components/ds";
import { AddToPlaybookButton } from "@/components/add-to-playbook";
import { ScreenshotDisplay } from "@/components/screenshot-fields";
import { ApiError, http } from "@/lib/api/http";
import { nullIfMissing } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { links } from "@/lib/links";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { fmtCompact, fmtPct, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import { humanizeApiError } from "@/lib/api/errors";
import {
  dayOf, displayTags, fmtDay, getSession, eventTone, reactionMeta, splitTickers, typeMeta,
} from "./event-meta";
import { MoveValue, ReactionPill, SessionPill, TagChips, TypePill } from "./event-pills";
import { eventsI18n } from "@/i18n/ns/events";
import { commonI18n } from "@/i18n/ns/common";

import { personName } from "@/i18n";
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type ReactionResult =
  | { kind: "ok"; gap: number | null; day: number | null; openToClose: number; range: number; volume: number; close: number; prevClose: number | null }
  | { kind: "none"; reason: "future" | "weekend" | "noTrading" | "noData" };

const REASON_KEY = { future: "detail.reasonFuture", weekend: "detail.reasonWeekend", noTrading: "detail.reasonNoTrading", noData: "detail.reasonNoData" } as const;

async function fetchReaction(ticker: string, date: string): Promise<ReactionResult> {
  let j: { candles: Candle[]; prevClose: number | null };
  try {
    j = await http.get<{ candles: Candle[]; prevClose: number | null }>(`/api/candles/${encodeURIComponent(ticker)}?date=${encodeURIComponent(date)}&interval=1d`);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.status === 422) {
      const reason = e.field<string>("reason");
      return { kind: "none", reason: reason === "future" ? "future" : reason === "weekend" ? "weekend" : "noTrading" };
    }
    if (e.status === 404 || e.status === 400) return { kind: "none", reason: "noData" };
    throw e;
  }
  const cs = j.candles ?? [];
  if (!cs.length) return { kind: "none", reason: "noData" };
  const o = cs[0].o, c = cs[cs.length - 1].c;
  const h = Math.max(...cs.map((x) => x.h)), l = Math.min(...cs.map((x) => x.l));
  const pc = j.prevClose;
  return {
    kind: "ok",
    gap: pc ? ((o - pc) / pc) * 100 : null,
    day: pc ? ((c - pc) / pc) * 100 : null,
    openToClose: o ? ((c - o) / o) * 100 : 0,
    range: o ? ((h - l) / o) * 100 : 0,
    volume: cs.reduce((s, x) => s + (x.v || 0), 0),
    close: c,
    prevClose: pc,
  };
}

/* `GET /api/events/:id/trades` — candidates (same ticker, event day) + explicitly linked trades; numbers from the shared API math. */
type LinkedTrade = {
  id: number; ticker: string; date: string; exitDate: string | null; closeDate: string; side: string | null; setup: string | null;
  result: string | null; horizon: string | null; pnl: number | null; fees: number | null; netPnl: number | null; rMultiple: number | null; signedR: number | null;
  trader: string | null; source: string | null; brokerAccount: string | null; qty: number | null; linked: boolean;
};
type TradeStats = { n: number; wins: number; losses: number; be: number; open: number; winRate: number | null; sumR: number; grossPnl: number; fees: number; netPnl: number; byAccount: { account: string; n: number; grossPnl: number; fees: number; netPnl: number }[] };
type TradesPayload = { scope: string | null; trades: LinkedTrade[]; stats: TradeStats };

function Section({ icon: Icon, title, actions, children }: { icon: React.ElementType; title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="glass-panel rounded-2xl p-4">
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-xl bg-[var(--glass-bg)] p-3">
      <div className="micro-label">{label}</div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums", toneText(toneOf(value)))}>{fmtPct(value, 1)}</div>
    </div>
  );
}

function ReactionBlock({ event, onFill, filling }: { event: MarketEvent; onFill: (day: number, gap: number | null) => void; filling: boolean }) {
  const { t } = eventsI18n.useT();
  const tickers = splitTickers(event.ticker).slice(0, 8);
  const [ticker, setTicker] = React.useState(tickers[0] ?? "");
  React.useEffect(() => setTicker(splitTickers(event.ticker)[0] ?? ""), [event.id, event.ticker]);
  const date = dayOf(event);
  const valid = /^[A-Z][A-Z0-9.-]{0,10}$/.test(ticker);
  const q = useQuery({
    queryKey: ["event-reaction", ticker, date],
    queryFn: () => fetchReaction(ticker, date),
    enabled: valid,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
  const logged = event.percentMove;

  return (
    <Section icon={LineChart} title={t("detail.reactionTitle")}>
      <div className="mb-3 flex flex-wrap items-end gap-4">
        <div>
          <div className="micro-label">{t("detail.logged")}</div>
          <MoveValue value={logged} className="text-2xl" />
        </div>
        <ReactionPill reaction={event.reaction} />
        {event.volume && <span className="text-xs text-muted-foreground">{t("detail.volume", { value: event.volume })}</span>}
      </div>

      {tickers.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label={t("detail.chartTicker")}>
          {tickers.map((t) => (
            <button key={t} type="button" aria-pressed={t === ticker} onClick={() => setTicker(t)} className="chip min-h-7 px-2.5 text-xs font-medium">{t}</button>
          ))}
        </div>
      )}

      {!valid ? (
        <p className="text-xs text-muted-foreground">{t("detail.noTicker")}</p>
      ) : q.isLoading ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
        </div>
      ) : q.isError ? (
        <p className="text-xs text-muted-foreground">{t("detail.quotesFailed")} <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => q.refetch()}>{commonI18n.t("actions.retry")}</button></p>
      ) : q.data?.kind === "none" ? (
        <p className="text-xs text-muted-foreground">{t(REASON_KEY[q.data.reason])}</p>
      ) : q.data?.kind === "ok" ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label={t("detail.gap")} value={q.data.gap} />
            <Metric label={t("detail.day")} value={q.data.day} />
            <Metric label={t("detail.openToClose")} value={q.data.openToClose} />
            <div className="rounded-xl bg-[var(--glass-bg)] p-3">
              <div className="micro-label">{t("detail.range")}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{q.data.range.toFixed(1)}%</div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">{t("detail.close", { ticker, close: fmtPrice(q.data.close) })}{q.data.prevClose ? t("detail.prevClose", { price: fmtPrice(q.data.prevClose) }) : ""}</span>
            {q.data.volume > 0 && <span className="tabular-nums">{t("detail.volumeLower", { value: fmtCompact(q.data.volume) })}</span>}
            {logged == null && q.data.day != null && (
              <Button size="sm" variant="outline" className="ml-auto" disabled={filling} onClick={() => { const d = q.data; if (d?.kind === "ok" && d.day != null) onFill(d.day, d.gap); }}>
                <Wand2 /> {filling ? t("detail.saving") : t("detail.fillFromQuotes")}
              </Button>
            )}
          </div>
        </>
      ) : null}
    </Section>
  );
}

function HistoryBlock({ event, all, onOpen }: { event: MarketEvent; all: MarketEvent[]; onOpen: (e: MarketEvent) => void }) {
  const { t } = eventsI18n.useT();
  const tickers = new Set(splitTickers(event.ticker));
  const items = all
    .filter((e) => e.id !== event.id && splitTickers(e.ticker).some((t) => tickers.has(t)))
    .sort((a, b) => dayOf(b).localeCompare(dayOf(a)));
  const moves = items.map((e) => e.percentMove).filter((v): v is number => v != null);
  const avgAbs = moves.length ? moves.reduce((s, v) => s + Math.abs(v), 0) / moves.length : null;
  const ups = items.filter((e) => eventTone(e) === "up").length;
  const dirKnown = items.filter((e) => eventTone(e) !== "neutral").length;

  return (
    <Section icon={History} title={t("detail.historyTitle")}>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("detail.historyEmpty", { tickers: [...tickers].slice(0, 3).join(", ") })}</p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap gap-1.5">
            <Pill tone="neutral">{t("detail.earlier", { count: items.length })}</Pill>
            {avgAbs != null && <Pill tone="accent">{t("detail.avgMove", { value: avgAbs.toFixed(1) })}</Pill>}
            {dirKnown > 0 && <Pill tone={ups / dirKnown >= 0.5 ? "up" : "down"}>{t("detail.up", { value: Math.round((ups / dirKnown) * 100) })}</Pill>}
          </div>
          <ul className="flex flex-col">
            {items.slice(0, 8).map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => onOpen(e)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground">{fmtDay(dayOf(e), { day: "numeric", month: "short", year: "2-digit" })}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground/90">{e.headline}</span>
                  <span className="hidden sm:inline"><TypePill type={e.eventType} className="text-2xs" /></span>
                  <MoveValue value={e.percentMove} className="w-14 shrink-0 text-right text-xs" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function TradesBlock({ event }: { event: MarketEvent }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t: tr } = eventsI18n.useT();
  const q = useQuery({
    queryKey: ["event-trades", event.id],
    queryFn: ({ signal }): Promise<TradesPayload | null> =>
      http.get<TradesPayload>(`/api/events/${event.id}/trades`, { signal }).catch(nullIfMissing),
    staleTime: STALE.short,
    retry: false,
  });
  const link = useMutation({
    mutationFn: async ({ tradeId, unlink }: { tradeId: number; unlink: boolean }) => {
      await http.post(`/api/events/${event.id}/link-trade`, { tradeId, unlink });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["event-trades", event.id] }); void qc.invalidateQueries({ queryKey: ["events-today"] }); },
    onError: (e) => toast({ title: eventsI18n.t("toast.linkFailed"), description: humanizeApiError(e), variant: "destructive" }),
  });
  if (q.data === null) return null; // endpoint not deployed yet
  const day = dayOf(event);
  const ticker = splitTickers(event.ticker)[0];
  const stats = q.data?.stats;
  const linked = (q.data?.trades ?? []).filter((t) => t.linked);
  const candidates = (q.data?.trades ?? []).filter((t) => !t.linked);

  const row = (t: LinkedTrade) => {
    const res = t.result?.toLowerCase();
    const tone = res === "win" ? "up" : res === "loss" ? "down" : "neutral";
    const r = t.signedR ?? t.rMultiple;
    return (
      <li key={t.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--glass-hover-bg)]">
        <Link href={links.trade(t.id)} className="flex min-w-0 flex-1 items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="font-semibold text-foreground">{t.ticker}</span>
          {t.side && <span className="text-xs text-muted-foreground">{t.side}</span>}
          {t.setup ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t.setup}</span> : <span className="flex-1" />}
          {t.trader && <span className="hidden text-xs text-muted-foreground sm:inline">{personName(t.trader)}</span>}
          {t.brokerAccount && <span className="hidden text-2xs text-muted-foreground lg:inline">{t.brokerAccount}</span>}
          {r != null && <span className={cn("text-xs font-semibold tabular-nums", toneText(toneOf(r)))}>{fmtR(r, 1)}</span>}
          {t.netPnl != null && <span className={cn("text-xs tabular-nums", toneText(toneOf(t.netPnl)))} title={tr("detail.grossFees", { gross: fmtUsd(t.pnl, { decimals: 0 }), fees: fmtUsd(t.fees, { decimals: 0 }) })}>{fmtUsd(t.netPnl, { decimals: 0 })}</span>}
          <Pill tone={tone} className="text-2xs">{t.result ?? "open"}</Pill>
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        </Link>
        <button
          type="button"
          aria-label={t.linked ? tr("detail.unlinkAria") : tr("detail.linkAria")}
          title={t.linked ? tr("detail.unlink") : tr("detail.link")}
          disabled={link.isPending}
          onClick={() => link.mutate({ tradeId: t.id, unlink: t.linked })}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-bg)] hover:text-foreground"
        >
          {t.linked ? <Unlink className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
        </button>
      </li>
    );
  };

  return (
    <Section
      icon={ArrowLeftRight}
      title={tr("detail.tradesTitle")}
      actions={
        <>
          {q.data?.scope && <Pill tone="neutral" className="text-2xs">{q.data.scope}</Pill>}
          <Link href={links.trades({ ticker, date: day })} className="text-xs text-primary hover:underline">{tr("detail.allTrades")}</Link>
          <Link href={links.journalDay(day)} className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><BookOpen className="h-3 w-3" aria-hidden="true" />{tr("detail.journal")}</Link>
          <Link href={links.newThread({ ticker })} className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><MessageSquare className="h-3 w-3" aria-hidden="true" />{tr("detail.discuss")}</Link>
        </>
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-10 rounded-xl" />
      ) : q.isError ? (
        <p className="text-xs text-muted-foreground">{tr("detail.tradesFailed")}</p>
      ) : !q.data?.trades.length ? (
        <p className="text-xs text-muted-foreground">{tr("detail.noTrades", { tickers: splitTickers(event.ticker).slice(0, 3).join(", "), date: fmtDay(day) })}</p>
      ) : (
        <>
          {stats && stats.n > 0 && (
            <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-xl bg-[var(--glass-bg)] p-2.5">
                <div className="micro-label">{tr("detail.tradesCount")}</div>
                <div className="mt-0.5 text-base font-semibold tabular-nums">{stats.n}{stats.open ? <span className="text-xs text-muted-foreground">{tr("detail.openCount", { count: stats.open })}</span> : null}</div>
              </div>
              <div className="rounded-xl bg-[var(--glass-bg)] p-2.5">
                <div className="micro-label">Win rate</div>
                <div className="mt-0.5 text-base font-semibold tabular-nums">{stats.winRate != null ? `${Math.round(stats.winRate)}%` : "—"}<span className="text-xs text-muted-foreground"> {stats.wins}/{stats.losses}{stats.be ? ` · BE ${stats.be}` : ""}</span></div>
              </div>
              <div className="rounded-xl bg-[var(--glass-bg)] p-2.5">
                <div className="micro-label">ΣR</div>
                <div className={cn("mt-0.5 text-base font-semibold tabular-nums", toneText(toneOf(stats.sumR)))}>{fmtR(stats.sumR, 1)}</div>
              </div>
              <div className="rounded-xl bg-[var(--glass-bg)] p-2.5" title={tr("detail.grossFees", { gross: fmtUsd(stats.grossPnl, { decimals: 0 }), fees: fmtUsd(stats.fees, { decimals: 0 }) })}>
                <div className="micro-label">{commonI18n.t("trading.netPnl")}</div>
                <div className={cn("mt-0.5 text-base font-semibold tabular-nums", toneText(toneOf(stats.netPnl)))}>{fmtUsd(stats.netPnl, { decimals: 0 })}</div>
                <div className="text-2xs text-muted-foreground">{tr("detail.gross", { value: fmtUsd(stats.grossPnl, { decimals: 0 }) })}</div>
              </div>
            </div>
          )}
          {stats && stats.byAccount.length > 1 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {stats.byAccount.map((a) => (
                <Pill key={a.account} tone={toneOf(a.netPnl)} className="text-2xs">{a.account}: {fmtUsd(a.netPnl, { decimals: 0 })} · {a.n}</Pill>
              ))}
            </div>
          )}
          {linked.length > 0 && (
            <>
              <div className="micro-label mb-1">{tr("detail.linked")}</div>
              <ul className="flex flex-col">{linked.map(row)}</ul>
            </>
          )}
          {candidates.length > 0 && (
            <>
              <div className="micro-label mb-1 mt-2">{tr("detail.sameDay")}</div>
              <ul className="flex flex-col">{candidates.map(row)}</ul>
            </>
          )}
        </>
      )}
    </Section>
  );
}

export function EventDetailSheet({
  event, all, open, onOpenChange, onEdit, onDelete, onOpenEvent, onPatch, patching,
}: {
  event: MarketEvent | null;
  all: MarketEvent[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onEdit: (e: MarketEvent) => void;
  onDelete: (e: MarketEvent) => void;
  onOpenEvent: (e: MarketEvent) => void;
  onPatch: (id: number, body: Record<string, unknown>) => Promise<void>;
  patching?: boolean;
}) {
  const { t } = eventsI18n.useT();
  const e = event;
  const fundamentals = e ? ([
    [t("detail.company"), e.longName],
    [commonI18n.t("trading.sector"), e.sector],
    [commonI18n.t("trading.marketCap"), e.marketCap],
    ["Float", e.float],
    [t("detail.adv"), e.adv],
    ["ATR", e.atr != null ? e.atr.toFixed(2) : null],
    ["RVOL", e.relativeVolume != null ? `${e.relativeVolume.toFixed(2)}×` : null],
    ["Beta", e.beta != null ? e.beta.toFixed(2) : null],
    ["Short interest", e.shortInterest != null ? `${e.shortInterest.toFixed(1)}%` : null],
  ] as const).filter(([, v]) => v != null && v !== "") : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl [&>*]:shrink-0">
        {e && (
          <>
            <SheetHeader className="space-y-2 p-5 pb-3 pr-14 text-left">
              <div className="flex flex-wrap items-center gap-1.5">
                <TypePill type={e.eventType} />
                <SessionPill session={getSession(e)} />
                <span className="text-xs tabular-nums text-muted-foreground">{fmtDay(dayOf(e), { weekday: "short", day: "numeric", month: "long", year: "numeric" })}</span>
              </div>
              <SheetTitle className="text-2xl font-semibold tracking-tight">{e.ticker}</SheetTitle>
              <SheetDescription className="text-sm text-foreground/90">{e.headline}</SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => onEdit(e)}><Pencil /> {t("detail.edit")}</Button>
                <AddToPlaybookButton
                  payload={{
                    name: `${e.ticker} ${typeMeta(e.eventType).label} (${dayOf(e)})`,
                    setupType: /earn/i.test(e.eventType) ? "Earnings Gap Up" : /momentum/i.test(e.eventType) ? "Intraday Momentum" : /ipo/i.test(e.eventType) ? "IPO Day Trade" : undefined,
                    conditions: e.headline || undefined,
                    notes: [e.summary, e.reaction ? t("detail.pbReaction", { value: reactionMeta(e.reaction)?.label ?? e.reaction }) : "", e.percentMove != null ? t("detail.pbMove", { value: fmtPct(e.percentMove, 1) }) : "", e.volume ? t("detail.pbVolume", { value: e.volume }) : ""].filter(Boolean).join("\n") || undefined,
                    screenshotUrl: e.screenshotUrl || undefined,
                    screenshotNotes: e.screenshotNotes || undefined,
                    tags: displayTags(e.tags).join(", ") || undefined,
                    ticker: splitTickers(e.ticker)[0],
                    marketCap: e.marketCap, float: e.float, adv: e.adv, atr: e.atr, relativeVolume: e.relativeVolume,
                    beta: e.beta, shortInterest: e.shortInterest, sector: e.sector, longName: e.longName,
                    sourceType: "event",
                    sourceId: e.id,
                  }}
                />
                <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-down" onClick={() => onDelete(e)}><Trash2 /> {commonI18n.t("actions.delete")}</Button>
              </div>
            </SheetHeader>

            <div className="flex flex-col gap-3 px-5 pb-6">
              <ReactionBlock
                event={e}
                filling={!!patching}
                onFill={(day, gap) => {
                  const body: Record<string, unknown> = { percentMove: Math.round(day * 100) / 100 };
                  if (!e.reaction && gap != null && Math.abs(gap) >= 1) body.reaction = gap > 0 ? "gap_up" : "gap_down";
                  void onPatch(e.id, body);
                }}
              />

              {e.summary && (
                <Section icon={Info} title={t("detail.notes")}>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{e.summary}</p>
                </Section>
              )}

              {displayTags(e.tags).length > 0 && <TagChips tags={e.tags} />}

              {e.screenshotUrl && (
                <section className="glass-panel rounded-2xl p-4">
                  <ScreenshotDisplay
                    urls={e.screenshotUrl}
                    notes={e.screenshotNotes}
                    onNotesChange={(notes) => { void onPatch(e.id, { screenshotNotes: notes }); }}
                  />
                </section>
              )}

              <TradesBlock event={e} />
              <HistoryBlock event={e} all={all} onOpen={onOpenEvent} />

              {fundamentals.length > 0 && (
                <Section icon={Info} title={t("detail.profile")}>
                  <div className="divide-y divide-border/60">
                    {fundamentals.map(([k, v]) => <StatRow key={k} label={<TermLabel text={k} />} value={v} />)}
                  </div>
                </Section>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
