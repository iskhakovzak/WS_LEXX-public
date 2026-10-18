/**
 * Simulator API (server: api-server/src/routes/sim.ts, lib/sim/*). The server holds the whole bar series; the client
 * only ever receives bars up to the cursor (fake times) and the reveal after the game.
 */
import { queryOptions } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { OWN_CANDIDATES_KEY } from "@/components/shared/replay-own-day";

export type SimMode = "intraday" | "swing";
export type Difficulty = "easy" | "medium" | "hard";
export type SimTf = "1m" | "2m" | "5m" | "1d";
/** Intraday bar sizes the player may pick (server lib/sim/scenario INTRADAY_TFS; 2m is aggregated from 1m). */
export type IntradayTf = "1m" | "2m" | "5m";
export const INTRADAY_TFS: readonly IntradayTf[] = ["1m", "2m", "5m"];
export const isIntradayTf = (v: unknown): v is IntradayTf => v === "1m" || v === "2m" || v === "5m";
export type OrderKind = "buy" | "sell" | "flat";

/** [t (fake epoch s), o, h, l, c, v] */
export type WireBar = [number, number, number, number, number, number];

export type FillReason = "buy" | "sell" | "flat" | "stop" | "target" | "end";
export type SimFill = { idx: number; price: number; qty: number; reason: FillReason; fee: number };
export type SimTrade = {
  n: number; side: "long" | "short"; openIdx: number; closeIdx: number | null; entryAvg: number; exitAvg: number | null; maxQty: number;
  gross: number; fees: number; net: number; riskPerShare: number; r: number; mfe: number; mae: number; mfeR: number; maeR: number;
  hadStop: boolean; adds: number; addedToLoser: boolean; exitReason: FillReason | null;
};
export type PublicState = {
  pos: number; avg: number | null; stop: number | null; target: number | null;
  realized: number; fees: number; unrealized: number; net: number;
  fills: SimFill[]; trades: SimTrade[]; canUndo: boolean;
};
export type Levels = { pdh: number | null; pdl: number | null; pdc: number | null; pmh: number | null; pml: number | null };

export type MistakeKind = "heldLoser" | "gaveBack" | "cutWinner" | "addedToLoser" | "noStop" | "overtrading";
export type Mistake = { kind: MistakeKind; trade: number | null; value: number };
export type SimResult = {
  net: number; gross: number; fees: number; pct: number; r: number; trades: number; wins: number;
  bh: { entry: number; exit: number; qty: number; net: number; pct: number };
  vsBh: number; beatBh: boolean; maxDrawdown: number; mistakes: Mistake[]; equity: number[];
};
export type DeskFill = { idx: number; price: number; side: "in" | "out" };
export type DeskTrader = {
  key: string; name: string | null; label: string; own: boolean;
  trades: { side: "long" | "short"; r: number | null; perShare: number | null; net: number | null; fills: DeskFill[] }[];
};
/* Own mode («Мои худшие дни», server lib/sim/own.ts): the player's own losing trade, replayed. */
export type OwnPick = "worst" | "random" | "trade";
export type LegRole = "entry" | "reentry" | "flip" | "add" | "partial_exit" | "exit" | "stop";
export type OwnPublic = { tradeId: number; pick: OwnPick; ticker: string; date: string; decisionIdx: number; riskSource: "trade" | "stop" | "atr" };
export type OwnCompare = { realNet: number; realR: number; simNet: number; simR: number; diff: number; riskUsd: number; verdict: "better" | "same" | "worse" | "skipped" };
export type OwnReveal = OwnPublic & {
  side: "long" | "short"; entryIdx: number; exitIdx: number | null;
  realNet: number; realGross: number; realFees: number; maxQty: number; avgEntry: number | null; avgExit: number | null; stop: number | null;
  riskUsd: number;
  legs: { role: LegRole; price: number; qty: number | null; at: string | null; idx: number | null }[];
  mistakes: string[];
  compare: OwnCompare;
};
export type { OwnCandidate, OwnCandidates } from "@/components/shared/replay-own-day";
export { ownCandidatesQuery } from "@/components/shared/replay-own-day";

export type Reveal = {
  ticker: string; longName: string | null; day: string; dayTo: string | null; realTimes: number[]; result: SimResult;
  desk: { traders: DeskTrader[]; outside: number; intradayCount: number | null };
  own: OwnReveal | null;
};

export type Snapshot = {
  id: number; mode: SimMode; difficulty: Difficulty; tf: SimTf; status: "active" | "finished" | "abandoned";
  startIdx: number; endIdx: number; cursor: number;
  feePerShare: number; riskUnit: number; defaultQty: number; maxNotional: number; levels: Levels;
  bars: WireBar[]; state: PublicState; createdAt: string; reveal: Reveal | null;
  own: OwnPublic | null;
};

export type StepBody = {
  order?: { kind: OrderKind; qty?: number } | null;
  bracket?: { stop: number | null; target: number | null } | null;
  advance: number;
};
export type StepResult = { cursor: number; bars: WireBar[]; state: PublicState; done: boolean; reveal: Reveal | null };

export type FinishedGame = {
  id: number; mode: SimMode; difficulty: Difficulty; ticker: string; day: string; dayTo: string | null; tf: SimTf;
  net: number; r: number; pct: number; bhPct: number; beatBh: boolean; trades: number; finishedAt: string;
  own: boolean; ownDiff: number | null;
};
export type MyStats = {
  totals: { games: number; r: number; wins: number; beatBh: number; net: number };
  best: FinishedGame | null;
  streak: { current: number; best: number; days: number };
  byLevel: { mode: SimMode; difficulty: Difficulty; games: number; r: number }[];
  recent: FinishedGame[];
  prefs: { leaderboardVisible: boolean };
  own: { games: number; better: number; diff: number };
};
export type Board = {
  from: string; to: string; hidden: number;
  rows: { userId: number; name: string; games: number; r: number; wins: number; best: number; beatBh: number; me: boolean }[];
};

export const simKeys = {
  all: ["sim"] as const,
  active: () => ["sim", "active"] as const,
  me: () => ["sim", "me"] as const,
  board: () => ["sim", "board"] as const,
  own: () => OWN_CANDIDATES_KEY,
};

/** Language-independent data: no refetch on a language switch. */
const meta = { i18n: false } as const;

export const activeGameQuery = () => queryOptions({
  queryKey: simKeys.active(),
  queryFn: () => http.get<{ game: Snapshot | null }>("/api/sim/games/active").then((r) => r.game),
  staleTime: 0,
  meta,
});
export const myStatsQuery = () => queryOptions({ queryKey: simKeys.me(), queryFn: () => http.get<MyStats>("/api/sim/me"), staleTime: STALE.short, meta });
export const boardQuery = () => queryOptions({ queryKey: simKeys.board(), queryFn: () => http.get<Board>("/api/sim/leaderboard"), staleTime: STALE.short, meta });

export const simApi = {
  create: (mode: SimMode, difficulty: Difficulty, tf?: IntradayTf | null) =>
    http.post<Snapshot>("/api/sim/games", mode === "intraday" && tf ? { mode, difficulty, tf } : { mode, difficulty }),
  createOwn: (pick: OwnPick, tradeId?: number, tf?: IntradayTf | null) =>
    http.post<Snapshot>("/api/sim/own", { pick, ...(tradeId != null ? { tradeId } : {}), ...(tf ? { tf } : {}) }),
  game: (id: number) => http.get<Snapshot>(`/api/sim/games/${id}`),
  step: (id: number, body: StepBody) => http.post<StepResult>(`/api/sim/games/${id}/step`, body),
  undo: (id: number) => http.post<StepResult>(`/api/sim/games/${id}/undo`),
  finish: (id: number) => http.post<StepResult>(`/api/sim/games/${id}/finish`),
  prefs: (leaderboardVisible: boolean) => http.put<{ leaderboardVisible: boolean }>("/api/sim/prefs", { leaderboardVisible }),
};
