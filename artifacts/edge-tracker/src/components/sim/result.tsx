
import { Link } from "wouter";
import { AlertTriangle, CandlestickChart, CheckCircle2, Eye, EyeOff, RotateCcw, Trophy, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, EmptyState, Kbd, Pill, Sparkline, toneOf, toneText } from "@/components/ds";
import { fmtCount, fmtDate, fmtPct, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { simI18n } from "@/i18n/ns/simulator";
import { simOwnI18n } from "@/i18n/ns/simOwn";
import type { DeskTrader, Mistake, Reveal, SimTrade } from "./api";
import type { GameView } from "./use-sim-game";

import { personName } from "@/i18n";
function dayText(r: Reveal): string {
  const t = simI18n.t;
  return r.dayTo ? t("result.daySwing", { from: fmtDate(r.day, "medium"), to: fmtDate(r.dayTo, "medium") }) : t("result.dayIntraday", { date: fmtDate(r.day, "full") });
}

export function mistakeText(m: Mistake): string {
  const t = simI18n.t;
  switch (m.kind) {
    case "overtrading": return t("result.mistakes.overtrading", { count: m.value });
    case "heldLoser": return t("result.mistakes.heldLoser", { n: m.trade ?? 0, r: fmtR(m.value, 1) });
    case "gaveBack": return t("result.mistakes.gaveBack", { n: m.trade ?? 0, r: fmtR(m.value, 1) });
    case "cutWinner": return t("result.mistakes.cutWinner", { n: m.trade ?? 0, r: fmtR(m.value, 1) });
    case "addedToLoser": return t("result.mistakes.addedToLoser", { n: m.trade ?? 0 });
    case "noStop": return t("result.mistakes.noStop", { n: m.trade ?? 0 });
  }
}

export function ResultSummary({ game, onAgain, onStart, starting }: { game: GameView; onAgain: () => void; onStart: () => void; starting: boolean }) {
  const { t } = simI18n.useT();
  const r = game.reveal;
  if (!r) return null;
  const res = r.result;
  const beat = res.beatBh;
  return (
    <div className="flex flex-col gap-3">
      <div className="tile rounded-xl p-3">
        <p className="text-2xs uppercase tracking-wide text-muted-foreground">{t("result.title")}</p>
        <p className="mt-0.5 text-xl font-semibold tracking-tight">{t("result.revealed", { ticker: r.ticker })}</p>
        {r.longName && <p className="truncate text-xs text-muted-foreground" title={r.longName}>{r.longName}</p>}
        <p className="mt-1 text-xs text-muted-foreground">{dayText(r)}</p>
      </div>
      <div className="tile rounded-xl p-3">
        <p className="text-2xs text-muted-foreground">{t("result.net")}</p>
        <p className={cn("text-3xl font-semibold tabular-nums leading-tight", toneText(toneOf(res.net)))}>{fmtUsd(res.net, { signed: true })}</p>
        <p className="text-xs text-muted-foreground">{t("result.pctOfBase", { value: fmtPct(res.pct) })}</p>
        <dl className="mt-2 grid grid-cols-2 gap-2 border-t border-[var(--glass-border)] pt-2 text-xs">
          <div><dt className="text-2xs text-muted-foreground">{t("result.rTotal")}</dt><dd className={cn("text-base font-semibold tabular-nums", toneText(toneOf(res.r)))}>{fmtR(res.r)}</dd></div>
          <div><dt className="text-2xs text-muted-foreground">{t("result.vsBh")}</dt><dd className={cn("text-base font-semibold tabular-nums", toneText(toneOf(res.vsBh)))}>{fmtPct(res.vsBh)}</dd></div>
          <div><dt className="text-2xs text-muted-foreground">{t("result.maxDd")}</dt><dd className="tabular-nums">{fmtUsd(-res.maxDrawdown)}</dd></div>
          <div><dt className="text-2xs text-muted-foreground">{t("result.fees")}</dt><dd className="tabular-nums">{fmtUsd(-res.fees)}</dd></div>
        </dl>
        <p className={cn("mt-2 flex items-center gap-1.5 text-xs font-medium", beat ? "text-up" : "text-muted-foreground")}>
          {beat ? <Trophy className="h-3.5 w-3.5" aria-hidden="true" /> : null}
          {beat ? t("result.beat") : t("result.lost")}
        </p>
        <p className="text-2xs text-muted-foreground">{t("result.bh", { qty: fmtCount(res.bh.qty), value: `${fmtUsd(res.bh.net, { signed: true })} (${fmtPct(res.bh.pct)})` })}</p>
        {res.equity.length > 2 && (
          <div className="mt-2" title={t("result.equity")}>
            <Sparkline data={res.equity} width={280} height={36} tone="auto" baseline={0} className="w-full" ariaLabel={t("result.equity")} />
          </div>
        )}
      </div>
      <Button size="lg" className="min-h-11" onClick={onAgain} disabled={starting}>
        <RotateCcw aria-hidden="true" /> {t("result.again")} <Kbd className="border-white/30 bg-white/10 text-white/90">Enter</Kbd>
      </Button>
      <div className="flex flex-wrap gap-2">
        {game.meta.mode === "intraday" && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/chart-lab?ticker=${encodeURIComponent(r.ticker)}&date=${r.day}`}><CandlestickChart aria-hidden="true" /> {t("result.replay")}</Link>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onStart}>{t("result.toStart")}</Button>
      </div>
    </div>
  );
}

const exitKey = (x: SimTrade["exitReason"]) => x ?? "end";

export function ResultDetails({ game, hiddenDesk, toggleDesk }: { game: GameView; hiddenDesk: ReadonlySet<string>; toggleDesk: (key: string) => void }) {
  const { t } = simI18n.useT();
  const r = game.reveal;
  if (!r) return null;
  const res = r.result;
  const trades = game.state.trades;
  const byTrade = new Map<number, Mistake[]>();
  for (const m of res.mistakes) if (m.trade != null) byTrade.set(m.trade, [...(byTrade.get(m.trade) ?? []), m]);
  const swing = game.meta.mode === "swing";
  return (
    <div className="grid grid-cols-1 gap-[var(--grid-gap)] xl:grid-cols-12">
      <section className="glass-panel min-w-0 rounded-2xl p-[var(--panel-p)] xl:col-span-7">
        <h2 className="mb-3 text-sm font-semibold">{t("result.trades")}</h2>
        {trades.length === 0 ? (
          <EmptyState compact icon={CandlestickChart} title={t("result.noTrades", { value: fmtPct(((res.bh.exit - res.bh.entry) / res.bh.entry) * 100) })} />
        ) : (
          <DataTable ariaLabel={t("result.trades")} maxHeight={320}>
            <table>
              <thead>
                <tr>
                  <th className="w-10">{t("result.cols.n")}</th>
                  <th>{t("result.cols.side")}</th>
                  <th className="text-right">{t("result.cols.qty")}</th>
                  <th className="text-right">{t("result.cols.entry")}</th>
                  <th className="text-right">{t("result.cols.exit")}</th>
                  <th>{t("result.cols.exitBy")}</th>
                  <th className="text-right">{t("result.cols.r")}</th>
                  <th className="text-right">{t("result.cols.net")}</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((tr) => {
                  const ms = byTrade.get(tr.n);
                  return (
                    <tr key={tr.n} className={cn(ms && "bg-down/[0.06]")}>
                      <td className="tabular-nums text-muted-foreground">{tr.n}</td>
                      <td>
                        <span className={tr.side === "long" ? "text-up" : "text-down"}>{t(`side.${tr.side}`)}</span>
                        {ms && <AlertTriangle className="ml-1.5 inline h-3.5 w-3.5 text-down" aria-label={ms.map(mistakeText).join("; ")} />}
                      </td>
                      <td className="text-right tabular-nums">{fmtCount(tr.maxQty)}</td>
                      <td className="text-right tabular-nums">{fmtPrice(tr.entryAvg)}</td>
                      <td className="text-right tabular-nums">{fmtPrice(tr.exitAvg)}</td>
                      <td className="text-muted-foreground">{t(`result.exitBy.${exitKey(tr.exitReason)}`)}</td>
                      <td className={cn("text-right tabular-nums", toneText(toneOf(tr.r)))}>{fmtR(tr.r)}</td>
                      <td className={cn("text-right tabular-nums", toneText(toneOf(tr.net)))}>{fmtUsd(tr.net, { signed: true })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTable>
        )}
        <h3 className="mb-2 mt-4 text-sm font-semibold">{t("result.mistakesTitle")}</h3>
        {res.mistakes.length === 0 ? (
          <p className="flex items-center gap-1.5 text-sm text-up"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{t("result.noMistakes")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {res.mistakes.map((m, i) => (
              <li key={`${m.kind}-${m.trade}-${i}`} className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden="true" />
                <span>{mistakeText(m)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="glass-panel min-w-0 rounded-2xl p-[var(--panel-p)] xl:col-span-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{r.own ? simOwnI18n.t("result.deskTitle", { ticker: r.ticker }) : swing ? t("result.deskTitleSwing") : t("result.deskTitle")}</h2>
        {r.desk.traders.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            <p>{swing ? t("result.deskNoneSwing") : t("result.deskNone")}</p>
            {r.desk.intradayCount ? <p className="mt-1 text-xs">{t("result.deskIntraday", { count: r.desk.intradayCount })}</p> : null}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {r.desk.traders.map((d) => <DeskRow key={d.key} d={d} hidden={hiddenDesk.has(d.key)} onToggle={() => toggleDesk(d.key)} />)}
          </ul>
        )}
        {r.desk.outside > 0 && <p className="mt-2 text-2xs text-muted-foreground">{t("result.deskOutside", { count: r.desk.outside })}</p>}
      </section>
    </div>
  );
}

function DeskRow({ d, hidden, onToggle }: { d: DeskTrader; hidden: boolean; onToggle: () => void }) {
  const { t } = simI18n.useT();
  const name = d.own ? t("result.deskMe") : d.name ? personName(d.name) : t("result.deskAnon", { label: d.label });
  const sumR = d.trades.reduce((s, x) => s + (x.r ?? 0), 0);
  const anyR = d.trades.some((x) => x.r != null);
  const net = d.trades.every((x) => x.net != null) ? d.trades.reduce((s, x) => s + (x.net ?? 0), 0) : null;
  return (
    <li className={cn("tile flex items-center gap-3 rounded-xl px-3 py-2", hidden && "opacity-60")}>
      <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white", d.own ? "bg-primary" : "bg-purple")} aria-hidden="true">
        {d.own ? "★" : d.label || name.slice(0, 1)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={name}>{name}</p>
        <p className="flex flex-wrap gap-1.5 text-2xs text-muted-foreground">
          {d.trades.map((x, i) => (
            <span key={i} className={x.side === "long" ? "text-up" : "text-down"}>
              {t(`side.${x.side}`)}{x.perShare != null ? ` ${t("result.deskPerShare", { value: fmtUsd(x.perShare, { signed: true }) })}` : ""}
            </span>
          ))}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {anyR && <p className={cn("text-sm font-semibold tabular-nums", toneText(toneOf(sumR)))}>{fmtR(sumR)}</p>}
        {net != null && <p className={cn("text-2xs tabular-nums", toneText(toneOf(net)))}>{fmtUsd(net, { signed: true })}</p>}
      </div>
      <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-pressed={!hidden} title={t("result.deskShow")} aria-label={`${t("result.deskShow")}: ${name}`}>
        {hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </Button>
    </li>
  );
}

export function LevelPill({ mode, difficulty }: { mode: GameView["meta"]["mode"]; difficulty: GameView["meta"]["difficulty"] }) {
  const { t } = simI18n.useT();
  return <Pill tone="neutral">{t("result.sameLevel", { mode: t(`mode.${mode}`), level: t(`difficulty.${difficulty}`) })}</Pill>;
}
