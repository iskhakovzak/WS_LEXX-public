/** Small cells and controls of the watchlist table: inline note, quote freshness, my history, event marks, level cell. */
import * as React from "react";
import { AlertTriangle, RefreshCw, ChevronDown, Check, Newspaper, Briefcase, CircleCheck, CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";
import { toneText } from "@/components/ds";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sessionOf } from "@/components/chart-engine/lib/time";
import { nyDate } from "@/lib/trading-date";
import { type EarningsHit, type KeyLevel, type NewsDigest, type WatchlistItem } from "./lib";
import { QUOTE_INTERVALS, type DayLevelSet, type UpcomingEarnings } from "./use-market";
import type { TickerHistory } from "./use-history";
import { fmtDate, fmtNum, fmtPct, fmtPrice, fmtRate, fmtUsd, fmtWeekday } from "@/lib/format";
import { watchlistI18n } from "@/i18n/ns/watchlist";
import { commonI18n } from "@/i18n/ns/common";

import { personName } from "@/i18n";
const wt = watchlistI18n.t;

/* ── Inline note ─────────────────────────────────────────────────────────── */

/**
 * One-line scenario note right in the row: click (or E on the focused row) → edit, Enter saves,
 * Shift+Enter new line, Esc cancels, leaving the field saves.
 */
export function InlineNote({
  value, canEdit, editing, onEditingChange, onSave, placeholder, className,
}: {
  value: string | null;
  canEdit: boolean;
  editing: boolean;
  onEditingChange: (v: boolean) => void;
  onSave: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = React.useState(value ?? "");
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const cancelled = React.useRef(false);

  React.useEffect(() => {
    if (!editing) return;
    setDraft(value ?? "");
    cancelled.current = false;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      autosize(el);
    });
    // Only when entering edit mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    if (cancelled.current) { cancelled.current = false; onEditingChange(false); return; }
    const next = draft.trim();
    if (next !== (value ?? "").trim()) onSave(next);
    onEditingChange(false);
  };

  if (editing && canEdit) {
    return (
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        aria-label={wt("note.aria")}
        placeholder={placeholder ?? wt("note.placeholder")}
        onChange={(e) => { setDraft(e.target.value); autosize(e.currentTarget); }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ref.current?.blur(); }
          else if (e.key === "Escape") { e.preventDefault(); cancelled.current = true; ref.current?.blur(); }
        }}
        onBlur={commit}
        className={cn(
          "glass-field block w-full resize-none rounded-lg px-2 py-1 text-xs leading-5 text-foreground outline-none ring-1 ring-primary/50",
          className,
        )}
      />
    );
  }

  const text = (value ?? "").trim();
  if (!canEdit) {
    return <span className={cn("block truncate text-xs", text ? "text-foreground/90" : "text-muted-foreground", className)} title={text || undefined}>{text || "—"}</span>;
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onEditingChange(true); }}
      title={text ? wt("note.editTitle", { text }) : wt("note.addTitle")}
      className={cn(
        "block w-full truncate rounded-lg px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        text ? "text-foreground/90" : "text-muted-foreground",
        className,
      )}
    >
      {text ? text.split("\n")[0] : <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{wt("note.add")}</span>}
    </button>
  );
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

/* ── Quote freshness ─────────────────────────────────────────────────────── */

export type MarketState = { label: string; open: boolean };

export function marketState(now = Date.now()): MarketState {
  const today = nyDate(new Date(now));
  const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6) return { label: wt("quote.weekend"), open: false };
  const s = sessionOf(Math.floor(now / 1000));
  if (s === "rth") return { label: wt("quote.open"), open: true };
  if (s === "pre") return { label: wt("quote.pre"), open: true };
  if (s === "post") return { label: wt("quote.post"), open: true };
  return { label: wt("quote.closed"), open: false };
}

function agoShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return wt("quote.agoSec", { count: s });
  const m = Math.round(s / 60);
  if (m < 60) return wt("quote.agoMin", { count: m });
  return wt("quote.agoHour", { count: Math.round(m / 60) });
}

/**
 * Freshness of the quotes: dot (green = fresh, amber = stale, grey = paused / market closed),
 * «обновлено 25 с назад», the market session, the refresh interval and a manual refresh.
 */
export function QuoteStatus({
  updatedAt, fetching, error, interval, onInterval, onRefresh,
}: {
  updatedAt: number;
  fetching: boolean;
  error: boolean;
  interval: number;
  onInterval: (v: number) => void;
  onRefresh: () => void;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 5_000); return () => window.clearInterval(t); }, []);
  const mkt = marketState(now);
  const age = updatedAt ? now - updatedAt : null;
  const staleAfter = Math.max(2 * (interval || 60_000), 3 * 60_000);
  const stale = !error && mkt.open && interval > 0 && age != null && age > staleAfter;
  const state: "error" | "stale" | "live" | "idle" = error ? "error" : stale ? "stale" : interval > 0 && mkt.open ? "live" : "idle";
  const dot = state === "error" ? "bg-down" : state === "stale" ? "bg-warn" : state === "live" ? "bg-up" : "bg-muted-foreground";
  const text =
    error ? wt("quote.unavailable")
    : !updatedAt ? wt("quote.loading")
    : wt(stale ? "quote.staleUpdatedAgo" : "quote.updatedAgo", { ago: agoShort(age ?? 0) });
  const intervalLabel = QUOTE_INTERVALS.find((o) => o.value === interval)?.label ?? wt("quote.min", { count: 1 });

  return (
    <div className="glass-field inline-flex h-9 items-center gap-1 pl-3 pr-1 text-xs" role="status" aria-live="polite">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", dot, state === "live" && "animate-pulse motion-reduce:animate-none")} aria-hidden="true" />
      <span className={cn("ml-1 tabular-nums", stale ? "text-foreground" : "text-muted-foreground")} title={updatedAt ? fmtDate(updatedAt, "timeSeconds") : undefined}>
        {text}
      </span>
      <span className="hidden text-muted-foreground lg:inline" aria-hidden="true">·</span>
      <span className="hidden text-muted-foreground lg:inline">{mkt.label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="ml-1 inline-flex h-7 items-center gap-1 rounded-full px-2 text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={wt("quote.intervalAria", { interval: intervalLabel })}
            title={wt("quote.intervalTitle")}
          >
            {interval > 0 ? wt("quote.every", { interval: intervalLabel }) : wt("quote.paused")}<ChevronDown className="h-3 w-3" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="text-xs text-muted-foreground">{wt("quote.autoRefresh")}</DropdownMenuLabel>
          {QUOTE_INTERVALS.map((o) => (
            <DropdownMenuItem key={o.value} onSelect={() => onInterval(o.value)}>
              <Check className={cn("mr-2 h-4 w-4", o.value === interval ? "opacity-100" : "opacity-0")} />
              {o.value === 0 ? wt("quote.pause") : wt("quote.everyCap", { interval: o.label })}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{wt("quote.cacheNote")}</p>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        onClick={onRefresh}
        disabled={fetching}
        aria-label={wt("quote.refreshAria")}
        title={wt("quote.refreshTitle")}
        className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground disabled:opacity-50"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", fetching && "animate-spin motion-reduce:animate-none")} />
      </button>
    </div>
  );
}

/* ── My history on the ticker ────────────────────────────────────────────── */

const wrText = (wr: number | null) => fmtRate(wr);

/** «−$300 · 33% · 6» — net coloured as money; a warning icon when the trader keeps losing on the name. */
export function HistoryCell({ history, me, compact = true }: { history?: TickerHistory; me: string | null; compact?: boolean }) {
  if (!me) return <span className="text-xs text-muted-foreground">—</span>;
  if (!history || history.n === 0) return <span className="text-xs text-muted-foreground">{wt("history.notTraded")}</span>;
  const h = history;
  const losing = h.net < 0 && h.n >= 2;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums" tabIndex={0}>
          {losing && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-down" aria-label={wt("history.losingAria")} />}
          <span className={cn("font-medium", toneText(h.net > 0 ? "up" : h.net < 0 ? "down" : "neutral"))}>{fmtUsd(h.net, { signed: true, decimals: 0 })}</span>
          <span className="text-muted-foreground">{compact ? "·" : "· WR"} {wrText(h.wr)} · {h.n}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        <p className="font-medium">
          {losing ? wt("history.losing", { net: fmtUsd(h.net, { signed: true, decimals: 0 }) }) : h.net > 0 ? wt("history.winning", { net: fmtUsd(h.net, { signed: true, decimals: 0 }) }) : wt("history.flat")}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {wt("history.summary", { trades: commonI18n.t("units.tradesShort", { count: h.n }), wins: h.wins, losses: h.losses, wr: wrText(h.wr) })}
          {h.avg != null ? ` · ${wt("history.avg", { value: fmtUsd(h.avg, { signed: true, decimals: 0 }) })}` : ""}
          {h.lastDate ? ` · ${wt("history.last", { date: fmtDate(h.lastDate.slice(0, 10), "dayMonthNumeric") })}` : ""}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}


/* ── Event marks next to the ticker ──────────────────────────────────────── */

export function EventMarks({
  item, earnings, upcoming, news, today,
}: { item: WatchlistItem; earnings?: EarningsHit; upcoming?: UpcomingEarnings; news?: NewsDigest; today: string }) {
  const marks: React.ReactNode[] = [];
  if (earnings) {
    marks.push(
      <span key="e" className="inline-flex h-5 items-center gap-0.5 rounded-full bg-purple/15 px-1.5 text-xs font-medium text-purple"
        title={earnings.when === "today" ? wt("marks.earnToday", { call: earnings.callType }) : `${wt("marks.earnYesterday")}${earnings.epsSurprisePct != null ? ` · EPS ${fmtPct(earnings.epsSurprisePct, 1)}` : ""}`}>
        <CalendarClock className="h-3 w-3" aria-hidden="true" />{earnings.when === "today" ? earnings.callType : "AMC"}
      </span>,
    );
  } else if (upcoming && upcoming.date >= today) {
    const wd = fmtWeekday(upcoming.date.slice(0, 10), "short");
    marks.push(
      <span key="u" className="inline-flex h-5 items-center gap-0.5 rounded-full border border-purple/40 px-1.5 text-xs text-purple"
        title={wt("marks.earnOn", { date: fmtDate(upcoming.date.slice(0, 10), "dayMonthNumeric"), call: upcoming.callType })}>
        <CalendarClock className="h-3 w-3" aria-hidden="true" />{upcoming.date === today ? upcoming.callType : wd}
      </span>,
    );
  }
  if (news && news.count24h > 0) {
    marks.push(
      <span key="n" className="inline-flex h-5 items-center gap-0.5 text-xs text-muted-foreground" title={news.latest?.title ? `${wt("marks.news", { count: news.count24h })}\n${news.latest.title}` : wt("marks.news", { count: news.count24h })}>
        <Newspaper className="h-3 w-3" aria-hidden="true" />{news.count24h}
      </span>,
    );
  }
  if ((item.openPositions ?? 0) > 0) {
    marks.push(
      <span key="p" className="inline-flex h-5 items-center gap-0.5 text-xs text-primary" title={wt("marks.openPosition", { traders: (item.openTraders ?? []).map(personName).join(", ") || "—" })}>
        <Briefcase className="h-3 w-3" aria-hidden="true" />{(item.openPositions ?? 0) > 1 ? item.openPositions : ""}
        <span className="sr-only">{wt("marks.inPosition")}</span>
      </span>,
    );
  }
  if (item.status === "traded" || item.tradedToday) {
    marks.push(
      <span key="t" className="inline-flex h-5 items-center text-muted-foreground" title={item.tradedToday ? wt("marks.tradedToday") : wt("marks.markedTraded")}>
        <CircleCheck className="h-3 w-3" aria-hidden="true" /><span className="sr-only">{wt("marks.traded")}</span>
      </span>,
    );
  }
  if (!marks.length) return null;
  return <span className="inline-flex items-center gap-1.5">{marks}</span>;
}

/* ── Nearest key level ───────────────────────────────────────────────────── */

/** Nearest level (PDH/PDL/VWAP/stop/target) with distance in % and ATR, plus a mini PDL–PDH bar with the price. */
export function LevelCell({ price, levels, keys, loading }: { price: number | null | undefined; levels: DayLevelSet | null | undefined; keys: KeyLevel[]; loading: boolean }) {
  if (price == null) return <span className="text-xs text-muted-foreground">—</span>;
  if (levels === undefined && loading) return <span className="inline-block h-3 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" aria-label={wt("levelCell.loading")} />;
  const near = keys[0];
  if (!near) return <span className="text-xs text-muted-foreground">{wt("levelCell.none")}</span>;
  const close = near.distAtr != null ? near.distAtr <= 0.25 : Math.abs(near.distPct) <= 0.5;
  const pdh = levels?.pdh ?? null;
  const pdl = levels?.pdl ?? null;
  const range = pdh != null && pdl != null && pdh > pdl ? pdh - pdl : null;
  const pos = range != null ? Math.max(0, Math.min(1, (price - (pdl as number)) / range)) : null;
  const outside = range != null && (price > (pdh as number) || price < (pdl as number));
  return (
    <div
      className="min-w-0 overflow-hidden"
      title={keys.slice(0, 4).map((k) => `${k.label} ${fmtPrice(k.price)} (${fmtPct(k.distPct, 2)}${k.distAtr != null ? ` · ${k.distAtr.toFixed(2)} ATR` : ""})`).join("\n")}
    >
      <div className="flex items-baseline gap-1.5 whitespace-nowrap text-xs tabular-nums">
        <span className={cn("font-medium", close ? "text-primary" : "text-foreground")}>{near.label}</span>
        <span className="text-muted-foreground">{fmtPrice(near.price)}</span>
        <span className={cn("truncate", close ? "text-primary" : "text-muted-foreground")}>
          {near.distPct >= 0 ? "↑" : "↓"}
          {near.distAtr != null ? `${fmtNum(near.distAtr, 1)} ATR` : fmtPct(Math.abs(near.distPct), { decimals: 1, signed: false })}
        </span>
      </div>
      {pos != null && (
        <div className="relative mt-1 h-1 w-full max-w-[140px] rounded-full bg-[var(--glass-bg)]" aria-hidden="true">
          <span className={cn("absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full", outside ? "bg-primary" : "bg-foreground/70")} style={{ left: `${pos * 100}%` }} />
        </div>
      )}
    </div>
  );
}
