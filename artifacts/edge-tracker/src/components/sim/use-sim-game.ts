/**
 * Game controller: one serial request queue per game (orders, bracket changes, «next bar», undo, finish), autoplay,
 * and the bar feed for the chart. Every request is built at send time from the latest server state, so an order
 * pressed during autoplay fills at the bar the player is looking at (or the next one if a step was already in
 * flight) — never at an earlier one. Consecutive «next» presses merge into one request.
 *
 * Own mode («Мои худшие дни»): a fresh game autoplays its lead-in and stops on the decision bar (the server also caps
 * every step there), so the player decides at the moment they really entered.
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { humanizeApiError } from "@/lib/api/errors";
import { simI18n } from "@/i18n/ns/simulator";
import { simOwnI18n } from "@/i18n/ns/simOwn";
import { simApi, simKeys, type Difficulty, type OrderKind, type IntradayTf, type OwnPick, type PublicState, type Reveal, type SimMode, type Snapshot, type StepBody, type StepResult } from "./api";
import { entryBracket, fromWire, maxQtyFor, positionAfter, stepErrorOf, type Speed } from "./model";
import { BarFeed, markGameRequested } from "./sim-chart";

export type GameMeta = Omit<Snapshot, "bars" | "state" | "reveal" | "cursor" | "status">;
export type GameView = { meta: GameMeta; feed: BarFeed; cursor: number; state: PublicState; reveal: Reveal | null; done: boolean };

type Item =
  | { k: "advance"; n: number }
  | { k: "order"; kind: OrderKind }
  | { k: "bracket"; stop: number | null; target: number | null }
  | { k: "undo" }
  | { k: "finish" };

export type TicketPrefs = { qty: number; autoStop: boolean; autoTarget: boolean };

function viewOf(s: Snapshot): GameView {
  const { bars, state, reveal, cursor, status, ...meta } = s;
  const feed = new BarFeed(bars.map(fromWire));
  if (reveal) feed.realTimes = reveal.realTimes.slice(0, feed.bars.length);
  return { meta, feed, cursor, state, reveal, done: status !== "active" };
}

export function useSimGame(ticket: TicketPrefs, speed: Speed) {
  const { t } = simI18n.useT();
  const qc = useQueryClient();
  const [game, setGame] = React.useState<GameView | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [playing, setPlaying] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const gameRef = React.useRef<GameView | null>(null);
  gameRef.current = game;
  const ticketRef = React.useRef(ticket);
  ticketRef.current = ticket;
  const queue = React.useRef<Item[]>([]);
  const inflight = React.useRef(false);

  const invalidate = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: simKeys.me() });
    void qc.invalidateQueries({ queryKey: simKeys.board() });
    void qc.invalidateQueries({ queryKey: simKeys.active() });
    void qc.invalidateQueries({ queryKey: simKeys.own() });
  }, [qc]);

  const load = React.useCallback((s: Snapshot) => {
    queue.current = [];
    const v = viewOf(s);
    // Own mode: a game still in its lead-in plays itself up to the decision bar.
    setPlaying(!v.done && v.meta.own != null && v.cursor < v.meta.own.decisionIdx);
    setGame(v);
  }, []);

  const apply = React.useCallback((r: StepResult) => {
    const g = gameRef.current;
    if (!g) return;
    g.feed.push(r.bars.map(fromWire));
    if (r.done && r.reveal) g.feed.relabel(r.reveal.realTimes);
    const decision = g.meta.own?.decisionIdx;
    if (decision != null && g.cursor < decision && r.cursor >= decision) {
      // The decision moment: stop the autoplay and drop bars still owed, the player acts first.
      setPlaying(false);
      queue.current = queue.current.filter((x) => x.k !== "advance");
    }
    const next: GameView = { ...g, cursor: r.cursor, state: r.state, reveal: r.reveal ?? g.reveal, done: r.done };
    gameRef.current = next;
    setGame(next);
    if (r.done) {
      queue.current = [];
      setPlaying(false);
      invalidate();
    }
  }, [invalidate]);

  const showError = React.useCallback((err: unknown) => {
    const e = stepErrorOf(err);
    const msg = e.reason === "buyingPower" ? t("hud.errors.buyingPower", { count: e.maxQty ?? 0 })
      : e.reason === "generic" ? humanizeApiError(err, t("hud.errors.generic")) : t(`hud.errors.${e.reason}`);
    toast({ title: msg, variant: "destructive" });
  }, [t]);

  /** Build the request for the head of the queue from the latest state. Null = nothing to send (skip the item). */
  const bodyFor = React.useCallback((it: Item, g: GameView): StepBody | null => {
    if (it.k === "advance") return { advance: Math.min(60, it.n) };
    if (it.k === "bracket") return { bracket: { stop: it.stop, target: it.target }, advance: 0 };
    if (it.k !== "order") return null;
    const pos = g.state.pos;
    if (it.kind === "flat" && pos === 0) return null;
    const price = g.feed.bars[g.cursor]?.c ?? 0;
    const qty = Math.max(1, Math.floor(ticketRef.current.qty));
    const next = positionAfter(pos, it.kind, qty);
    const maxQty = maxQtyFor(g.meta.maxNotional, price);
    if (it.kind !== "flat" && Math.abs(next) > Math.abs(pos) && Math.abs(next) > maxQty) {
      toast({ title: t("hud.errors.buyingPower", { count: maxQty }), variant: "destructive" });
      return null;
    }
    const bracket = entryBracket(pos, next, price, g.meta.riskUnit, ticketRef.current);
    return { order: it.kind === "flat" ? { kind: "flat" } : { kind: it.kind, qty }, bracket: bracket ?? null, advance: 0 };
  }, [t]);

  const pump = React.useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    try {
      while (queue.current.length) {
        const g = gameRef.current;
        if (!g || g.done) { queue.current = []; break; }
        const it = queue.current.shift()!;
        try {
          if (it.k === "undo") apply(await simApi.undo(g.meta.id));
          else if (it.k === "finish") apply(await simApi.finish(g.meta.id));
          else {
            const body = bodyFor(it, g);
            if (body) apply(await simApi.step(g.meta.id, body));
          }
        } catch (err) {
          showError(err);
          setPlaying(false);
          queue.current = queue.current.filter((x) => x.k !== "advance");
        }
      }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }, [apply, bodyFor, showError]);

  const enqueue = React.useCallback((it: Item) => {
    const g = gameRef.current;
    if (!g || g.done) return;
    const q = queue.current;
    const last = q[q.length - 1];
    if (it.k === "advance" && last?.k === "advance") last.n = Math.min(60, last.n + it.n);
    else q.push(it);
    void pump();
  }, [pump]);

  const next = React.useCallback((n = 1) => enqueue({ k: "advance", n }), [enqueue]);
  const order = React.useCallback((kind: OrderKind) => enqueue({ k: "order", kind }), [enqueue]);
  const setBracket = React.useCallback((stop: number | null, target: number | null) => enqueue({ k: "bracket", stop, target }), [enqueue]);
  const undo = React.useCallback(() => enqueue({ k: "undo" }), [enqueue]);
  const finish = React.useCallback(() => enqueue({ k: "finish" }), [enqueue]);

  // Autoplay at `speed` bars/s. Bars owed while a request is in flight are asked for together in the next one, so
  // the pace holds even when a round trip is slower than one bar (they arrive as a small batch, nothing is buffered
  // client-side — what is on screen is always exactly what the server has revealed).
  React.useEffect(() => {
    if (!playing) return;
    let owed = 0;
    const id = window.setInterval(() => {
      owed = Math.min(owed + 1, 20);
      if (inflight.current || queue.current.length) return;
      next(owed);
      owed = 0;
    }, Math.round(1000 / speed));
    return () => window.clearInterval(id);
  }, [playing, speed, next]);

  const start = React.useCallback(async (mode: SimMode, difficulty: Difficulty, tf?: IntradayTf | null) => {
    setStarting(true);
    markGameRequested();
    try {
      load(await simApi.create(mode, difficulty, tf));
      void qc.invalidateQueries({ queryKey: simKeys.active() });
    } catch (err) {
      const status = (err as { status?: number }).status;
      toast({ title: status === 404 ? t("start.noScenarios") : humanizeApiError(err, t("errors.load")), variant: "destructive" });
    } finally {
      setStarting(false);
    }
  }, [load, qc, t]);

  const startOwn = React.useCallback(async (pick: OwnPick, tradeId?: number, tf?: IntradayTf | null) => {
    setStarting(true);
    markGameRequested();
    try {
      load(await simApi.createOwn(pick, tradeId, tf));
      void qc.invalidateQueries({ queryKey: simKeys.active() });
      void qc.invalidateQueries({ queryKey: simKeys.own() });
    } catch (err) {
      const reason = (err as { body?: { details?: { reason?: unknown } } }).body?.details?.reason;
      const known = reason === "noBars" || reason === "notReplayable" || reason === "noOwnTrades" ? reason : null;
      toast({ title: known ? simOwnI18n.t(`errors.${known}`) : humanizeApiError(err, t("errors.load")), variant: "destructive" });
    } finally {
      setStarting(false);
    }
  }, [load, qc, t]);

  const open = React.useCallback(async (id: number) => {
    try { load(await simApi.game(id)); } catch (err) { toast({ title: humanizeApiError(err, t("errors.load")), variant: "destructive" }); }
  }, [load, t]);

  const leave = React.useCallback(() => {
    queue.current = [];
    setPlaying(false);
    setGame(null);
    invalidate();
  }, [invalidate]);

  return { game, starting, playing, setPlaying, busy, start, startOwn, open, load, leave, next, order, setBracket, undo, finish };
}
