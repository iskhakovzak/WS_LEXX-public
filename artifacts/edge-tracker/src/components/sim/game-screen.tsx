/**
 * The game: chart (left, takes the space) + one side column (HUD while playing, the verdict after). Focus mode —
 * nothing else on the page competes with the chart (UX §4a.2). Keys work page-wide except while typing in a field.
 * After the reveal the details (trades, mistakes, the desk) open under the chart. Own mode («Мои худшие дни») swaps
 * the «hidden» badge for «your trade · ticker · date», adds the decision tile on top of the HUD and the real-entry
 * marker on the chart, and shows the then-vs-now verdict (own-result.tsx).
 */
import * as React from "react";
import { EyeOff, Flag, LogOut, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FilterChip, Pill, usePersistentState } from "@/components/ds";
import { fmtCount, fmtDate, fmtPrice, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { simI18n } from "@/i18n/ns/simulator";
import { simOwnI18n } from "@/i18n/ns/simOwn";
import { keyAction, nextSpeed, type Speed } from "./model";
import { SimChart, type ChartToggles } from "./sim-chart";
import { EMPTY_OVERLAY, type OverlayData, type OverlayDeskFill } from "./sim-overlay";
import { BracketBox, KeysHint, OrderPad, PlayBar, PositionCard } from "./hud";
import { LevelPill, ResultDetails, ResultSummary } from "./result";
import { OwnRealTrade, OwnResultSummary } from "./own-result";
import type { GameView } from "./use-sim-game";
import type { OrderKind } from "./api";

const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
};

export type GameControls = {
  playing: boolean;
  setPlaying: (v: boolean) => void;
  busy: boolean;
  starting: boolean;
  next: (n?: number) => void;
  order: (k: OrderKind) => void;
  setBracket: (stop: number | null, target: number | null) => void;
  undo: () => void;
  finish: () => void;
  again: () => void;
  leave: () => void;
};

export function GameScreen({
  game, c, qty, setQty, speed, setSpeed, autoStop, setAutoStop, autoTarget, setAutoTarget,
}: {
  game: GameView;
  c: GameControls;
  qty: number;
  setQty: (q: number) => void;
  speed: Speed;
  setSpeed: (s: Speed) => void;
  autoStop: boolean;
  setAutoStop: (v: boolean) => void;
  autoTarget: boolean;
  setAutoTarget: (v: boolean) => void;
}) {
  const { t } = simI18n.useT();
  const [toggles, setToggles] = usePersistentState<ChartToggles>("sim.chart", { vwap: true, levels: true, ma: true });
  const [hiddenDesk, setHiddenDesk] = React.useState<Set<string>>(new Set());
  const [confirmFinish, setConfirmFinish] = React.useState(false);
  const done = game.done;

  // ── Keyboard ────────────────────────────────────────────────────────────
  const live = React.useRef({ c, done, speed, setSpeed, confirmFinish });
  live.current = { c, done, speed, setSpeed, confirmFinish };
  const lastNext = React.useRef(0);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || live.current.confirmFinish) return;
      if (document.querySelector("[role='dialog'][data-state='open']")) return;
      const a = keyAction(e);
      if (!a) return;
      const { c: ctl, done: isDone } = live.current;
      if (isDone) {
        if (a === "again" && !e.repeat) { e.preventDefault(); ctl.again(); }
        return;
      }
      e.preventDefault();
      switch (a) {
        case "next": {
          // Held key: auto-repeat fires ~30/s; keep it to ≤ 20 bars/s.
          const now = performance.now();
          if (e.repeat && now - lastNext.current < 50) return;
          lastNext.current = now;
          ctl.next(1);
          break;
        }
        case "buy": case "sell": case "flat": if (!e.repeat) ctl.order(a); break;
        case "auto": if (!e.repeat) ctl.setPlaying(!ctl.playing); break;
        case "faster": live.current.setSpeed(nextSpeed(live.current.speed, 1)); break;
        case "slower": live.current.setSpeed(nextSpeed(live.current.speed, -1)); break;
        case "undo": if (!e.repeat) ctl.undo(); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Overlay for the chart ───────────────────────────────────────────────
  const overlay: OverlayData = React.useMemo(() => {
    const s = game.state;
    const open = s.trades.find((x) => x.closeIdx == null) ?? null;
    const sideWord = s.pos > 0 ? t("chart.long") : t("chart.short");
    const desk: OverlayDeskFill[] = [];
    const spans: OverlayData["spans"][number][] = [];
    if (game.reveal) {
      for (const d of game.reveal.desk.traders) {
        if (hiddenDesk.has(d.key)) continue;
        for (const tr of d.trades) for (const f of tr.fills) desk.push({ ...f, long: tr.side === "long", own: d.own, tag: d.own ? "" : d.label });
      }
      const marked = new Set<number>();
      for (const m of game.reveal.result.mistakes) {
        if (m.trade == null || marked.has(m.trade)) continue;
        const tr = s.trades.find((x) => x.n === m.trade);
        if (!tr) continue;
        marked.add(m.trade);
        spans.push({ from: tr.openIdx, to: tr.closeIdx ?? game.cursor, text: `${t("chart.mistake", { n: tr.n })} · ${t(`result.mistakeShort.${m.kind}`)}` });
      }
    }
    const own = game.meta.own;
    const marker = own && game.cursor >= own.decisionIdx ? { idx: own.decisionIdx, text: simOwnI18n.t("chartEntry") } : null;
    if (!s.fills.length && !desk.length && s.pos === 0 && !spans.length) return { ...EMPTY_OVERLAY, cursor: game.cursor, marker };
    return {
      marker,
      fills: s.fills, pos: s.pos, avg: s.avg, stop: s.stop, target: s.target, openIdx: open?.openIdx ?? null, cursor: game.cursor, spans, desk,
      text: {
        position: s.pos !== 0 && s.avg != null ? t("chart.you", { side: sideWord, qty: fmtCount(Math.abs(s.pos)), price: fmtPrice(s.avg) }) : null,
        stop: s.stop != null ? t("chart.stop", { price: fmtPrice(s.stop) }) : null,
        target: s.target != null ? t("chart.target", { price: fmtPrice(s.target) }) : null,
      },
    };
  }, [game.state, game.cursor, game.reveal, game.meta.own, hiddenDesk, t]);

  const total = game.meta.endIdx - game.meta.startIdx;
  const played = game.cursor - game.meta.startIdx;
  const intraday = game.meta.mode === "intraday";

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <div className="flex flex-wrap items-center gap-2">
        {game.meta.own ? (
          <Pill tone="accent"><RotateCcw aria-hidden="true" />{simOwnI18n.t("banner.pill", { ticker: game.meta.own.ticker, date: fmtDate(game.meta.own.date, "medium") })}</Pill>
        ) : (
          <>
            <LevelPill mode={game.meta.mode} difficulty={game.meta.difficulty} />
            {!done && <Pill tone="neutral"><EyeOff aria-hidden="true" />{t("hiddenBadge")}</Pill>}
          </>
        )}
        <div className="flex min-w-[12rem] flex-1 items-center gap-2" aria-hidden="true">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--glass-bg)]">
            <div className="h-full rounded-full bg-primary transition-[width] duration-[var(--dur-1)] motion-reduce:transition-none" style={{ width: `${total > 0 ? (played / total) * 100 : 0}%` }} />
          </div>
          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{t("hud.bar", { played, total })}</span>
        </div>
        <div className="flex items-center gap-1">
          <FilterChip size="sm" active={toggles.levels} onClick={() => setToggles({ ...toggles, levels: !toggles.levels })}>{t("chart.levels")}</FilterChip>
          {intraday
            ? <FilterChip size="sm" active={toggles.vwap} onClick={() => setToggles({ ...toggles, vwap: !toggles.vwap })}>{t("chart.vwap")}</FilterChip>
            : <FilterChip size="sm" active={toggles.ma} onClick={() => setToggles({ ...toggles, ma: !toggles.ma })}>{t("chart.ma")}</FilterChip>}
        </div>
        {!done && (
          <>
            <Button variant="outline" size="sm" onClick={() => setConfirmFinish(true)}><Flag aria-hidden="true" /> {t("hud.finish")}</Button>
            <Button variant="ghost" size="sm" onClick={c.leave} title={t("hud.exitHint")}><LogOut aria-hidden="true" /> {t("hud.exit")}</Button>
          </>
        )}
      </div>

      <div className="grid min-h-0 grid-cols-1 gap-[var(--grid-gap)] lg:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="glass-panel relative h-[calc(100dvh-13rem)] min-h-[480px] overflow-hidden rounded-2xl p-2">
          <SimChart feed={game.feed} mode={game.meta.mode} startIdx={game.meta.startIdx} levels={game.meta.levels} overlay={overlay} toggles={toggles} />
        </div>
        <aside className="glass-panel flex min-h-0 flex-col gap-3 overflow-y-auto rounded-2xl p-[var(--panel-p)] lg:h-[calc(100dvh-13rem)] lg:min-h-[480px]">
          {done ? (
            game.reveal?.own
              ? <OwnResultSummary game={game} onAgain={c.again} onStart={c.leave} starting={c.starting} />
              : <ResultSummary game={game} onAgain={c.again} onStart={c.leave} starting={c.starting} />
          ) : (
            <>
              {game.meta.own && <OwnMoment cursor={game.cursor} decisionIdx={game.meta.own.decisionIdx} />}
              <PositionCard game={game} />
              <OrderPad game={game} qty={qty} setQty={setQty} onOrder={c.order} onUndo={c.undo} disabled={false} />
              <BracketBox game={game} autoStop={autoStop} setAutoStop={setAutoStop} autoTarget={autoTarget} setAutoTarget={setAutoTarget} onBracket={c.setBracket} disabled={false} />
              <div className="mt-auto flex flex-col gap-3">
                <PlayBar game={game} playing={c.playing} setPlaying={c.setPlaying} speed={speed} setSpeed={setSpeed} onNext={() => c.next(1)} disabled={false} />
                <p className="text-2xs text-muted-foreground">{game.meta.own ? simOwnI18n.t("hudFee", { value: fmtUsd(game.meta.feePerShare, { decimals: 4 }) }) : t("hud.fee", { value: fmtUsd(game.meta.feePerShare, { decimals: 4 }) })}</p>
                <KeysHint />
              </div>
            </>
          )}
        </aside>
      </div>

      {done && game.reveal?.own && <OwnRealTrade own={game.reveal.own} />}
      {done && <ResultDetails game={game} hiddenDesk={hiddenDesk} toggleDesk={(k) => setHiddenDesk((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />}

      <AlertDialog open={confirmFinish} onOpenChange={setConfirmFinish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("hud.finishTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("hud.finishText")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{simI18n.t("start.resume")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmFinish(false); c.finish(); }}>{t("hud.finish")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Own mode: where the player is relative to their real entry (lead-in → the decision → the rest of the day). */
function OwnMoment({ cursor, decisionIdx }: { cursor: number; decisionIdx: number }) {
  const { t } = simOwnI18n.useT();
  const phase = cursor < decisionIdx ? "lead" : cursor === decisionIdx ? "decision" : "after";
  return (
    <div
      role="status"
      className={cn("tile rounded-xl p-3 text-sm", phase === "decision" ? "font-medium ring-2 ring-primary" : "text-muted-foreground")}
    >
      {t(`banner.${phase}`)}
    </div>
  );
}
