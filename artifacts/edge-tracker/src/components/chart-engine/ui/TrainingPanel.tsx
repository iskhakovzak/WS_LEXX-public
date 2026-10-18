/**
 * Training side panels: the order ticket (buy / sell / half / flat with a size, a stop and a target, bar by bar with
 * the future hidden), the outcome after the reveal (vs the best possible move, vs the real trade, and the log of the
 * trainee's own decisions) and the local history — this session or all attempts.
 */
import * as React from "react";
import { ArrowRight, Eye, Flame, RotateCcw, Shuffle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Kbd, Pill, ProgressRing, Segmented } from "@/components/ds";
import { cn } from "@/lib/utils";
import { fmtNum, fmtPrice, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { chartI18n } from "@/i18n/ns/chart";
import { fmtPerShare } from "../lib/trade-summary";
import {
  historyStats, plannedRR, sessionSlice, simFillLabel, simLiveR, simMark, trainingVerdict,
  type SimAction, type SimFillReason, type SimState, type TrainingOutcome, type TrainingRecord,
} from "../lib/training-sim";
import { AsideCard } from "./TradePanels";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

const tone = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || Math.abs(n) < 1e-12 ? "text-foreground" : n > 0 ? "text-up" : "text-down");
const QTY_CHIPS = [100, 500, 1000] as const;
const RR_CHIPS = [1, 2, 3] as const;

/** Ticket inputs. `targetRR` — target for a NEW position at N × the stop distance (0 = none). */
export type TicketState = { qty: number; autoStop: boolean; stopText: string; targetRR: number; targetText: string };

const parsePrice = (text: string): number | null => {
  const n = Number(text.replace(",", ".").trim());
  return text.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <label htmlFor={htmlFor} className="w-12 shrink-0 text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export function TrainingTicket({
  price, sim, ticket, onTicket, suggestLong, suggestShort, onOrder, onApplyStop, onBreakeven, canBE, onApplyTarget, onTargetRR, onClearTarget,
  onReveal, atLimit, started,
}: {
  price: number | null;
  sim: SimState;
  ticket: TicketState;
  onTicket: (patch: Partial<TicketState>) => void;
  suggestLong: number | null;
  suggestShort: number | null;
  onOrder: (a: SimAction) => void;
  onApplyStop: () => void;
  onBreakeven: () => void;
  canBE: boolean;
  onApplyTarget: () => void;
  /** Open position: target at N R from the average price and the current stop. */
  onTargetRR: (rr: number) => void;
  onClearTarget: () => void;
  onReveal: () => void;
  atLimit: boolean;
  /** At least one bar was played (nothing to score before that). */
  started: boolean;
}) {
  const { t } = chartI18n.useT();
  const uid = React.useId();
  const open = sim.pos !== 0 && sim.avg != null;
  const mark = price != null ? simMark(sim, price) : null;
  const dir = sim.pos > 0 ? 1 : -1;
  const perShare = open && price != null ? dir * (price - (sim.avg as number)) : null;
  const liveR = simLiveR(sim, price);
  const rr = open ? plannedRR(sim.avg, sim.stop, sim.target) : null;
  const manualStop = parsePrice(ticket.stopText);
  const manualTarget = parsePrice(ticket.targetText);
  const hasStopForNew = ticket.autoStop || manualStop != null;
  const noPrice = price == null || atLimit;
  return (
    <AsideCard title={t("training.ticket")} action={<span className="text-sm tabular-nums text-muted-foreground">{t("training.price")} <b className="text-foreground">{fmtPrice(price)}</b></span>}>
      <div className="grid grid-cols-2 gap-1.5">
        <Button className="h-10 justify-between bg-up px-3 text-white hover:bg-up/90" onClick={() => onOrder("buy")} disabled={noPrice} title={t("training.buyTitle")}>
          {t("training.buy")} <Kbd className="border-white/30 bg-white/15 text-white max-sm:hidden">B</Kbd>
        </Button>
        <Button className="h-10 justify-between bg-down px-3 text-white hover:bg-down/90" onClick={() => onOrder("sell")} disabled={noPrice} title={t("training.sellTitle")}>
          {t("training.sell")} <Kbd className="border-white/30 bg-white/15 text-white max-sm:hidden">S</Kbd>
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <Button variant="outline" size="sm" className="h-8 gap-1 px-2" onClick={() => onOrder("half")} disabled={!open || atLimit} title={t("training.halfTitle")}>
          ½ <Kbd className="max-sm:hidden">H</Kbd>
        </Button>
        <Button variant="outline" size="sm" className="h-8 gap-1 px-2" onClick={onBreakeven} disabled={!canBE || atLimit} title={open ? (canBE ? t("training.beTitle") : t("training.beNotYet")) : t("training.noPosition")}>
          {t("training.be")} <Kbd className="max-sm:hidden">E</Kbd>
        </Button>
        <Button variant="outline" size="sm" className="h-8 gap-1 px-2" onClick={() => onOrder("flat")} disabled={!open || atLimit} title={t("training.flatTitle")}>
          {t("training.flat")} <Kbd className="max-sm:hidden">C</Kbd>
        </Button>
      </div>

      <Field label={t("training.size")} htmlFor={`${uid}-qty`}>
        <Input
          id={`${uid}-qty`} inputMode="numeric" className="h-8 w-[4.5rem] tabular-nums" value={String(ticket.qty)}
          onChange={(e) => { const n = Math.floor(Number(e.target.value.replace(/\D/g, ""))); onTicket({ qty: Number.isFinite(n) ? Math.min(1_000_000, n) : 0 }); }}
        />
        <div className="flex min-w-0 gap-0.5">
          {QTY_CHIPS.map((q) => (
            <button key={q} type="button" onClick={() => onTicket({ qty: q })} aria-pressed={ticket.qty === q} className={cn("h-7 rounded-full px-2 text-xs tabular-nums", ticket.qty === q ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-[var(--glass-hover-bg)]")}>{q}</button>
          ))}
        </div>
      </Field>

      <Field label={t("training.stop")} htmlFor={`${uid}-stop`}>
        {ticket.autoStop && !open ? (
          <span className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground" title={t("training.autoStopTitle", { long: fmtPrice(suggestLong), short: fmtPrice(suggestShort) })}>
            <span className="text-up">↑</span>{fmtPrice(suggestLong)} <span className="text-down">↓</span>{fmtPrice(suggestShort)}
          </span>
        ) : (
          <Input
            id={`${uid}-stop`} aria-label={t("training.stopPrice")} inputMode="decimal" className="h-8 min-w-0 flex-1 tabular-nums" placeholder={open ? fmtPrice(sim.stop) : t("training.price")}
            value={ticket.stopText} onChange={(e) => onTicket({ stopText: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && open) onApplyStop(); }}
          />
        )}
        {open ? (
          <Button size="sm" variant="outline" className="h-8 shrink-0 px-2.5" disabled={manualStop == null} onClick={onApplyStop}>{t("training.move")}</Button>
        ) : (
          <label className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><Switch checked={ticket.autoStop} onCheckedChange={(v) => onTicket({ autoStop: v })} aria-label={t("training.autoStop")} />{t("training.auto")}</label>
        )}
      </Field>

      <Field label={t("training.target")} htmlFor={open ? `${uid}-target` : undefined}>
        {open ? (
          <>
            <Input
              id={`${uid}-target`} aria-label={t("training.targetPrice")} inputMode="decimal" className="h-8 min-w-0 flex-1 tabular-nums" placeholder={sim.target != null ? fmtPrice(sim.target) : t("training.price")}
              value={ticket.targetText} onChange={(e) => onTicket({ targetText: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") onApplyTarget(); }}
            />
            {manualTarget != null ? (
              <Button size="sm" variant="outline" className="h-8 shrink-0 px-2.5" onClick={onApplyTarget}>{t("training.set")}</Button>
            ) : (
              <div className="flex shrink-0 gap-0.5">
                {RR_CHIPS.map((n) => (
                  <button key={n} type="button" disabled={sim.stop == null} onClick={() => onTargetRR(n)} title={sim.stop == null ? t("training.needStop") : t("training.targetRTitle", { n })} className="h-7 rounded-full px-1.5 text-xs tabular-nums text-muted-foreground hover:bg-[var(--glass-hover-bg)] disabled:opacity-40">{n}R</button>
                ))}
                {sim.target != null && (
                  <button type="button" onClick={onClearTarget} aria-label={t("training.clearTarget")} title={t("training.clearTarget")} className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)]"><X className="h-3.5 w-3.5" /></button>
                )}
              </div>
            )}
          </>
        ) : (
          <Segmented
            size="sm" ariaLabel={t("training.newTarget")} value={String(ticket.targetRR)} onChange={(v) => onTicket({ targetRR: Number(v) })} className="min-w-0"
            options={[{ value: "0", label: t("training.none") }, ...RR_CHIPS.map((n) => ({ value: String(n), label: `${n}R`, disabled: !hasStopForNew, title: hasStopForNew ? t("training.targetMultTitle", { n }) : t("training.targetNeedsStop") }))]}
          />
        )}
      </Field>

      <div className="rounded-xl bg-[hsl(var(--muted-foreground)/0.08)] px-2.5 py-2 text-sm tabular-nums">
        {open ? (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{sim.pos > 0 ? commonI18n.t("trading.long") : commonI18n.t("trading.short")} {Math.abs(sim.pos)} @ {fmtPrice(sim.avg)}</span>
              <b className={tone(mark?.total)}>{fmtUsd(mark?.total, { signed: true, decimals: "auto" })}</b>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-muted-foreground">
              <span>{t("training.stopTarget", { stop: sim.stop != null ? fmtPrice(sim.stop) : "—", target: sim.target != null ? fmtPrice(sim.target) : "—" })}{rr != null && <> · R:R 1:{fmtNum(rr, 1)}</>}</span>
              <span className="flex gap-2">
                <b className={tone(perShare)}>{fmtPerShare(perShare)}</b>
                <b className={tone(liveR)} title={t("training.liveRTitle")}>{liveR != null ? fmtR(liveR) : "— R"}</b>
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{sim.fills.length ? t("training.flatNow") : t("training.noTradesYet")}</span>
            {sim.fills.length > 0 && <span className="flex gap-2"><b className={tone(sim.realized)}>{fmtUsd(sim.realized, { signed: true, decimals: "auto" })}</b>{liveR != null && <b className={tone(liveR)}>{fmtR(liveR)}</b>}</span>}
          </div>
        )}
      </div>

      {atLimit && <p className="text-xs font-medium text-[hsl(var(--chart-3))]" role="status">{t("training.sessionOver")}</p>}
      <Button variant={atLimit ? "default" : "secondary"} className="h-9 w-full justify-center gap-1.5" onClick={onReveal} disabled={!started} title={t("training.revealTitle")}>
        <Eye className="h-4 w-4 shrink-0" /> <span className="truncate">{t("training.reveal")}</span> <Kbd className="ml-auto max-sm:hidden">Enter</Kbd>
      </Button>
      <p className="text-2xs leading-snug text-muted-foreground">{t("training.rules")}</p>
    </AsideCard>
  );
}

export type DecisionRow = { idx: number; time: string; price: number; qty: number; reason: SimFillReason };

const REASON_TONE: Record<SimFillReason, string> = { buy: "text-up", sell: "text-down", half: "text-muted-foreground", flat: "text-muted-foreground", stop: "text-down", target: "text-up" };

export function TrainingOutcomeCard({
  o, decisions, traderName, onJump, onRestart, onNext,
}: {
  o: TrainingOutcome;
  /** The trainee's own fills, oldest first. */
  decisions: readonly DecisionRow[];
  /** Whose trade it was (shown only after the reveal); null for a ticker-day task (no real trade to compare with). */
  traderName?: string | null;
  onJump?: (idx: number) => void;
  onRestart: () => void;
  onNext?: () => void;
}) {
  const { t } = chartI18n.useT();
  const v = trainingVerdict(o);
  return (
    <AsideCard title={t("training.outcome")}>
      <div className="flex items-center gap-3">
        <ProgressRing value={o.score ?? 0} size={64} stroke={6} tone={v.tone === "down" ? "down" : v.tone === "warn" ? "warn" : v.tone === "up" ? "up" : "neutral"} label={o.score != null ? String(o.score) : "—"} ariaLabel={t("training.scoreAria")} />
        <div className="flex min-w-0 flex-col gap-1">
          <Pill tone={v.tone === "neutral" ? "neutral" : v.tone}>{v.label}</Pill>
          <span className="text-xs text-muted-foreground">{o.score != null ? t("training.scoreHint") : t("training.noScore")}</span>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm tabular-nums">
        <dt className="text-muted-foreground">{t("training.you")}</dt>
        <dd className="flex flex-wrap justify-end gap-x-1.5 text-right">{o.trades ? <><b className={tone(o.r ?? o.perShare)}>{o.r != null ? fmtR(o.r) : fmtPerShare(o.perShare)}</b>{o.r != null && <span className={tone(o.perShare)}>{fmtPerShare(o.perShare)}</span>}<span className="text-muted-foreground">{fmtUsd(o.pnlUsd, { signed: true, decimals: "auto" })}</span></> : t("training.noTrades")}</dd>
        <dt className="text-muted-foreground">{t("training.couldHave")}</dt>
        <dd className="text-right">{o.idealPerShare != null ? <><b className="text-up">{fmtPerShare(o.idealPerShare)}</b> <span className="text-muted-foreground">{o.idealSide === "short" ? t("training.toShort") : t("training.toLong")}</span></> : "—"}</dd>
        {traderName !== null && (
          <>
            <dt className="truncate text-muted-foreground">{traderName ? t("training.tradeOf", { name: personName(traderName) }) : t("training.realTrade")}</dt>
            <dd className="text-right">{o.realPerShare != null ? <><b className={tone(o.realPerShare)}>{fmtPerShare(o.realPerShare)}</b>{o.realR != null && <b className={cn("ml-1.5", tone(o.realR))}>{fmtR(o.realR)}</b>}</> : "—"}</dd>
          </>
        )}
      </dl>
      {o.vsRealPerShare != null && (
        <p className={cn("text-sm", tone(o.vsRealPerShare))}>{t(o.vsRealPerShare >= 0 ? "training.betterThanReal" : "training.worseThanReal", { value: fmtPerShare(Math.abs(o.vsRealPerShare)).replace("+", "") })}</p>
      )}

      {decisions.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{t("training.yourActions")}</h4>
          <ol className="flex max-h-40 flex-col overflow-y-auto text-xs tabular-nums">
            {decisions.map((d, i) => (
              <li key={`${d.idx}-${i}`}>
                <button type="button" disabled={!onJump} onClick={() => onJump?.(d.idx)} className="grid w-full grid-cols-[minmax(3rem,auto)_minmax(4.5rem,auto)_1fr_auto] items-baseline gap-2 whitespace-nowrap rounded-md px-1 py-0.5 text-left hover:bg-[var(--glass-hover-bg)] disabled:hover:bg-transparent" title={t("training.showOnChart")}>
                  <span className="text-muted-foreground">{d.time}</span>
                  <span className={cn("font-medium", REASON_TONE[d.reason])}>{simFillLabel(d)}</span>
                  <span className="text-right">{fmtPrice(d.price)}</span>
                  <span className="w-12 text-right text-muted-foreground">{d.qty > 0 ? "+" : "−"}{Math.abs(d.qty)}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="text-2xs leading-snug text-muted-foreground">{traderName !== null ? t("training.legendWithReal") : t("training.legend")}</p>
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" className="h-8 flex-1 gap-1" onClick={onRestart}><RotateCcw className="h-3.5 w-3.5" /> {t("training.again")}</Button>
        {onNext && <Button size="sm" className="h-8 flex-[1.4] gap-1" onClick={onNext} title={t("training.nextTitle")}><Shuffle className="h-3.5 w-3.5" /> {t("training.next")} <ArrowRight className="h-3.5 w-3.5" /></Button>}
      </div>
    </AsideCard>
  );
}

const SESSION_KEY = "ws-chart:training-session:v1";
function loadSessionStart(): number {
  try {
    const n = Number(localStorage.getItem(SESSION_KEY));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function Stat({ value, label, className, title }: { value: React.ReactNode; label: string; className?: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className={cn("truncate text-base font-semibold tabular-nums", className)}>{value}</div>
      <div className="truncate text-2xs text-muted-foreground">{label}</div>
    </div>
  );
}

/** Memoised: it sits beside the chart and must not recompute its stats on every replay tick. */
export const TrainingHistoryCard = React.memo(function TrainingHistoryCard({ list }: { list: readonly TrainingRecord[] }) {
  const { t } = chartI18n.useT();
  const [scope, setScope] = React.useState<"session" | "all">("session");
  const [since, setSince] = React.useState<number>(loadSessionStart);
  const newSession = () => {
    const now = Date.now();
    try { localStorage.setItem(SESSION_KEY, String(now)); } catch { /* storage unavailable */ }
    setSince(now);
    setScope("session");
  };
  const shown = scope === "session" ? sessionSlice(list, since) : list;
  const st = historyStats(shown);
  if (!list.length) {
    return (
      <AsideCard title={t("training.stats")}>
        <p className="text-sm text-muted-foreground">{t("training.statsEmpty")}</p>
      </AsideCard>
    );
  }
  return (
    <AsideCard
      title={t("training.stats")}
      action={<Segmented size="sm" ariaLabel={t("training.statsPeriod")} value={scope} onChange={setScope} options={[{ value: "session", label: t("training.session") }, { value: "all", label: t("training.all") }]} />}
    >
      {st.count === 0 ? (
        <p className="text-sm text-muted-foreground">{t("training.sessionEmpty")}</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-x-2 gap-y-2 text-center">
            <Stat value={st.count} label={t("training.attempts", { count: st.count })} />
            <Stat value={st.avgScore ?? "—"} label={t("training.avgScore")} />
            <Stat value={fmtRate(st.plusShare)} label={t("training.plusShare")} />
            <Stat value={st.avgR != null ? fmtR(st.avgR) : "—"} label={t("training.avgR")} className={tone(st.avgR)} title={st.sumR != null ? t("training.sumR", { value: fmtR(st.sumR) }) : t("training.rNeedsStop")} />
            <Stat value={st.avgRealR != null ? fmtR(st.avgRealR) : "—"} label={t("training.tradersR")} className={tone(st.avgRealR)} title={t("training.tradersRTitle")} />
            <Stat value={st.comparable ? `${st.beatReal}/${st.comparable}` : "—"} label={t("training.beatReal")} title={t("training.beatRealTitle")} />
          </div>
          {st.streak > 0 && <p className="inline-flex items-center gap-1 text-xs font-semibold text-[hsl(var(--chart-3))]"><Flame className="h-3.5 w-3.5" aria-hidden="true" />{t("training.streak", { count: st.streak })}</p>}
          <ul className="flex flex-col divide-y divide-[var(--glass-border)] text-xs tabular-nums">
            {shown.slice(0, 5).map((x) => (
              <li key={x.at} className="flex items-center gap-2 py-1">
                <span className="w-7 font-semibold">{x.score ?? "—"}</span>
                <span className="font-medium">{x.ticker}</span>
                <span className="text-muted-foreground">{x.day.slice(5)}</span>
                <span className={cn("ml-auto", tone(x.trades ? x.pnlUsd : null))}>{x.trades ? (x.r != null ? fmtR(x.r) : fmtPerShare(x.perShare)) : t("training.noTrades")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Button variant="ghost" size="sm" className="h-7 self-start px-2 text-xs text-muted-foreground" onClick={newSession} title={t("training.newSessionTitle")}>
        <RotateCcw className="mr-1 h-3 w-3" /> {t("training.newSession")}
      </Button>
    </AsideCard>
  );
});
