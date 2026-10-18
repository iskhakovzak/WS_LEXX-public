/**
 * In-game side panel. Top to bottom in the order of a decision: where am I (position, open P&L in $ and R) → act
 * (Buy / Sell / Close, size) → protect (stop / target) → go on (Next, Auto, speed) → keys. Few controls up front;
 * the bracket editor only appears when there is a position (UX §4a.6).
 */
import * as React from "react";
import { FastForward, Pause, Play, ShieldCheck, StepForward, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Kbd, Segmented, toneOf, toneText } from "@/components/ds";
import { fmtCount, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { simOwnI18n } from "@/i18n/ns/simOwn";
import { simI18n } from "@/i18n/ns/simulator";
import type { PublicState } from "./api";
import { SPEEDS, parsePrice, presetQty, roundPrice, type SizePreset, type Speed } from "./model";
import type { GameView } from "./use-sim-game";

/** Keep mouse clicks from leaving focus on a button (Space would then also «click» it). */
const noFocus = (e: React.PointerEvent) => e.preventDefault();

export function openR(s: PublicState): number | null {
  const open = s.trades.find((t) => t.closeIdx == null);
  return open ? open.r : null;
}

export function PositionCard({ game }: { game: GameView }) {
  const { t } = simI18n.useT();
  const s = game.state;
  const r = openR(s);
  const price = game.feed.bars[game.cursor]?.c ?? null;
  return (
    <div className="tile rounded-xl p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className={cn("text-base font-semibold", s.pos > 0 ? "text-up" : s.pos < 0 ? "text-down" : "text-foreground")}>
          {s.pos === 0 ? t("hud.flat") : t(s.pos > 0 ? "hud.long" : "hud.short", { qty: fmtCount(Math.abs(s.pos)) })}
        </p>
        {s.pos !== 0 && s.avg != null && <p className="text-xs tabular-nums text-muted-foreground">{t("hud.at", { price: fmtPrice(s.avg) })}</p>}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-2xs text-muted-foreground">{t("hud.openPnl")}</p>
          <p className={cn("text-2xl font-semibold tabular-nums leading-tight", toneText(toneOf(s.unrealized)))}>{fmtUsd(s.unrealized, { signed: true })}</p>
        </div>
        <p className={cn("pb-0.5 text-lg font-semibold tabular-nums", toneText(toneOf(r)))}>{r != null ? fmtR(r) : ""}</p>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 border-t border-[var(--glass-border)] pt-2 text-xs">
        <div className="min-w-0"><dt className="text-2xs text-muted-foreground">{t("hud.realized")}</dt><dd className={cn("tabular-nums", toneText(toneOf(s.realized)))}>{fmtUsd(s.realized, { signed: true })}</dd></div>
        <div className="min-w-0"><dt className="text-2xs text-muted-foreground">{t("hud.fees")}</dt><dd className="tabular-nums">{fmtUsd(-s.fees)}</dd></div>
        <div className="min-w-0"><dt className="text-2xs text-muted-foreground">{t("hud.net")}</dt><dd className={cn("font-semibold tabular-nums", toneText(toneOf(s.net)))}>{fmtUsd(s.net, { signed: true })}</dd></div>
      </dl>
      {price != null && <span className="sr-only">{fmtPrice(price)}</span>}
    </div>
  );
}

export function OrderPad({
  game, qty, setQty, onOrder, onUndo, disabled,
}: {
  game: GameView;
  qty: number;
  setQty: (q: number) => void;
  onOrder: (k: "buy" | "sell" | "flat") => void;
  onUndo: () => void;
  disabled: boolean;
}) {
  const { t } = simI18n.useT();
  const base = game.meta.defaultQty;
  const price = game.feed.bars[game.cursor]?.c ?? 0;
  const preset: SizePreset | "" = qty === presetQty(base, "half") ? "half" : qty === base ? "base" : qty === presetQty(base, "double") ? "double" : "";
  const [text, setText] = React.useState(String(qty));
  React.useEffect(() => { setText(String(qty)); }, [qty]);
  const commit = () => {
    const v = Math.floor(Number(text));
    if (Number.isFinite(v) && v >= 1) setQty(v); else setText(String(qty));
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-2">
        <Button onPointerDown={noFocus} disabled={disabled} onClick={() => onOrder("buy")} className="min-h-12 flex-col gap-0 border-up/40 bg-up text-white hover:brightness-110" aria-keyshortcuts="B">
          <span>{t("hud.buy")}</span><span className="text-2xs font-normal opacity-80">B</span>
        </Button>
        <Button onPointerDown={noFocus} disabled={disabled} onClick={() => onOrder("sell")} className="min-h-12 flex-col gap-0 border-down/40 bg-down text-white hover:brightness-110" aria-keyshortcuts="S">
          <span>{t("hud.sell")}</span><span className="text-2xs font-normal opacity-80">S</span>
        </Button>
        <Button onPointerDown={noFocus} variant="secondary" disabled={disabled || game.state.pos === 0} onClick={() => onOrder("flat")} className="min-h-12 flex-col gap-0" aria-keyshortcuts="F">
          <span>{t("hud.close")}</span><span className="text-2xs font-normal text-muted-foreground">F</span>
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="sim-qty">{t("hud.size")}</label>
        <Input
          id="sim-qty" inputMode="numeric" value={text} onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ""))}
          onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); } }}
          className="h-8 w-24 text-right tabular-nums" title={t("hud.size")}
        />
        <Segmented
          size="sm" ariaLabel={t("hud.size")} value={preset}
          onChange={(p) => { if (p) setQty(presetQty(base, p as SizePreset)); }}
          options={[{ value: "half", label: t("hud.half") }, { value: "base", label: t("hud.base") }, { value: "double", label: t("hud.double") }]}
        />
        <span className="ml-auto truncate text-2xs tabular-nums text-muted-foreground">{t("hud.notional", { value: fmtUsd(qty * price, { decimals: 0 }) })}</span>
      </div>
      {game.state.canUndo && (
        <Button onPointerDown={noFocus} variant="ghost" size="sm" onClick={onUndo} className="self-start" aria-keyshortcuts="Z">
          <Undo2 aria-hidden="true" /> {t("hud.undo")} <Kbd>Z</Kbd>
        </Button>
      )}
    </div>
  );
}

export function BracketBox({
  game, autoStop, setAutoStop, autoTarget, setAutoTarget, onBracket, disabled,
}: {
  game: GameView;
  autoStop: boolean;
  setAutoStop: (v: boolean) => void;
  autoTarget: boolean;
  setAutoTarget: (v: boolean) => void;
  onBracket: (stop: number | null, target: number | null) => void;
  disabled: boolean;
}) {
  const { t } = simI18n.useT();
  const s = game.state;
  const [stop, setStop] = React.useState("");
  const [target, setTarget] = React.useState("");
  React.useEffect(() => { setStop(s.stop != null ? String(s.stop) : ""); setTarget(s.target != null ? String(s.target) : ""); }, [s.stop, s.target, s.pos]);
  const price = game.feed.bars[game.cursor]?.c ?? 0;
  const ru = game.meta.riskUnit;
  const dir = Math.sign(s.pos);
  const apply = () => onBracket(parsePrice(stop), parsePrice(target));
  const field = (id: string, label: string, value: string, set: (v: string) => void, quick: { text: string; price: number }) => (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-12 shrink-0 text-xs text-muted-foreground">{label}</label>
      <Input id={id} inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") apply(); }} className="h-8 min-w-0 flex-1 text-right tabular-nums" />
      <Button type="button" variant="outline" size="sm" className="w-12 shrink-0 px-0" onClick={() => set(String(quick.price))}>{quick.text}</Button>
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="sim-autostop" className="flex items-center gap-2 text-xs"><ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />{t("hud.autoStop")}</label>
        <Switch id="sim-autostop" checked={autoStop} onCheckedChange={setAutoStop} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="sim-autotarget" className="pl-5.5 text-xs">{t("hud.autoTarget")}</label>
        <Switch id="sim-autotarget" checked={autoTarget} onCheckedChange={setAutoTarget} />
      </div>
      {s.pos !== 0 && (
        <div className="flex flex-col gap-2 border-t border-[var(--glass-border)] pt-2">
          {field("sim-stop", t("hud.stop"), stop, setStop, { text: "1R", price: roundPrice(price - dir * ru) })}
          {field("sim-target", t("hud.target"), target, setTarget, { text: "2R", price: roundPrice(price + dir * 2 * ru) })}
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" disabled={disabled} onClick={apply}>{t("hud.apply")}</Button>
            {(s.stop != null || s.target != null) && (
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onBracket(null, null)}>{t("hud.clearBracket")}</Button>
            )}
          </div>
        </div>
      )}
      <p className="text-2xs text-muted-foreground">{game.meta.own && game.meta.own.riskSource !== "atr" ? simOwnI18n.t("hudRiskUnit", { value: fmtUsd(ru, { decimals: ru < 1 ? 4 : 2 }) }) : t("hud.riskUnit", { value: fmtUsd(ru, { decimals: ru < 1 ? 4 : 2 }) })}</p>
    </div>
  );
}

export function PlayBar({
  game, playing, setPlaying, speed, setSpeed, onNext, disabled,
}: {
  game: GameView;
  playing: boolean;
  setPlaying: (v: boolean) => void;
  speed: Speed;
  setSpeed: (s: Speed) => void;
  onNext: () => void;
  disabled: boolean;
}) {
  const { t } = simI18n.useT();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button onPointerDown={noFocus} size="lg" className="min-h-11 flex-1" disabled={disabled} onClick={onNext} aria-keyshortcuts="Space ArrowRight">
          <StepForward aria-hidden="true" /> {t("hud.next")} <Kbd className="border-white/30 bg-white/10 text-white/90">␣</Kbd>
        </Button>
        <Button onPointerDown={noFocus} size="lg" variant={playing ? "default" : "secondary"} className="min-h-11" disabled={disabled} onClick={() => setPlaying(!playing)} aria-pressed={playing} aria-keyshortcuts="A">
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />} {playing ? t("hud.pause") : t("hud.auto")}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <FastForward className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Segmented
          size="sm" ariaLabel={t("hud.speed")} value={String(speed)}
          onChange={(v) => setSpeed(Number(v) as Speed)}
          options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×`, title: t("hud.speedValue", { value: s }) }))}
        />
      </div>
      <span className="sr-only" aria-live="polite">{t("hud.bar", { played: game.cursor - game.meta.startIdx, total: game.meta.endIdx - game.meta.startIdx })}</span>
    </div>
  );
}

export function KeysHint() {
  const { t } = simI18n.useT();
  const item = (k: React.ReactNode, text: string) => <span className="inline-flex items-center gap-1 whitespace-nowrap">{k}{text}</span>;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground" aria-label={t("hud.keys.title")}>
      {item(<Kbd>B</Kbd>, t("hud.keys.buy"))}
      {item(<Kbd>S</Kbd>, t("hud.keys.sell"))}
      {item(<Kbd>F</Kbd>, t("hud.keys.flat"))}
      {item(<Kbd>Z</Kbd>, t("hud.keys.undo"))}
      {item(<Kbd keys={["␣", "→"]} />, t("hud.keys.next"))}
      {item(<Kbd>A</Kbd>, t("hud.keys.auto"))}
      {item(<Kbd keys={["[", "]"]} />, t("hud.keys.speed"))}
    </p>
  );
}
