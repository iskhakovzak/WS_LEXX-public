import { memo } from "react";
import { CalendarClock, LineChart, Pin, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UpcomingByTicker } from "./research-preview";
import { Highlight, confidenceTone, noteConfidence, formatDay, noteDay, splitTags, splitTickers, type ResearchNote, type SearchHit } from "./research-utils";
import { fmtDate, fmtUsd } from "@/lib/format";
import { researchI18n } from "@/i18n/ns/research";

const BAR: Record<string, string> = {
  up: "bg-up",
  warn: "bg-[hsl(var(--chart-3))]",
  down: "bg-down",
  neutral: "bg-border",
};
const TXT: Record<string, string> = {
  up: "text-up",
  warn: "text-[hsl(var(--chart-3))]",
  down: "text-down",
  neutral: "text-muted-foreground",
};

export const ResearchRow = memo(function ResearchRow({
  r,
  selected,
  pinned,
  terms,
  hit,
  upcoming,
  showDate,
  onSelect,
  onTogglePin,
}: {
  r: ResearchNote;
  selected: boolean;
  pinned: boolean;
  terms: string[];
  hit?: SearchHit | null;
  upcoming: UpcomingByTicker;
  showDate: boolean;
  onSelect: (id: number) => void;
  onTogglePin: (id: number) => void;
}) {
  const { t: tr } = researchI18n.useT();
  const tickers = splitTickers(r.ticker);
  const tags = splitTags(r.tags);
  const conf = noteConfidence(r);
  const tone = confidenceTone(conf.value);
  const report = tickers.map((t) => upcoming.get(t)).find(Boolean);
  const preview = hit?.snippet ?? r.whatWorked ?? r.context ?? r.marketCondition ?? "";
  const ev = r.evidence && r.evidence.tradeCount > 0 ? r.evidence : null;

  return (
    <div
      className={cn(
        "group relative flex items-stretch rounded-xl transition-colors",
        selected ? "bg-primary/10 ring-1 ring-primary/50" : "hover:bg-[var(--glass-hover-bg)]",
      )}
    >
      <button
        type="button"
        data-research-id={r.id}
        onClick={() => onSelect(r.id)}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 gap-3 rounded-xl py-2.5 pl-3 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden="true" className={cn("mt-0.5 w-0.5 shrink-0 self-stretch rounded-full", BAR[tone])} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-start justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-semibold text-foreground">
              <Highlight text={r.patternName} terms={terms} />
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
              {ev && (
                <span className="inline-flex items-center gap-0.5 text-muted-foreground" title={`${tr("row.evidenceTitle", { count: ev.tradeCount })}${ev.winRate != null ? tr("row.evidenceWr", { value: Math.round(ev.winRate) }) : ""}${ev.netPnl != null ? tr("row.evidenceNet", { value: fmtUsd(ev.netPnl, { decimals: 0 }) }) : ""}`}>
                  <LineChart className="h-3 w-3" aria-hidden="true" />
                  {ev.tradeCount}{ev.winRate != null ? ` · ${Math.round(ev.winRate)}%` : ""}
                </span>
              )}
              {conf.value != null && <span className={TXT[tone]} title={conf.byTrades ? tr("row.confTrades") : tr("row.confManual")}>{conf.value}%</span>}
              {(r.repeatCount ?? 0) > 1 && (
                <span className="inline-flex items-center gap-0.5 text-muted-foreground" title={tr("row.repeats")}>
                  <Repeat className="h-3 w-3" aria-hidden="true" />
                  {r.repeatCount}
                </span>
              )}
            </span>
          </span>
          {preview && (
            <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {hit?.snippetField && <span className="text-foreground/80">{hit.snippetField}: </span>}
              <Highlight text={preview} terms={terms} />
            </span>
          )}
          <span className="flex flex-wrap items-center gap-1.5">
            {tickers.slice(0, 3).map((t) => (
              <span key={t} className="rounded-full bg-primary/15 px-2 py-0.5 text-2xs font-semibold text-primary">
                <Highlight text={t} terms={terms} />
              </span>
            ))}
            {tags.slice(0, 3).map((t) => (
              <span key={t} className="rounded-full bg-[var(--glass-bg)] px-2 py-0.5 text-2xs text-muted-foreground">
                #<Highlight text={t} terms={terms} />
              </span>
            ))}
            {tags.length > 3 && <span className="text-2xs text-muted-foreground">+{tags.length - 3}</span>}
            {report && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--chart-3)/0.15)] px-2 py-0.5 text-2xs font-medium text-[hsl(var(--chart-3))]">
                <CalendarClock className="h-3 w-3" aria-hidden="true" />
                {tr("row.report", { date: fmtDate(report.date, "dayMonth") })}
                {report.callType !== "TNS" ? ` · ${report.callType}` : ""}
              </span>
            )}
            {showDate && <span className="ml-auto text-2xs text-muted-foreground">{formatDay(noteDay(r))}</span>}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onTogglePin(r.id)}
        aria-label={pinned ? tr("row.unpin", { name: r.patternName }) : tr("row.pin", { name: r.patternName })}
        aria-pressed={pinned}
        className={cn(
          "m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-opacity hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          pinned ? "text-primary opacity-100" : "opacity-100 lg:opacity-0 lg:group-hover:opacity-100",
        )}
      >
        <Pin className={cn("h-4 w-4", pinned && "fill-current")} aria-hidden="true" />
      </button>
    </div>
  );
});
