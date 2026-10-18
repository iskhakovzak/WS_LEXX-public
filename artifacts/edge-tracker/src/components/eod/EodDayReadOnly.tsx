import { useState } from "react";
import { AlertTriangle, CheckCircle2, MessageSquareText } from "lucide-react";
import { Pill, toneOf, toneText } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HORIZON_LABEL } from "@/components/journal/utils";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { eodI18n } from "@/i18n/ns/eod";
import { personName } from "@/i18n";
import { journalI18n } from "@/i18n/ns/journal";
import { tradesI18n } from "@/i18n/ns/trades";
import { tagLabel } from "@/components/shared/trade-labels";
import { rich as withNodes } from "@/i18n/rich";
import type { JournalEntry } from "@/components/journal/use-journal-days";
import { EMOTION_TAGS } from "@/components/journal/DayJournalEditor";
import {
  DISCIPLINE_LABELS, MISTAKE_TAGS, MOOD_LABELS, gradeTone, type BrokerDaily, type EodDayPayload, type EodTrade, type Totals,
} from "./eod-api";

/** Date + time with seconds ("17.10.2026, 14:05:09" in RU), the shape of the old bare toLocaleString(). */
const TRADES_PREVIEW = 12;
const EMOTIONS = new Set(EMOTION_TAGS);
const CALM = new Set(["Спокойствие", "Уверенность"]); // i18n-ignore (stored tag codes)

/**
 * Read-only rendering of a closed day for the curator: day reflection (journal) → result → trades → positions → verdict.
 * `journal` is the trader's journal entry for the day (lesson, emotions, rule violations); the EOD summary is the fallback.
 */
export function EodDayReadOnly({
  data, broker, journal, compact = false,
}: { data: EodDayPayload; broker?: BrokerDaily | null; journal?: JournalEntry | null; compact?: boolean }) {
  const { t } = eodI18n.useT();
  const { t: tc } = commonI18n.useT();
  const s = data.day?.summary ?? {};
  const positions = [...data.trades, ...data.carried].filter((t) => data.positions.includes(t.id));
  const posNotes = new Map((s.positions ?? []).map((p) => [p.tradeId, p]));
  const [allTrades, setAllTrades] = useState(false);
  const shownTrades = allTrades ? data.trades : data.trades.slice(0, TRADES_PREVIEW);
  const mood = journal?.mood ?? s.mood ?? null;
  const discipline = journal?.discipline ?? data.day?.discipline ?? null;
  const well = journal?.well?.trim() || s.repeat;
  const bad = journal?.mistakes?.trim() || s.stop;
  const emotions = (journal?.tags ?? []).filter((t) => EMOTIONS.has(t));
  const violations = (journal?.tags ?? []).filter((t) => MISTAKE_TAGS.includes(t));
  const net = data.reconcile.journal.net;

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="micro-label">{t("readOnly.traderReview")}</div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Pill tone={discipline != null ? (discipline >= 4 ? "up" : discipline <= 2 ? "down" : "warn") : "neutral"}>
            {t("readOnly.discipline", { value: discipline != null ? t("readOnly.scaleValue", { n: discipline, label: DISCIPLINE_LABELS[discipline - 1] }) : "—" })}
          </Pill>
          <Pill tone={mood != null ? (mood >= 4 ? "up" : mood <= 2 ? "down" : "neutral") : "neutral"}>
            {t("readOnly.mood", { value: mood != null ? t("readOnly.scaleValue", { n: mood, label: MOOD_LABELS[mood - 1] }) : "—" })}
          </Pill>
          {journal?.followedPlan === true && <Pill tone="up">{t("readOnly.byRules")}</Pill>}
          {journal?.followedPlan === false && <Pill tone="down">{t("readOnly.brokeRules")}</Pill>}
          {emotions.map((e) => <Pill key={e} tone={CALM.has(e) ? "up" : "warn"}>{tagLabel(e)}</Pill>)}
          {violations.map((v) => <Pill key={v} tone="down">{tagLabel(v)}</Pill>)}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <TextBlock label={tradesI18n.t("reviewFields.whatWorked")} text={well} tone="up" />
          <TextBlock label={tradesI18n.t("reviewFields.whatFailed")} text={bad} tone="down" />
        </div>
        {(journal?.lessons?.trim() || s.tomorrow) && (
          <div className="grid gap-2 sm:grid-cols-2">
            {journal?.lessons?.trim() && <TextBlock label={t("readOnly.lesson")} text={journal.lessons} accent />}
            {s.tomorrow && <TextBlock label={t("readOnly.focus")} text={s.tomorrow} />}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="micro-label">{t("readOnly.trades", { count: data.trades.length })}</span>
          {net != null && <span className={cn("text-sm font-semibold tabular-nums", toneText(toneOf(net)))}>{fmtUsd(net, { signed: true, decimals: "auto" })}</span>}
          {data.reconcile.journal.fees > 0 && <span className="text-xs tabular-nums text-muted-foreground">{t("readOnly.fees", { amount: fmtUsd(-data.reconcile.journal.fees, { signed: true, decimals: "auto" }) })}</span>}
        </div>
        <ReconcileBlock journal={data.reconcile.journal} broker={broker ?? null} brokerFromTrades={data.reconcile.broker} manualUnmatched={data.reconcile.manualUnmatched} />
        {data.trades.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("readOnly.noTrades")}</p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {shownTrades.map((t) => <TradeReviewLine key={t.id} t={t} compact={compact} />)}
            </ul>
            {data.trades.length > TRADES_PREVIEW && (
              <Button variant="ghost" size="sm" onClick={() => setAllTrades((v) => !v)}>
                {allTrades ? tc("actions.collapse") : tc("actions.showAllCount", { count: data.trades.length })}
              </Button>
            )}
          </>
        )}
      </section>

      {positions.length > 0 && (
        <section className="space-y-2">
          <div className="micro-label">{t("readOnly.overnight", { count: positions.length })}</div>
          <ul className="space-y-1.5">
            {positions.map((tr) => {
              const p = posNotes.get(tr.id);
              return (
                <li key={tr.id} className="rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{tr.ticker}</span>
                    <Pill tone="purple">{HORIZON_LABEL[tr.horizonEff]}</Pill>
                    {tr.date !== data.date && <Pill>{journalI18n.t("trades.since", { date: fmtDate(tr.date, "dayMonth") })}</Pill>}
                    {p?.thesisValid === true && <Pill tone="up">{t("readOnly.thesisValid")}</Pill>}
                    {p?.thesisValid === false && <Pill tone="down">{t("readOnly.thesisBroken")}</Pill>}
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      {t("readOnly.stopTarget", { stop: p?.stop ?? tr.stop ?? "—", target: p?.target ?? "—" })}
                    </span>
                  </div>
                  {p?.gapNote && <p className="mt-1 text-foreground/90">{t("readOnly.gapRisk", { note: p.gapNote })}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {data.day?.reviewedAt && (
        <section className="rounded-xl border border-primary/30 bg-primary/5 p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <MessageSquareText className="h-4 w-4 text-primary" aria-hidden="true" />
            <span className="font-semibold">{t("readOnly.curator", { name: personName(data.day.reviewedBy) || "—" })}</span>
            <Pill tone="accent">{t("readOnly.score", { score: data.day.curatorScore ?? "—" })}</Pill>
            <span className="text-muted-foreground">{fmtDate(data.day.reviewedAt, "shortDateTimeSeconds")}</span>
          </div>
          {data.day.curatorComment && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{data.day.curatorComment}</p>}
        </section>
      )}
    </div>
  );
}

/**
 * One-line reconciliation of the journal with the broker statement. Silent when it matches —
 * a warning only when the totals differ (or when manual trades have no broker pair).
 */
export function ReconcileBlock({
  journal, broker, brokerFromTrades, manualUnmatched,
}: { journal: Totals; broker: BrokerDaily | null; brokerFromTrades: Totals | null; manualUnmatched: number }) {
  const { t } = eodI18n.useT();
  const bNet = broker ? broker.net : brokerFromTrades?.net ?? null;
  const bTrades = broker ? broker.trades : brokerFromTrades?.trades ?? null;
  if (bNet == null || journal.net == null) return null;
  const diff = Math.round((journal.net - bNet) * 100) / 100;
  const matches = Math.abs(diff) < 0.01;
  if (matches && manualUnmatched === 0) {
    return (
      <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-up" aria-hidden="true" />{t("readOnly.reconciled")}
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-1.5 rounded-xl bg-warn/10 px-3 py-2 text-xs">
      <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden="true" />
      {!matches && (
        <span>
          {withNodes(
            bTrades != null
              ? t("readOnly.mismatchTrades", { diff: "{diff}", broker: fmtUsd(bNet, { signed: true, decimals: "auto" }), trades: bTrades })
              : t("readOnly.mismatch", { diff: "{diff}", broker: fmtUsd(bNet, { signed: true, decimals: "auto" }) }),
            { diff: <span className="font-semibold tabular-nums">{fmtUsd(diff, { signed: true, decimals: "auto" })}</span> },
          )}
        </span>
      )}
      {manualUnmatched > 0 && (
        <span className="text-muted-foreground">
          {t("readOnly.unmatched", { trades: commonI18n.t("units.trades", { count: manualUnmatched }) })}
        </span>
      )}
    </p>
  );
}

export function TradeReviewLine({ t, compact }: { t: EodTrade; compact?: boolean }) {
  const { t: te } = eodI18n.useT();
  const isShort = (t.side ?? "").toLowerCase().startsWith("s");
  const manualIncomplete = t.missing.length > 0 && t.source !== "propreports";
  return (
    <li className={cn("rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-3 py-2 text-xs", manualIncomplete && "border-warn/50")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-semibold">{t.ticker}</span>
        {t.side && <Pill>{isShort ? "↘ Short" : "↗ Long"}</Pill>}
        {t.setup ? <span className="text-muted-foreground">{t.setup}</span> : <span className="text-muted-foreground">{te("readOnly.noSetup")}</span>}
        {t.confidenceGrade && <Pill tone={gradeTone(t.confidenceGrade)}>{t.confidenceGrade}</Pill>}
        {t.onPlan && <Pill tone="accent">{te("readOnly.inPlan")}</Pill>}
        {t.followedPlan === true && <Pill tone="up">{te("readOnly.onPlan")}</Pill>}
        {t.followedPlan === false && <Pill tone="down">{te("readOnly.offPlan")}</Pill>}
        <span className="ml-auto flex items-center gap-2 tabular-nums">
          {t.net != null ? (
            <span className={cn("font-semibold", toneText(toneOf(t.net)))}>{fmtUsd(t.net, { signed: true, decimals: "auto" })}</span>
          ) : (
            <span className="text-muted-foreground">{t.resultNorm === "open" ? te("readOnly.open") : "—"}</span>
          )}
          {t.r != null && <span className={toneText(toneOf(t.r))}>{fmtR(t.r, 1)}</span>}
        </span>
      </div>
      {(t.mistakes.length > 0 || t.lesson) && !compact && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {t.mistakes.map((m) => <Pill key={m} tone="down">{tagLabel(m)}</Pill>)}
          {t.lesson && <span className="text-foreground/90">{t.lesson}</span>}
        </div>
      )}
    </li>
  );
}

function TextBlock({ label, text, tone, accent }: { label: string; text?: string; tone?: "up" | "down"; accent?: boolean }) {
  return (
    <div className={cn("rounded-xl bg-[var(--glass-bg)] p-3", accent && "bg-primary/5")}>
      <div className={cn("micro-label mb-1", tone === "up" && "text-up", tone === "down" && "text-down", accent && "text-primary")}>{label}</div>
      <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">{text?.trim() ? text : "—"}</p>
    </div>
  );
}
