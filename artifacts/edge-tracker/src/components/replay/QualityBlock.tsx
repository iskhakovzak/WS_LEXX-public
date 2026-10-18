import * as React from "react";
import { AlertTriangle, Info, RotateCw } from "lucide-react";
import type { Trade } from "@workspace/api-client-react";
import { Pill, Segmented, toneOf, toneText, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fmtDuration, fmtEtTimeSec } from "@/components/trade-chart-parts/chart-utils";
import { useTradeQuality } from "./hooks";
import { AFTER_EXIT_OPTIONS, DEFAULT_AFTER_EXIT, reasonLabel, type Excursion, type TradeQuality } from "./types";
import { chartI18n } from "@/i18n/ns/chart";
import { fmtNum, fmtPrice, fmtR, fmtRate, fmtUsd } from "@/lib/format";

const AFTER_EXIT_KEY = "ws.trades.quality.afterExit";

export function useAfterExitMinutes(): [number, (n: number) => void] {
  const [v, setV] = React.useState<number>(() => {
    try {
      const raw = Number(window.localStorage.getItem(AFTER_EXIT_KEY));
      return (AFTER_EXIT_OPTIONS as readonly number[]).includes(raw) ? raw : DEFAULT_AFTER_EXIT;
    } catch { return DEFAULT_AFTER_EXIT; }
  });
  const set = React.useCallback((n: number) => {
    setV(n);
    try { window.localStorage.setItem(AFTER_EXIT_KEY, String(n)); } catch { /* storage unavailable */ }
  }, []);
  return [v, set];
}

/** Legacy minute formatter (kept for callers outside this file); new code prefers fmtDuration(seconds). */
export function fmtMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "—";
  return fmtDuration(min * 60);
}

/** Seconds from entry to the excursion: v2 carries them, v1 cache rows only whole minutes. */
function excSeconds(e: Excursion): number {
  return e.seconds != null && Number.isFinite(e.seconds) ? e.seconds : e.minutes * 60;
}

/** «через 1 мин 11 с» / «в момент входа» / «в момент выхода». */
function whenText(seconds: number, atFill: "entry" | "exit" | null): string {
  if (atFill === "entry") return chartI18n.t("quality.whenEntry");
  if (atFill === "exit") return chartI18n.t("quality.whenExit");
  return chartI18n.t("quality.whenAfter", { dur: fmtDuration(seconds) });
}

/** «1 мин 11 с» / «в момент входа» — the same moment without «через». */
function whenValue(seconds: number, atFill: "entry" | "exit" | null): string {
  if (atFill) return whenText(seconds, atFill);
  return fmtDuration(seconds);
}

/** Tone for exit efficiency: ≥0.6 good, 0.3–0.6 so-so, below — poor; negative — the exit lost more than the move gave. */
export function exitEffTone(e: number | null | undefined): Tone {
  if (e == null) return "neutral";
  if (e >= 0.6) return "up";
  if (e >= 0.3) return "warn";
  return "down";
}

function Big({ label, value, sub, tone = "neutral", explain, className }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; explain: string; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-2xl bg-[var(--glass-bg)] px-3.5 py-3", className)} title={explain}>
      <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">{label}<Info className="h-3 w-3 opacity-60" aria-hidden="true" /></p>
      <p className={cn("mt-0.5 truncate text-xl font-semibold tabular-nums tracking-tight", toneText(tone))}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-2xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Small({ label, value, tone = "neutral", explain }: { label: string; value: React.ReactNode; tone?: Tone; explain: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--glass-bg)] px-2.5 py-1 text-xs" title={explain}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", toneText(tone))}>{value}</span>
    </span>
  );
}

const perShareText = (v: number, sign = 1) => chartI18n.t("quality.perShare", { value: fmtUsd(sign * v, { signed: true }) });
const perShareAbs = (v: number) => chartI18n.t("quality.perShare", { value: fmtUsd(v) });

function rAndUsd(r: number | null, usd: number | null, perShare: number, sign = 1): string {
  const parts: string[] = [];
  if (r != null) parts.push(fmtR(sign * r));
  if (usd != null) parts.push(fmtUsd(sign * usd, { signed: true, decimals: "auto" }));
  if (!parts.length) parts.push(perShareText(perShare, sign));
  return parts.join(" · ");
}

/** Headline value of an excursion: R when a stop exists, else $ of the position, else $/share. */
function excValue(e: Excursion, sign: 1 | -1): string {
  if (e.r != null) return fmtR(sign * e.r);
  if (e.usd != null) return fmtUsd(sign * e.usd, { signed: true, decimals: "auto" });
  return perShareText(e.perShare, sign);
}

export function QualitySummaryLine({ q }: { q: TradeQuality }) {
  if (q.status === "unavailable" || !q.mfe) return null;
  const eff = q.exitEfficiency;
  const capturedR = q.captured?.r;
  const mfeR = q.mfe.r;
  const t = chartI18n.t;
  const usdA = (v: number) => fmtUsd(v, { signed: true, decimals: "auto" });
  const text = eff == null
    ? t("quality.stillOpen")
    : eff < 0
      ? t("quality.exitWorse", { mfe: mfeR != null ? fmtR(mfeR) : q.mfe.usd != null ? usdA(q.mfe.usd) : perShareAbs(q.mfe.perShare) })
      : t("quality.captured", {
          pct: fmtRate(eff),
          detail: mfeR != null && capturedR != null ? t("quality.ofAvailable", { got: fmtR(capturedR), max: fmtR(mfeR) })
            : q.captured?.usd != null && q.mfe.usd != null ? t("quality.ofAvailable", { got: usdA(q.captured.usd), max: usdA(q.mfe.usd) })
            : t("quality.ofPerShare", { got: fmtUsd(q.captured?.perShare ?? 0), max: fmtUsd(q.mfe.perShare) }),
        });
  return <p className="text-sm text-muted-foreground">{text}</p>;
}


export function QualityBlock({ trade, afterExit, onAfterExitChange, compact }: { trade: Trade; afterExit: number; onAfterExitChange?: (n: number) => void; compact?: boolean }) {
  const { t } = chartI18n.useT();
  const { data, isLoading, error, refresh, isFetching } = useTradeQuality(trade.id, afterExit);
  const [refreshing, setRefreshing] = React.useState(false);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
      </div>
    );
  }
  if (error || !data) {
    const status = (error as Error & { status?: number } | null)?.status;
    return (
      <div className="flex items-center gap-2 rounded-2xl bg-[var(--glass-bg)] px-3.5 py-3 text-sm text-muted-foreground">
        <AlertTriangle className="h-4 w-4 shrink-0 text-[hsl(var(--chart-3))]" aria-hidden="true" />
        {status === 404 ? t("quality.notConnected") : error ? t("quality.failedWith", { message: (error as Error).message }) : t("quality.failed")}
      </div>
    );
  }

  const q = data.quality;
  const short = q.side === "short";
  const dirWord = short ? t("quality.down") : t("quality.up");
  const PARTIAL_BAR_NOTE = t("quality.partialBarNote");

  if (q.status === "unavailable") {
    return (
      <div className="space-y-2 rounded-2xl bg-[var(--glass-bg)] px-3.5 py-3 text-sm">
        <p className="flex items-center gap-2 text-muted-foreground"><AlertTriangle className="h-4 w-4 text-[hsl(var(--chart-3))]" aria-hidden="true" /> {t("quality.unavailable")}</p>
        <ul className="list-disc pl-5 text-xs text-muted-foreground">{q.reasons.map((r) => <li key={r}>{reasonLabel(r)}</li>)}</ul>
        <Button variant="outline" size="sm" className="gap-1.5" disabled={refreshing} onClick={async () => { setRefreshing(true); try { await refresh(); } finally { setRefreshing(false); } }}>
          <RotateCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} /> {t("quality.recalc")}
        </Button>
      </div>
    );
  }

  const mfe = q.mfe, mae = q.mae;
  const timed = q.timedFills === true || (q.timedFills == null && q.placement === "time");
  const hasStop = q.riskPerShare != null && q.riskSource === "stop";
  const holdSeconds = q.holdSeconds != null ? q.holdSeconds : q.holdMinutes != null ? q.holdMinutes * 60 : null;
  const atFill = (e: Excursion | null): "entry" | "exit" | null => {
    if (!e || !timed) return null;
    if (q.entryAt != null && e.at === q.entryAt) return "entry";
    if (q.exitAt != null && e.at === q.exitAt) return "exit";
    return null;
  };
  const capturedTone: Tone = q.captured ? toneOf(q.captured.perShare) : q.unrealised ? toneOf(q.unrealised.perShare) : "neutral";
  const warnReasons = q.reasons.filter((r) => r !== "atr_from_day_range");
  const heatWorkedAt = q.heat ? (q.heat.workedAtSeconds != null ? q.heat.workedAtSeconds : q.heat.workedAtMinutes != null ? q.heat.workedAtMinutes * 60 : null) : null;
  const windowTitle = `${t("quality.windowTitle", { interval: q.interval, bars: t("bars.count", { count: q.barsUsed }) })}${data.window ? ` · ${data.window.to !== data.window.from ? t("quality.windowRange", { from: data.window.from, to: data.window.to }) : data.window.from}` : ""}${timed ? `\n${PARTIAL_BAR_NOTE}` : `\n${t("quality.timedNote")}`}`;

  return (
    <div className="@container space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <QualitySummaryLine q={q} />
        <div className="ml-auto flex items-center gap-2">
          {q.status === "partial" && <Pill tone="warn" className="px-1.5 text-2xs">{t("quality.partial")}</Pill>}
          <span className="text-2xs text-muted-foreground" title={windowTitle}>
            {q.interval} · {t("quality.barsShort", { count: q.barsUsed })}{timed ? ` · ${t("quality.byFillTime")}` : ""}
          </span>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("quality.recalc")} title={t("quality.recalcTitle")} disabled={refreshing || isFetching} onClick={async () => { setRefreshing(true); try { await refresh(); } finally { setRefreshing(false); } }}>
            <RotateCw className={cn("h-3.5 w-3.5", (refreshing || isFetching) && "animate-spin")} />
          </Button>
        </div>
      </div>

      <div className={cn("grid grid-cols-2 gap-2", compact ? "sm:grid-cols-4" : "@lg:grid-cols-3 @4xl:grid-cols-5")}>
        <Big
          label="MFE"
          value={mfe ? excValue(mfe, 1) : "—"}
          sub={mfe ? `${mfe.r != null && mfe.usd != null ? `${fmtUsd(mfe.usd, { signed: true, decimals: "auto" })} · ` : mfe.usd != null ? `${perShareAbs(mfe.perShare)} · ` : ""}${t("quality.toPrice", { price: fmtPrice(mfe.price), when: whenText(excSeconds(mfe), atFill(mfe)) })}` : undefined}
          tone="up"
          explain={`${t("quality.mfeExplain", { dir: dirWord })} ${timed ? PARTIAL_BAR_NOTE : ""}`}
        />
        <Big
          label="MAE"
          value={mae ? excValue(mae, -1) : "—"}
          sub={mae ? `${mae.r != null && mae.usd != null ? `${fmtUsd(-mae.usd, { signed: true, decimals: "auto" })} · ` : mae.usd != null ? `${perShareAbs(-mae.perShare)} · ` : ""}${mae.perShare > 0 ? t("quality.toPrice", { price: fmtPrice(mae.price), when: whenText(excSeconds(mae), atFill(mae)) }) : t("quality.noAdverse")}${q.gaps?.count ? ` · ${t("quality.withGap")}` : ""}` : undefined}
          tone={mae && mae.perShare > 0 ? "down" : "neutral"}
          explain={`${t("quality.maeExplain")}${hasStop ? ` ${t("quality.maeStopNote")}` : ""} ${timed ? PARTIAL_BAR_NOTE : ""}`}
        />
        <Big
          label={t("quality.exitEff")}
          value={fmtRate(q.exitEfficiency)}
          sub={q.captured ? t("quality.capturedSub", { value: rAndUsd(q.captured.r, q.captured.usd, q.captured.perShare) }) : q.unrealised ? t("quality.openSub", { value: rAndUsd(q.unrealised.r, q.unrealised.usd, q.unrealised.perShare) }) : undefined}
          tone={q.exitEfficiency == null ? capturedTone : exitEffTone(q.exitEfficiency)}
          explain={t("quality.exitEffExplain")}
        />
        <Big
          label={t("quality.left", { min: q.leftOnTable?.windowMinutes ?? afterExit })}
          value={q.leftOnTable ? (q.leftOnTable.r != null ? fmtR(q.leftOnTable.r) : q.leftOnTable.usd != null ? fmtUsd(q.leftOnTable.usd, { signed: true, decimals: "auto" }) : perShareAbs(q.leftOnTable.perShare)) : "—"}
          sub={q.leftOnTable ? `${q.leftOnTable.r != null && q.leftOnTable.usd != null ? `${fmtUsd(q.leftOnTable.usd, { signed: true, decimals: "auto" })} · ` : q.leftOnTable.usd != null ? `${perShareAbs(q.leftOnTable.perShare)} · ` : ""}${t("quality.leftBest", { price: fmtPrice(q.leftOnTable.bestPrice) })}${q.leftOnTable.toCloseOfDay != null && q.leftOnTable.toCloseOfDay > q.leftOnTable.perShare ? ` · ${t("quality.leftToClose", { value: fmtUsd(q.leftOnTable.toCloseOfDay) })}` : ""}` : q.reasons.includes("no_bars_after_exit") ? t("quality.noBarsAfter") : q.captured == null ? t("quality.openPosition") : t("quality.leftZero")}
          tone={q.leftOnTable ? (q.leftOnTable.r != null ? (q.leftOnTable.r >= 1 ? "down" : q.leftOnTable.r >= 0.5 ? "warn" : "up") : q.captured && q.captured.perShare > 0 && q.leftOnTable.perShare > q.captured.perShare ? "warn" : "neutral") : "neutral"}
          explain={t("quality.leftExplain")}
        />
        <Big
          label={q.heat?.threshold === "1R" ? t("quality.heat1R") : t("quality.heatPeak")}
          value={q.heat ? (q.heat.r != null ? fmtR(-q.heat.r) : q.heat.usd != null ? fmtUsd(-q.heat.usd, { signed: true, decimals: "auto" }) : perShareAbs(-q.heat.perShare)) : "—"}
          sub={q.heat
            ? q.heat.threshold === "1R"
              ? (heatWorkedAt != null ? t("quality.heat1RAt", { dur: fmtDuration(heatWorkedAt) }) : t("quality.heatNo1R"))
              : (heatWorkedAt != null ? t("quality.heatPeakAt", { dur: fmtDuration(heatWorkedAt) }) : mfe && mfe.perShare > 0 ? t("quality.heatToMfe") : t("quality.heatNoPlus"))
            : undefined}
          tone={q.heat ? (q.heat.r != null ? (q.heat.r >= 0.8 ? "down" : q.heat.r >= 0.4 ? "warn" : "up") : q.heat.perShare > 0 ? "warn" : "neutral") : "neutral"}
          explain={q.heat?.threshold === "1R" ? t("quality.heat1RExplain") : t("quality.heatPeakExplain")}
          className={compact ? "hidden" : undefined}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Small label={t("quality.entryInBar")} value={fmtRate(q.entryEfficiency)} tone={q.entryEfficiency == null ? "neutral" : q.entryEfficiency >= 0.6 ? "up" : q.entryEfficiency >= 0.35 ? "warn" : "down"} explain={t("quality.entryInBarExplain")} />
        <Small label={t("quality.exitInRange")} value={fmtRate(q.rangeEfficiency)} tone={q.rangeEfficiency == null ? "neutral" : q.rangeEfficiency >= 0.6 ? "up" : q.rangeEfficiency >= 0.35 ? "warn" : "down"} explain={t("quality.exitInRangeExplain")} />
        {q.stopAtr && <Small label={t("quality.stopAtr")} value={fmtNum(q.stopAtr.distanceAtr, { suffix: "×" })} tone={q.stopAtr.distanceAtr < 0.3 ? "down" : q.stopAtr.distanceAtr < 0.6 ? "warn" : "neutral"} explain={t("quality.stopAtrExplain", { source: q.stopAtr.source === "dayRange" ? t("quality.atrDayRange") : t("quality.atrTrade") })} />}
        {mfe && mfe.perShare > 0 && <Small label={t("quality.timeToMfe")} value={whenValue(excSeconds(mfe), atFill(mfe))} explain={t("quality.timeToMfeExplain")} />}
        {holdSeconds != null && <Small label={t("quality.inPosition")} value={fmtDuration(holdSeconds)} explain={timed ? (q.entryAt != null && q.exitAt != null ? t("quality.inPositionTimedRange", { from: fmtEtTimeSec(q.entryAt), to: fmtEtTimeSec(q.exitAt) }) : t("quality.inPositionTimed")) : t("quality.inPositionBars")} />}
        {q.gaps?.count ? <Small label={t("quality.gaps")} value={t("quality.gapsValue", { count: q.gaps.count, worst: q.gaps.worstR != null ? fmtR(q.gaps.worstR) : fmtUsd(q.gaps.worstPerShare ?? 0) })} tone={q.gaps.worstPerShare != null && q.gaps.worstPerShare < 0 ? "down" : "up"} explain={t("quality.gapsExplain")} /> : null}
        {q.avgEntry != null && q.fillsUsed > 2 && <Small label={t("quality.avgInOut")} value={`${fmtPrice(q.avgEntry)} → ${q.avgExit != null ? fmtPrice(q.avgExit) : "—"}`} explain={t("quality.avgInOutExplain")} />}
        {onAfterExitChange && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
            {t("quality.afterExitWindow")}
            <Segmented size="sm" ariaLabel={t("quality.afterExitAria")} value={String(afterExit)} onChange={(v) => onAfterExitChange(Number(v))} options={AFTER_EXIT_OPTIONS.map((n) => ({ value: String(n), label: t("quality.minutesShort", { n }) }))} />
          </span>
        )}
      </div>

      {warnReasons.length > 0 && (
        <p className="text-2xs text-muted-foreground">
          {warnReasons.map((r) => reasonLabel(r)).join(" · ")}
        </p>
      )}
    </div>
  );
}
