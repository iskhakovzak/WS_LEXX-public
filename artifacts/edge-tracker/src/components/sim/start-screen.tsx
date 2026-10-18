
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CandlestickChart, Flame, Gauge, History, Play, RotateCcw, Sigma, Trophy, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { DataTable, EmptyState, ErrorState, Kbd, ListSkeleton, Panel, Segmented, StatCard, StatGrid, toneOf, toneText } from "@/components/ds";
import { fmtDate, fmtPct, fmtR, fmtRate, fmtUsd, fmtCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { simI18n } from "@/i18n/ns/simulator";
import { simOwnI18n } from "@/i18n/ns/simOwn";
import { boardQuery, myStatsQuery, ownCandidatesQuery, simApi, simKeys, type Difficulty, type FinishedGame, type SimMode, type Snapshot } from "./api";
import { OwnPicker, type OwnStartPick } from "./own-start";

/** What the start screen offers: the two fair modes and the own replay («Мои худшие дни»). */
export type PlayMode = SimMode | "own";
export const isPlayMode = (v: unknown): v is PlayMode => v === "intraday" || v === "swing" || v === "own";

import { personName } from "@/i18n";
const LEVELS: Difficulty[] = ["easy", "medium", "hard"];
const PLAY_BARS: Record<SimMode, Record<Difficulty, number>> = {
  intraday: { easy: 78, medium: 90, hard: 180 },
  swing: { easy: 60, medium: 100, hard: 140 },
};

export function NewGamePanel({
  mode, setMode, level, setLevel, ownPick, setOwnPick, onPlay, starting, active, onResume,
}: {
  mode: PlayMode;
  setMode: (m: PlayMode) => void;
  level: Difficulty;
  setLevel: (d: Difficulty) => void;
  ownPick: OwnStartPick;
  setOwnPick: (p: OwnStartPick) => void;
  onPlay: () => void;
  starting: boolean;
  active: Snapshot | null;
  onResume: () => void;
}) {
  const { t } = simI18n.useT();
  const { t: to } = simOwnI18n.useT();
  const own = useQuery({ ...ownCandidatesQuery(), enabled: mode === "own" });
  const ownEmpty = mode === "own" && (own.isLoading || !own.data?.trades.length);
  return (
    <Panel title={t("start.title")} icon={Play} fill className="lg:col-span-7">
      <div className="flex flex-col gap-4">
        {active && (
          <div className="tile flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t("start.resumeTitle")}</p>
              <p className="text-xs text-muted-foreground">
                {active.own ? `${to("mode")} · ${active.own.ticker}` : `${t(`mode.${active.mode}`)} · ${t(`difficulty.${active.difficulty}`)}`} · {t("start.resumeHint", { played: active.cursor - active.startIdx, total: active.endIdx - active.startIdx })}
              </p>
            </div>
            <Button onClick={onResume}>{t("start.resume")}</Button>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">{t("start.modeLabel")}</p>
          <Segmented
            ariaLabel={t("start.modeLabel")} value={mode} onChange={setMode}
            options={[
              { value: "intraday", label: <><CandlestickChart aria-hidden="true" />{t("mode.intraday")}</> },
              { value: "swing", label: <><CalendarClock aria-hidden="true" />{t("mode.swing")}</> },
              { value: "own", label: <><RotateCcw aria-hidden="true" />{to("mode")}</> },
            ]}
          />
          <p className="text-xs text-muted-foreground">{mode === "own" ? to("modeHint") : t(`modeHint.${mode}`)}</p>
        </div>
        {mode === "own" ? (
          <OwnPicker data={own.data} loading={own.isLoading} pick={ownPick} setPick={setOwnPick} />
        ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">{t("start.levelLabel")}</p>
          <div role="radiogroup" aria-label={t("start.levelLabel")} className="grid grid-cols-3 gap-2">
            {LEVELS.map((d) => {
              const on = d === level;
              return (
                <button
                  key={d} type="button" role="radio" aria-checked={on} onClick={() => setLevel(d)}
                  className={cn(
                    "tile flex min-h-[92px] flex-col items-start gap-1 rounded-xl p-3 text-left transition-[box-shadow,background-color] duration-[var(--dur-1)]",
                    on ? "ring-2 ring-primary" : "hover:bg-[var(--tile-hover-bg)]",
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{t(`difficulty.${d}`)}</span>
                    <Gauge className={cn("h-4 w-4", d === "easy" ? "text-up" : d === "medium" ? "text-warn" : "text-down")} aria-hidden="true" />
                  </span>
                  <span className="text-xs text-muted-foreground">{t(`levelHint.${mode}.${d}`)}</span>
                  <span className="mt-auto text-2xs tabular-nums text-muted-foreground">{t("bars", { count: PLAY_BARS[mode][d] })}</span>
                </button>
              );
            })}
          </div>
        </div>
        )}
        <Button size="lg" className="min-h-12 self-stretch text-base sm:self-start sm:px-10" onClick={onPlay} disabled={starting || ownEmpty} aria-keyshortcuts="Enter">
          <Play aria-hidden="true" /> {starting ? t("start.starting") : t("start.play")} {!starting && <Kbd className="border-white/30 bg-white/10 text-white/90">Enter</Kbd>}
        </Button>
        <div className="border-t border-[var(--glass-border)] pt-3">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("start.howTitle")}</p>
          <ul className="grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
            {(["a", "b", "c", "d"] as const).map((k) => <li key={k} className="flex gap-2"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true" />{mode === "own" ? to(`how.${k}`) : t(`start.how.${k}`)}</li>)}
          </ul>
        </div>
      </div>
    </Panel>
  );
}

export function ProgressPanel({ onOpen }: { onOpen: (id: number) => void }) {
  const { t } = simI18n.useT();
  const q = useQuery(myStatsQuery());
  const s = q.data;
  return (
    <Panel title={t("progress.title")} icon={Sigma} fill className="lg:col-span-5">
      {q.isError ? <ErrorState error={q.error} onRetry={q.refetch} inset /> : (
        <div className="flex flex-col gap-3">
          <StatGrid cols={2}>
            <StatCard label={t("progress.games")} value={fmtCount(s?.totals.games ?? 0)} loading={q.isLoading} />
            <StatCard label={t("progress.totalR")} value={fmtR(s?.totals.r ?? 0)} tone={toneOf(s?.totals.r)} loading={q.isLoading} />
            <StatCard label={t("progress.winRate")} value={s?.totals.games ? fmtRate(s.totals.wins / s.totals.games) : "—"} hint={s?.totals.games ? `${t("progress.beatBh")}: ${fmtRate(s.totals.beatBh / s.totals.games)}` : undefined} loading={q.isLoading} />
            <StatCard
              label={t("progress.streak")} icon={Flame} value={fmtCount(s?.streak.current ?? 0)} loading={q.isLoading}
              hint={s ? `${t("progress.streakBest", { count: s.streak.best })} · ${t("progress.days")}: ${s.streak.days}` : undefined}
            />
          </StatGrid>
          {s?.best && (
            <button type="button" onClick={() => onOpen(s.best!.id)} className="tile flex items-center gap-3 rounded-xl p-3 text-left hover:bg-[var(--tile-hover-bg)]">
              <Trophy className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-muted-foreground">{t("progress.best")}</span>
                <span className="block truncate text-sm font-medium">{s.best.ticker} · {t(`mode.${s.best.mode}`)} · {t(`difficulty.${s.best.difficulty}`)}</span>
              </span>
              <span className={cn("text-base font-semibold tabular-nums", toneText(toneOf(s.best.r)))}>{fmtR(s.best.r)}</span>
            </button>
          )}
          {s && s.own.games > 0 && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {simOwnI18n.t("progressSummary", { games: s.own.games, better: s.own.better, diff: fmtUsd(s.own.diff, { signed: true, decimals: "auto" }) })}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

export function RecentGames({ onOpen }: { onOpen: (id: number) => void }) {
  const { t } = simI18n.useT();
  const q = useQuery(myStatsQuery());
  const rows = q.data?.recent ?? [];
  return (
    <Panel title={t("progress.recent")} icon={History} fill className="lg:col-span-7">
      {q.isLoading ? <ListSkeleton rows={5} /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} inset /> : rows.length === 0 ? (
        <EmptyState compact icon={History} title={t("progress.empty")} />
      ) : (
        <DataTable ariaLabel={t("progress.recent")} maxHeight={360}>
          <table>
            <thead>
              <tr>
                <th>{t("progress.cols.when")}</th>
                <th>{t("progress.cols.ticker")}</th>
                <th>{t("progress.cols.level")}</th>
                <th className="text-right">{t("progress.cols.r")}</th>
                <th className="text-right">{t("progress.cols.net")}</th>
                <th className="text-right">{t("progress.cols.vsBh")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => <RecentRow key={g.id} g={g} onOpen={onOpen} />)}
            </tbody>
          </table>
        </DataTable>
      )}
    </Panel>
  );
}

function RecentRow({ g, onOpen }: { g: FinishedGame; onOpen: (id: number) => void }) {
  const { t } = simI18n.useT();
  const vs = g.own ? g.ownDiff ?? 0 : g.pct - g.bhPct;
  return (
    <tr className="cursor-pointer" onClick={() => onOpen(g.id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(g.id); }} tabIndex={0}>
      <td className="whitespace-nowrap text-muted-foreground">{fmtDate(g.finishedAt, "dateTime")}</td>
      <td className="font-medium">{g.ticker}</td>
      <td className="whitespace-nowrap text-muted-foreground">{g.own ? simOwnI18n.t("progressLabel") : `${t(`mode.${g.mode}`)} · ${t(`difficulty.${g.difficulty}`)}`}</td>
      <td className={cn("text-right tabular-nums", toneText(toneOf(g.r)))}>{fmtR(g.r)}</td>
      <td className={cn("text-right tabular-nums", toneText(toneOf(g.net)))}>{fmtUsd(g.net, { signed: true, decimals: "auto" })}</td>
      <td className={cn("text-right tabular-nums", toneText(toneOf(vs)))}>{g.own ? fmtUsd(vs, { signed: true, decimals: "auto" }) : fmtPct(vs, 1)}</td>
    </tr>
  );
}

export function WeeklyBoard() {
  const { t } = simI18n.useT();
  const qc = useQueryClient();
  const q = useQuery(boardQuery());
  const me = useQuery(myStatsQuery());
  const visible = me.data?.prefs.leaderboardVisible ?? false;
  const m = useMutation({
    mutationFn: (v: boolean) => simApi.prefs(v),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: simKeys.board() }); void qc.invalidateQueries({ queryKey: simKeys.me() }); },
  });
  const b = q.data;
  return (
    <Panel
      title={t("board.title")} icon={Users} fill className="lg:col-span-5"
      description={b ? t("board.subtitle", { from: fmtDate(b.from, "dayMonth"), to: fmtDate(b.to, "dayMonth") }) : undefined}
      actions={
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t("board.visible")}
          <Switch checked={m.isPending ? !!m.variables : visible} onCheckedChange={(v) => m.mutate(v)} disabled={me.isLoading || m.isPending} />
        </label>
      }
    >
      {q.isLoading ? <ListSkeleton rows={4} /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} inset /> : !b || b.rows.length === 0 ? (
        <EmptyState compact icon={Users} title={t("board.empty")} />
      ) : (
        <>
          <DataTable ariaLabel={t("board.title")} maxHeight={360}>
            <table>
              <thead>
                <tr>
                  <th className="w-10">{t("board.cols.rank")}</th>
                  <th>{t("board.cols.name")}</th>
                  <th className="text-right">{t("board.cols.games")}</th>
                  <th className="text-right">{t("board.cols.r")}</th>
                  <th className="text-right">{t("board.cols.wins")}</th>
                  <th className="text-right">{t("board.cols.best")}</th>
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, i) => (
                  <tr key={r.userId} className={cn(r.me && "bg-primary/[0.07]")}>
                    <td className="tabular-nums text-muted-foreground">{i + 1}</td>
                    <td className="max-w-[12rem] truncate font-medium" title={personName(r.name)}>{personName(r.name)}{r.me && <span className="ml-1.5 text-2xs font-normal text-muted-foreground">{t("board.you")}</span>}</td>
                    <td className="text-right tabular-nums">{fmtCount(r.games)}</td>
                    <td className={cn("text-right font-semibold tabular-nums", toneText(toneOf(r.r)))}>{fmtR(r.r)}</td>
                    <td className="text-right tabular-nums">{fmtRate(r.games ? r.wins / r.games : 0)}</td>
                    <td className={cn("text-right tabular-nums", toneText(toneOf(r.best)))}>{fmtR(r.best)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
          {b.hidden > 0 && <p className="mt-2 text-2xs text-muted-foreground">{t("board.hidden", { count: b.hidden })}</p>}
        </>
      )}
    </Panel>
  );
}
