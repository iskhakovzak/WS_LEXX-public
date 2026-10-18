/**
 * Own mode reveal («Мои худшие дни»): the verdict column (the difference in $ first — the one thing to take away —
 * then what the player really did next to the simulator decision, both in the real trade's R, and the real trade's
 * mistake) and, under the chart, the real trade's legs. The simulator trades, its mistakes and the chart markers stay
 * in the shared result views.
 */
import { Link } from "wouter";
import { AlertTriangle, CandlestickChart, CheckCircle2, RotateCcw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, Kbd, toneOf, toneText, type Tone } from "@/components/ds";
import { fmtCount, fmtDate, fmtPrice, fmtR, fmtTimeNY, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { simI18n } from "@/i18n/ns/simulator";
import { simOwnI18n } from "@/i18n/ns/simOwn";
import { chartI18n } from "@/i18n/ns/chart";
import type { OwnReveal } from "./api";
import { ownMistakeLabel } from "./own-start";
import { useDeskDayCount } from "@/components/shared/desk-day-link";
import type { GameView } from "./use-sim-game";

function verdictTone(o: OwnReveal): Tone {
  const v = o.compare.verdict;
  if (v === "same") return "neutral";
  return toneOf(o.compare.diff);
}

function Side({ label, net, r, line }: { label: string; net: number; r: number; line: string }) {
  return (
    <div className="min-w-0">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-semibold tabular-nums leading-tight", toneText(toneOf(net)))}>{fmtUsd(net, { signed: true })}</p>
      <p className={cn("text-xs font-medium tabular-nums", toneText(toneOf(r)))}>{fmtR(r)}</p>
      <p className="mt-0.5 truncate text-2xs text-muted-foreground" title={line}>{line}</p>
    </div>
  );
}

export function OwnResultSummary({ game, onAgain, onStart, starting }: { game: GameView; onAgain: () => void; onStart: () => void; starting: boolean }) {
  const { t } = simOwnI18n.useT();
  const { t: ts } = simI18n.useT();
  const r = game.reveal;
  const o = r?.own;
  // The desk's day only when somebody else traded it (no empty promise).
  const desk = useDeskDayCount(o?.ticker, o?.date);
  if (!r || !o) return null;
  const c = o.compare;
  const simTrades = r.result.trades;
  const realLine = t("result.trade", { side: ts(`side.${o.side}`), qty: fmtCount(o.maxQty), entry: fmtPrice(o.avgEntry), exit: fmtPrice(o.avgExit) });
  const simLine = simTrades === 0 ? t("result.skipped") : t("result.simTrades", { count: simTrades });
  const diffAbs = fmtUsd(Math.abs(c.diff));
  return (
    <div className="flex flex-col gap-3">
      <div className="tile rounded-xl p-3">
        <p className="text-2xs uppercase tracking-wide text-muted-foreground">{t("result.title")}</p>
        <p className="mt-0.5 text-xl font-semibold tracking-tight">{o.ticker} · {fmtDate(o.date, "dayMonth")}</p>
        {r.longName && <p className="truncate text-xs text-muted-foreground" title={r.longName}>{r.longName}</p>}
        <p className={cn("mt-2 text-2xl font-semibold leading-tight tabular-nums", toneText(verdictTone(o)))}>
          {c.verdict === "same" ? t("result.diff.same", { value: fmtUsd(c.diff, { signed: true }) }) : t(`result.diff.${c.verdict === "skipped" ? "skipped" : c.diff >= 0 ? "better" : "worse"}`, { value: diffAbs })}
        </p>
      </div>
      <div className="tile grid grid-cols-2 gap-3 rounded-xl p-3">
        <Side label={t("result.real")} net={c.realNet} r={c.realR} line={realLine} />
        <Side label={t("result.sim")} net={c.simNet} r={c.simR} line={simLine} />
        <p className="col-span-2 border-t border-[var(--glass-border)] pt-2 text-2xs text-muted-foreground">
          {t("result.risk", { value: fmtUsd(c.riskUsd), source: t(`result.riskSource.${o.riskSource}`) })}
        </p>
      </div>
      <div className="tile rounded-xl p-3">
        <p className="mb-1.5 text-2xs text-muted-foreground">{t("result.mistakeTitle")}</p>
        {o.mistakes.length ? (
          <ul className="flex flex-col gap-1">
            {o.mistakes.map((m) => (
              <li key={m} className="flex items-start gap-1.5 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden="true" />{ownMistakeLabel(m)}</li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{t("result.noMistake")}</p>
        )}
      </div>
      <Button size="lg" className="min-h-11" onClick={onAgain} disabled={starting}>
        <RotateCcw aria-hidden="true" /> {t("result.again")} <Kbd className="border-white/30 bg-white/10 text-white/90">Enter</Kbd>
      </Button>
      <div className="flex flex-wrap gap-2">
        {(desk.data?.others ?? 0) > 0 && (
          <Button asChild variant="outline" size="sm">
            <Link href={links.deskDay(o.ticker, o.date)}><Users aria-hidden="true" /> {t("result.deskDay")}</Link>
          </Button>
        )}
        <Button asChild variant="ghost" size="sm">
          <Link href={`/chart-lab?ticker=${encodeURIComponent(o.ticker)}&date=${o.date}`}><CandlestickChart aria-hidden="true" /> {ts("result.replay")}</Link>
        </Button>
        <Button variant="ghost" size="sm" onClick={onStart}>{t("result.toStart")}</Button>
      </div>
    </div>
  );
}

/** The real trade's legs (what each fill did), under the chart. */
export function OwnRealTrade({ own }: { own: OwnReveal }) {
  const { t } = simOwnI18n.useT();
  const { t: tc } = chartI18n.useT();
  return (
    <section className="glass-panel min-w-0 rounded-2xl p-[var(--panel-p)]">
      <h2 className="mb-3 text-sm font-semibold">{t("result.legsTitle")}</h2>
      <DataTable ariaLabel={t("result.legsTitle")} maxHeight={260}>
        <table>
          <thead>
            <tr>
              <th>{t("result.cols.role")}</th>
              <th>{t("result.cols.time")}</th>
              <th className="text-right">{t("result.cols.price")}</th>
              <th className="text-right">{t("result.cols.qty")}</th>
            </tr>
          </thead>
          <tbody>
            {own.legs.map((l, i) => (
              <tr key={`${l.role}-${i}`}>
                <td className={cn(l.role === "stop" && "text-down")}>{tc(`role.${l.role}`)}</td>
                <td className="tabular-nums text-muted-foreground">{l.at ? fmtTimeNY(l.at, { seconds: true }) : "—"}</td>
                <td className="text-right tabular-nums">{fmtPrice(l.price)}</td>
                <td className="text-right tabular-nums">{l.qty != null ? fmtCount(l.qty) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
    </section>
  );
}
