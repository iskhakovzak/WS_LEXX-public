import { useState } from "react";
import { CalendarClock, ChevronDown, Link2, Pencil, Pin, PinOff, Repeat, Trash2, UserRound } from "lucide-react";
import { Pill, StatRow, TermLabel } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { WriteOnly } from "@/contexts/auth-context";
import { AddToPlaybookButton } from "@/components/add-to-playbook";
import { ScreenshotDisplay } from "@/components/screenshot-fields";
import { cn } from "@/lib/utils";
import { EarningsHistoryView, CallTypePill } from "./earnings-history";
import { type UpcomingItem } from "@/components/shared/market/earnings-api";
import { fmtDate, fmtUsd } from "@/lib/format";
import { ResearchEvidence } from "./research-evidence";
import { Highlight, confidenceTone, noteConfidence, formatDay, noteDay, splitTags, splitTickers, type ResearchNote } from "./research-utils";
import { commonI18n } from "@/i18n/ns/common";
import { researchI18n } from "@/i18n/ns/research";
import { rich } from "@/i18n/rich";

import { personName } from "@/i18n";
function Section({
  label,
  text,
  terms,
  tone,
}: {
  label: string;
  text?: string | null;
  terms: string[];
  tone?: "up" | "down";
}) {
  if (!text) return null;
  return (
    <section
      className={cn(
        "rounded-xl p-3.5",
        tone === "up" ? "bg-up/10" : tone === "down" ? "bg-down/10" : "bg-[var(--glass-bg)]",
      )}
    >
      <h3 className={cn("micro-label mb-1.5", tone === "up" && "text-up", tone === "down" && "text-down")}>{label}</h3>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
        <Highlight text={text} terms={terms} />
      </p>
    </section>
  );
}

export type UpcomingByTicker = Map<string, UpcomingItem & { date: string }>;

export function ResearchPreview({
  r,
  terms,
  pinned,
  related,
  upcoming,
  onTogglePin,
  onEdit,
  onDelete,
  onSelect,
  onSaveScreenshotNotes,
}: {
  r: ResearchNote;
  terms: string[];
  pinned: boolean;
  related: ResearchNote[];
  upcoming: UpcomingByTicker;
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSelect: (id: number) => void;
  onSaveScreenshotNotes: (notes: string) => void;
}) {
  const { t } = researchI18n.useT();
  const tickers = splitTickers(r.ticker);
  const tags = splitTags(r.tags);
  // Confidence: the manual slider until the note has real evidence (≥5 closed trades), then the observed win rate.
  const { value: conf, byTrades } = noteConfidence(r);
  const tone = confidenceTone(conf);
  const [histTicker, setHistTicker] = useState<string | null>(null);
  const activeHist = histTicker && tickers.includes(histTicker) ? histTicker : tickers[0] ?? null;
  // Collapsed by default: the history is an external fetch; open it on demand.
  const [showHist, setShowHist] = useState(false);
  const nextReport = activeHist ? upcoming.get(activeHist) : undefined;

  const fundamentals: [string, string | null | undefined][] = [
    [commonI18n.t("trading.marketCap"), r.marketCap],
    ["Float", r.float],
    [t("preview.avgVolume"), r.adv],
    ["ATR", r.atr != null ? String(r.atr) : null],
    ["RelVol", r.relativeVolume != null ? `${r.relativeVolume}×` : null],
    ["Beta", r.beta != null ? String(r.beta) : null],
    ["Short interest", r.shortInterest != null ? `${r.shortInterest}%` : null],
  ];
  const hasFund = fundamentals.some(([, v]) => v);

  return (
    <article className="flex flex-col gap-4" aria-label={r.patternName}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="first-letter:uppercase" title={t("preview.tradingDay", { date: noteDay(r) })}>{formatDay(noteDay(r))}</span>
          {r.createdBy && <><span aria-hidden="true">·</span><span className="inline-flex items-center gap-1"><UserRound className="h-3 w-3" aria-hidden="true" />{personName(r.createdBy)}</span></>}
          {r.sector && <><span aria-hidden="true">·</span><span>{r.sector}</span></>}
          {pinned && <Pill tone="accent"><Pin className="h-3 w-3" aria-hidden="true" />{t("preview.pinned")}</Pill>}
        </div>
        <h2 className="text-xl font-semibold leading-tight tracking-tight">
          <Highlight text={r.patternName} terms={terms} />
        </h2>
        {(tickers.length > 0 || r.longName) && (
          <div className="flex flex-wrap items-center gap-2">
            {tickers.map((t) => (
              <Pill key={t} tone="accent" className="text-sm">{t}</Pill>
            ))}
            {r.longName && <span className="text-sm text-muted-foreground">{r.longName}</span>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onTogglePin} aria-pressed={pinned}>
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            {pinned ? commonI18n.t("actions.unpin") : commonI18n.t("actions.pin")}
          </Button>
          <WriteOnly>
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" /> {commonI18n.t("actions.edit")}
            </Button>
            <AddToPlaybookButton
              payload={{
                name: `${r.patternName} ${r.ticker ? `(${r.ticker})` : ""}`.trim(),
                conditions: r.whatWorked || undefined,
                notes: [r.context, r.whatFailed ? t("preview.whatFailedPb", { text: r.whatFailed }) : ""].filter(Boolean).join("\n") || undefined,
                screenshotUrl: r.screenshotUrl || undefined,
                screenshotNotes: r.screenshotNotes || undefined,
                tags: r.tags || undefined,
                sourceType: "research",
                sourceId: r.id,
              }}
            />
            <Button variant="ghost" size="sm" onClick={onDelete} className="text-down">
              <Trash2 className="h-3.5 w-3.5" /> {commonI18n.t("actions.delete")}
            </Button>
          </WriteOnly>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-[var(--glass-bg)] p-3">
          <div className="text-xs text-muted-foreground" title={byTrades ? t("preview.confTradesTitle") : t("preview.confManualTitle")}>
            {t("preview.confidence")} <span className="text-2xs">· {byTrades ? t("preview.byTrades") : t("preview.manual")}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className={cn("text-lg font-semibold tabular-nums", tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-[hsl(var(--chart-3))]" : "")}>
              {conf != null ? `${conf}%` : "—"}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border" aria-hidden="true">
              <div
                className={cn("h-full rounded-full", tone === "up" ? "bg-up" : tone === "down" ? "bg-down" : "bg-[hsl(var(--chart-3))]")}
                style={{ width: `${Math.min(100, Math.max(0, conf ?? 0))}%` }}
              />
            </div>
          </div>
        </div>
        <div className="rounded-xl bg-[var(--glass-bg)] p-3">
          <div className="flex items-center gap-1 text-xs text-muted-foreground"><Repeat className="h-3 w-3" aria-hidden="true" /> {t("row.repeats")}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{r.repeatCount ?? 0}</div>
        </div>
      </div>

      <ResearchEvidence r={r} />

      {nextReport && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-primary/10 p-3 text-sm">
          <CalendarClock className="h-4 w-4 text-primary" aria-hidden="true" />
          <span>
            {rich(t("preview.nextReport", { ticker: nextReport.ticker, date: "{date}" }), { date: <b className="font-semibold">{fmtDate(nextReport.date, "weekdayDayMonth")}</b> })}
          </span>
          <CallTypePill type={nextReport.callType} />
          {nextReport.epsEstimate != null && <span className="text-muted-foreground">{t("preview.epsEstimate", { value: fmtUsd(nextReport.epsEstimate) })}</span>}
        </div>
      )}

      <Section label={t("field.context")} text={r.context} terms={terms} />
      <Section label={t("field.marketCondition")} text={r.marketCondition} terms={terms} />
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section label={t("field.whatWorked")} text={r.whatWorked} terms={terms} tone="up" />
        <Section label={t("field.whatFailed")} text={r.whatFailed} terms={terms} tone="down" />
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <Pill key={t} tone="neutral">#<Highlight text={t} terms={terms} /></Pill>
          ))}
        </div>
      )}

      {r.screenshotUrl && (
        <ScreenshotDisplay urls={r.screenshotUrl} notes={r.screenshotNotes} onNotesChange={onSaveScreenshotNotes} />
      )}

      {hasFund && (
        <section className="rounded-xl bg-[var(--glass-bg)] px-3.5 py-2">
          <h3 className="micro-label pt-1.5">{t("preview.fundamentals")}</h3>
          <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            {fundamentals.filter(([, v]) => v).map(([k, v]) => (
              <StatRow key={k} label={<TermLabel text={k} />} value={v} />
            ))}
          </div>
        </section>
      )}

      {activeHist && (
        <section className="rounded-xl border border-border/70 p-3.5">
          <button
            type="button"
            onClick={() => setShowHist((v) => !v)}
            aria-expanded={showHist}
            className="flex w-full items-center justify-between gap-2 text-left"
          >
            <span className="text-sm font-semibold">{t("preview.reportsToggle", { ticker: activeHist })}</span>
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", !showHist && "-rotate-90")} aria-hidden="true" />
          </button>
          {tickers.length > 1 && showHist && (
            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("preview.historyTicker")}>
              {tickers.map((t) => (
                <button key={t} type="button" className="chip min-h-7 px-2.5 text-xs" aria-pressed={t === activeHist} onClick={() => setHistTicker(t)}>
                  {t}
                </button>
              ))}
            </div>
          )}
          {showHist && (
            <div className="mt-3">
              <EarningsHistoryView ticker={activeHist} timing={nextReport?.callType} compact />
            </div>
          )}
        </section>
      )}

      {related.length > 0 && (
        <section>
          <h3 className="micro-label mb-2 flex items-center gap-1"><Link2 className="h-3 w-3" aria-hidden="true" /> {t("preview.related")}</h3>
          <ul className="flex flex-col gap-1">
            {related.slice(0, 6).map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  onClick={() => onSelect(x.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate">{x.patternName}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{x.ticker || formatDay(noteDay(x))}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
