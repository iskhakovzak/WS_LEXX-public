/**
 * /simulator — the chart game: a hidden real chart (a day the desk traded, or months of daily bars), played bar by bar
 * with the desk's fees; at the end the ticker, the date, the result vs buy & hold, mistakes and the desk's real trades.
 * The server serves bars one step at a time (api-server routes/sim.ts), so the future is never in the browser.
 *
 * Old «Что если» links (/simulator?r=…, ?p=…, ?trader=…, #fees) moved to /what-if and are redirected from here.
 * `?game=<id>` opens one of the viewer's games (history → review). `?own=<tradeId>` starts the own mode («Мои худшие
 * дни») on that trade — the trade sheet's «Переиграть этот день» (links.simOwn); the server accepts own trades only.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { Gamepad2 } from "lucide-react";
import { BentoGrid, EmptyState, Page, PageHeader, usePersistentState } from "@/components/ds";
import { useAuth } from "@/contexts/auth-context";
import { simI18n } from "@/i18n/ns/simulator";
import { activeGameQuery, type Difficulty } from "@/components/sim/api";
import { isSpeed, type Speed } from "@/components/sim/model";
import { useSimGame } from "@/components/sim/use-sim-game";
import { GameScreen } from "@/components/sim/game-screen";
import { NewGamePanel, ProgressPanel, RecentGames, WeeklyBoard, isPlayMode, type PlayMode } from "@/components/sim/start-screen";
import type { OwnStartPick } from "@/components/sim/own-start";

const WHAT_IF_PARAMS = ["r", "p", "trader"];

export default function SimulatorPage() {
  const { t } = simI18n.useT();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const search = useSearch();
  const guest = user?.role === "guest";

  // Legacy what-if deep links → /what-if (same query and hash).
  const legacy = React.useMemo(() => {
    const sp = new URLSearchParams(search);
    return WHAT_IF_PARAMS.some((k) => sp.has(k)) || window.location.hash === "#fees";
  }, [search]);
  React.useEffect(() => {
    if (legacy) navigate(`/what-if${search ? `?${search}` : ""}${window.location.hash}`, { replace: true });
  }, [legacy, search, navigate]);

  const [modeRaw, setMode] = usePersistentState<PlayMode>("sim.mode", "intraday");
  const mode: PlayMode = isPlayMode(modeRaw) ? modeRaw : "intraday";
  const [ownPickRaw, setOwnPick] = usePersistentState<OwnStartPick>("sim.ownPick", "worst");
  const ownPick: OwnStartPick = ownPickRaw === "random" ? "random" : "worst";
  const [level, setLevel] = usePersistentState<Difficulty>("sim.level", "easy");
  const [speedRaw, setSpeed] = usePersistentState<number>("sim.speed", 4);
  const speed: Speed = isSpeed(speedRaw) ? speedRaw : 4;
  const [autoStop, setAutoStop] = usePersistentState("sim.autoStop", true);
  const [autoTarget, setAutoTarget] = usePersistentState("sim.autoTarget", false);
  const [qty, setQty] = React.useState(100);

  const sim = useSimGame({ qty, autoStop, autoTarget }, speed);
  const { game, start, startOwn, open, load, starting } = sim;
  const gameId = game?.meta.id ?? null;
  const defaultQty = game?.meta.defaultQty ?? null;
  React.useEffect(() => { if (defaultQty != null) setQty(defaultQty); }, [gameId, defaultQty]);

  const active = useQuery({ ...activeGameQuery(), enabled: !guest && !legacy });

  // ?game=<id>: open a game from the history; keep the URL in sync with the open game.
  const opened = React.useRef<string | null>(null);
  React.useEffect(() => {
    const id = Number(new URLSearchParams(search).get("game"));
    if (!guest && !legacy && id > 0 && opened.current !== String(id) && gameId !== id) {
      opened.current = String(id);
      void open(id);
    }
  }, [search, guest, legacy, gameId, open]);
  // ?own=<tradeId>: replay that own trade (once), then drop the parameter.
  React.useEffect(() => {
    const tradeId = Number(new URLSearchParams(search).get("own"));
    if (guest || legacy || !(tradeId > 0) || opened.current === `own:${tradeId}`) return;
    opened.current = `own:${tradeId}`;
    setMode("own");
    void startOwn("trade", tradeId);
  }, [search, guest, legacy, startOwn, setMode]);
  React.useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    sp.delete("own");
    if (gameId != null && game?.done) sp.set("game", String(gameId)); else sp.delete("game");
    const q = sp.toString();
    const next = `${window.location.pathname}${q ? `?${q}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", next);
  }, [gameId, game?.done]);

  const play = React.useCallback(() => {
    if (mode === "own") void startOwn(ownPick); else void start(mode, level);
  }, [start, startOwn, mode, level, ownPick]);
  const again = React.useCallback(() => {
    if (!game) return;
    const own = game.meta.own;
    if (own) {
      setMode("own");
      void startOwn(own.pick === "trade" ? "worst" : own.pick);
      return;
    }
    setMode(game.meta.mode);
    setLevel(game.meta.difficulty);
    void start(game.meta.mode, game.meta.difficulty);
  }, [game, start, startOwn, setMode, setLevel]);
  const resume = React.useCallback(() => { if (active.data) load(active.data); }, [active.data, load]);

  // Enter on the start screen = Play (or Continue when a game is unfinished).
  React.useEffect(() => {
    if (game || guest) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "Enter" || e.repeat || (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "radio"))) return;
      e.preventDefault();
      if (active.data) resume(); else if (!starting) play();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game, guest, active.data, resume, play, starting]);

  if (legacy) return null;

  if (game) {
    return (
      <Page width="full">
        <GameScreen
          game={game}
          c={{ ...sim, again, busy: sim.busy }}
          qty={qty} setQty={setQty} speed={speed} setSpeed={setSpeed}
          autoStop={autoStop} setAutoStop={setAutoStop} autoTarget={autoTarget} setAutoTarget={setAutoTarget}
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader title={t("title")} description={t("description")} icon={Gamepad2} />
      {guest ? (
        <EmptyState icon={Gamepad2} title={t("title")} description={t("start.guest")} />
      ) : (
        <>
          <BentoGrid>
            <NewGamePanel
              mode={mode} setMode={setMode} level={level} setLevel={setLevel} ownPick={ownPick} setOwnPick={setOwnPick}
              onPlay={play} starting={starting} active={active.data ?? null} onResume={resume}
            />
            <ProgressPanel onOpen={(id) => void open(id)} />
          </BentoGrid>
          <BentoGrid>
            <RecentGames onOpen={(id) => void open(id)} />
            <WeeklyBoard />
          </BentoGrid>
        </>
      )}
    </Page>
  );
}
